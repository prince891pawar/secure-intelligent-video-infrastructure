import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UploadedPart } from "@siv/shared";
import type { CompletedObject, MultipartUpload, StorageProvider } from "./storage-provider.js";
import { isSafeStorageKey } from "./storage-provider.js";

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;
  private readonly multipartRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.multipartRoot = join(this.root, ".multipart");
  }

  async createMultipart(key: string, _contentType: string): Promise<MultipartUpload> {
    this.assertKey(key);
    const uploadId = randomUUID();
    await mkdir(this.uploadDirectory(uploadId), { recursive: true });
    return { uploadId, transferMode: "proxy" };
  }

  async createPartUrl(): Promise<null> {
    return null;
  }

  async uploadPart(
    uploadId: string,
    key: string,
    partNumber: number,
    body: Readable,
    expectedSize: number,
    expectedChecksum?: string
  ): Promise<UploadedPart> {
    this.assertKey(key);
    const directory = this.uploadDirectory(uploadId);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `${partNumber}.${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > expectedSize) {
          callback(new Error("Part exceeds its expected size"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    try {
      await pipeline(body, meter, createWriteStream(temporaryPath, { flags: "wx" }));
      if (sizeBytes !== expectedSize) {
        throw new Error("Part size does not match the expected size");
      }
      const checksumSha256 = hash.digest("base64");
      if (expectedChecksum && expectedChecksum !== checksumSha256) {
        throw new Error("Part checksum does not match");
      }

      const partPath = join(directory, `${partNumber}.part`);
      await rm(partPath, { force: true });
      await rename(temporaryPath, partPath);
      return {
        partNumber,
        sizeBytes,
        etag: `"${checksumSha256}"`,
        checksumSha256
      };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async confirmPart(): Promise<UploadedPart> {
    throw new Error("Local storage uploads parts through the authenticated API");
  }

  async listParts(uploadId: string, _key: string): Promise<UploadedPart[]> {
    const directory = this.uploadDirectory(uploadId);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const parts: UploadedPart[] = [];
    for (const file of files) {
      const match = /^([1-9]\d*)\.part$/.exec(file);
      if (!match) continue;
      const partNumber = Number(match[1]);
      const path = join(directory, file);
      const hash = createHash("sha256");
      await pipeline(createReadStream(path), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        }
      }), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
      const sizeBytes = (await stat(path)).size;
      const checksumSha256 = hash.digest("base64");
      parts.push({ partNumber, sizeBytes, etag: `"${checksumSha256}"`, checksumSha256 });
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipart(
    uploadId: string,
    key: string,
    parts: UploadedPart[],
    expectedSize: number
  ): Promise<CompletedObject> {
    this.assertKey(key);
    const actualParts = await this.listParts(uploadId, key);
    if (!sameParts(actualParts, parts)) {
      throw new Error("Uploaded parts do not match completion metadata");
    }

    const objectPath = this.objectPath(key);
    await mkdir(dirname(objectPath), { recursive: true });
    const temporaryObject = `${objectPath}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      async function* readParts(provider: LocalStorageProvider) {
        for (const part of actualParts) {
          for await (const chunk of createReadStream(join(provider.uploadDirectory(uploadId), `${part.partNumber}.part`))) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            sizeBytes += buffer.length;
            hash.update(buffer);
            yield buffer;
          }
        }
      }

      await pipeline(Readable.from(readParts(this)), createWriteStream(temporaryObject, { flags: "wx" }));
      if (sizeBytes !== expectedSize) {
        throw new Error("Completed object size does not match");
      }
      await rename(temporaryObject, objectPath);
      await rm(this.uploadDirectory(uploadId), { recursive: true, force: true });
      return { sizeBytes, checksumSha256: hash.digest("base64") };
    } catch (error) {
      await rm(temporaryObject, { force: true });
      throw error;
    }
  }

  async abortMultipart(uploadId: string, _key: string): Promise<void> {
    await rm(this.uploadDirectory(uploadId), { recursive: true, force: true });
  }

  async readHeader(key: string, length: number): Promise<Buffer> {
    this.assertKey(key);
    const handle = await open(this.objectPath(key), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.assertKey(key);
    await rm(this.objectPath(key), { force: true });
  }

  async downloadObject(key: string, destinationPath: string): Promise<void> {
    this.assertKey(key);
    await pipeline(createReadStream(this.objectPath(key)), createWriteStream(destinationPath, { flags: "wx" }));
  }

  async openObject(key: string): Promise<{ stream: Readable; contentLength: number }> {
    this.assertKey(key);
    const path = this.objectPath(key);
    return { stream: createReadStream(path), contentLength: (await stat(path)).size };
  }

  async uploadFile(key: string, sourcePath: string, _contentType: string): Promise<void> {
    this.assertKey(key);
    const objectPath = this.objectPath(key);
    await mkdir(dirname(objectPath), { recursive: true });
    const temporaryObject = `${objectPath}.${randomUUID()}.tmp`;
    try {
      await pipeline(createReadStream(sourcePath), createWriteStream(temporaryObject, { flags: "wx" }));
      await rm(objectPath, { force: true });
      await rename(temporaryObject, objectPath);
    } catch (error) {
      await rm(temporaryObject, { force: true });
      throw error;
    }
  }

  async cleanupOrphanedParts(olderThan: Date): Promise<number> {
    await mkdir(this.multipartRoot, { recursive: true });
    const directories = await readdir(this.multipartRoot, { withFileTypes: true });
    let removed = 0;
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const path = join(this.multipartRoot, directory.name);
      const details = await stat(path);
      if (details.mtime < olderThan) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  private uploadDirectory(uploadId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      throw new Error("Invalid local multipart upload identifier");
    }
    return join(this.multipartRoot, uploadId);
  }

  private objectPath(key: string): string {
    const path = resolve(this.root, ...key.split("/"));
    const rel = relative(this.root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Storage key resolves outside the storage root");
    }
    return path;
  }

  private assertKey(key: string): void {
    if (!isSafeStorageKey(key)) {
      throw new Error("Unsafe storage key");
    }
  }
}

function sameParts(left: UploadedPart[], right: UploadedPart[]): boolean {
  return left.length === right.length && left.every((part, index) => {
    const other = right[index];
    return other !== undefined
      && part.partNumber === other.partNumber
      && part.sizeBytes === other.sizeBytes
      && part.etag === other.etag
      && part.checksumSha256 === other.checksumSha256;
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
