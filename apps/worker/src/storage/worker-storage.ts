import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { MediaAssetStorage } from "@siv/shared";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface WorkerStorageConfig {
  provider: "local" | "s3";
  localRoot: string;
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export class WorkerStorage implements MediaAssetStorage {
  private readonly root: string;
  private readonly client: S3Client | null;

  constructor(private readonly config: WorkerStorageConfig) {
    this.root = resolve(config.localRoot);
    this.client = config.provider === "s3"
      ? new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        forcePathStyle: config.forcePathStyle
      })
      : null;
    if (config.provider === "s3" && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
      throw new Error("S3 bucket name is invalid");
    }
  }

  async downloadObject(key: string, destinationPath: string): Promise<void> {
    if (this.client) {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.assertKey(key) }));
      if (!object.Body) throw new Error("Source media object is empty");
      await pipeline(object.Body as Readable, createWriteStream(destinationPath, { flags: "wx" }));
      return;
    }
    await pipeline(createReadStream(this.localPath(key)), createWriteStream(destinationPath, { flags: "wx" }));
  }

  async uploadFile(key: string, sourcePath: string, contentType: string): Promise<void> {
    if (this.client) {
      await new Upload({
        client: this.client,
        params: {
          Bucket: this.config.bucket,
          Key: this.assertKey(key),
          Body: createReadStream(sourcePath),
          ContentType: contentType,
          ServerSideEncryption: "AES256"
        },
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
        leavePartsOnError: false
      }).done();
      return;
    }
    const destination = this.localPath(key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await pipeline(createReadStream(sourcePath), createWriteStream(temporary, { flags: "wx" }));
      await rm(destination, { force: true });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    if (this.client) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.assertKey(key) }));
      return;
    }
    await rm(this.localPath(key), { force: true });
  }

  destroy(): void {
    this.client?.destroy();
  }

  private localPath(key: string): string {
    const path = resolve(this.root, ...this.assertKey(key).split("/"));
    const rel = relative(this.root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Storage key resolves outside the configured root");
    }
    return path;
  }

  private assertKey(key: string): string {
    if (!key.startsWith("videos/") || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Unsafe media object key");
    }
    return key;
  }
}
