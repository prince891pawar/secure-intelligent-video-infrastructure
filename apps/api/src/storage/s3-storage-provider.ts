import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UploadedPart } from "@siv/shared";
import type { CompletedObject, MultipartUpload, StorageProvider } from "./storage-provider.js";
import { isSafeStorageKey } from "./storage-provider.js";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
      throw new Error("S3 bucket name is invalid");
    }

    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle
    });
  }

  async createMultipart(key: string, contentType: string): Promise<MultipartUpload> {
    this.assertKey(key);
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
      ChecksumAlgorithm: "SHA256"
    }));
    if (!result.UploadId) throw new Error("Object storage did not create a multipart upload");
    return { uploadId: result.UploadId, transferMode: "presigned" };
  }

  async createPartUrl(uploadId: string, key: string, partNumber: number, sizeBytes: number, checksumSha256: string): Promise<string> {
    this.assertKey(key);
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: sizeBytes,
        ChecksumSHA256: checksumSha256
      }),
      { expiresIn: 300 }
    );
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
    const directory = await mkdtemp(join(tmpdir(), "siv-part-"));
    const file = join(directory, "part.bin");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      await pipeline(body, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > expectedSize) {
            callback(new Error("Part exceeds its expected size"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      }), createWriteStream(file, { flags: "wx" }));
      if (sizeBytes !== expectedSize) throw new Error("Part size does not match the expected size");
      const checksumSha256 = hash.digest("base64");
      if (expectedChecksum && expectedChecksum !== checksumSha256) throw new Error("Part checksum does not match");
      const uploaded = await this.client.send(new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: createReadStream(file),
        ContentLength: sizeBytes,
        ChecksumSHA256: checksumSha256
      }));
      if (!uploaded.ETag) throw new Error("Object storage did not confirm the uploaded part");
      return {
        partNumber,
        sizeBytes,
        etag: uploaded.ETag,
        checksumSha256: uploaded.ChecksumSHA256 ?? checksumSha256
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async confirmPart(
    uploadId: string,
    key: string,
    partNumber: number,
    sizeBytes: number,
    checksumSha256: string
  ): Promise<UploadedPart> {
    const parts = await this.listParts(uploadId, key);
    const part = parts.find((item) => item.partNumber === partNumber);
    if (!part || part.sizeBytes !== sizeBytes || part.checksumSha256 !== checksumSha256) {
      throw new Error("Object storage part does not match confirmation metadata");
    }
    return part;
  }

  async listParts(uploadId: string, key: string): Promise<UploadedPart[]> {
    this.assertKey(key);
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.send(new ListPartsCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        ...(marker ? { PartNumberMarker: marker } : {})
      }));
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || !part.Size || !part.ChecksumSHA256) continue;
        parts.push({
          partNumber: part.PartNumber,
          sizeBytes: part.Size,
          etag: part.ETag,
          checksumSha256: part.ChecksumSHA256
        });
      }
      marker = result.IsTruncated ? result.NextPartNumberMarker?.toString() : undefined;
    } while (marker);
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
    if (!sameParts(actualParts, parts)) throw new Error("Uploaded parts do not match completion metadata");
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: actualParts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          ChecksumSHA256: part.checksumSha256
        }))
      }
    }));

    const head = await this.client.send(new HeadObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ChecksumMode: "ENABLED"
    }));
    if (head.ContentLength !== expectedSize) throw new Error("Completed object size does not match");
    const header = await this.readHeader(key, 16);
    const checksumSha256 = head.ChecksumSHA256 ?? createHash("sha256").update(header).digest("base64");
    return { sizeBytes: head.ContentLength, checksumSha256 };
  }

  async abortMultipart(uploadId: string, key: string): Promise<void> {
    this.assertKey(key);
    await this.client.send(new AbortMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: key,
      UploadId: uploadId
    }));
  }

  async cleanupOrphanedParts(olderThan: Date): Promise<number> {
    let removed = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const result = await this.client.send(new ListMultipartUploadsCommand({
        Bucket: this.config.bucket,
        Prefix: "videos/",
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
      }));
      for (const upload of result.Uploads ?? []) {
        if (upload.Key && upload.UploadId && upload.Initiated && upload.Initiated < olderThan) {
          await this.abortMultipart(upload.UploadId, upload.Key);
          removed++;
        }
      }
      keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
      uploadIdMarker = result.IsTruncated ? result.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return removed;
  }

  async readHeader(key: string, length: number): Promise<Buffer> {
    this.assertKey(key);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Range: `bytes=0-${length - 1}`
    }));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of result.Body as Readable) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= length) break;
    }
    return Buffer.concat(chunks, size);
  }

  async deleteObject(key: string): Promise<void> {
    this.assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async downloadObject(key: string, destinationPath: string): Promise<void> {
    this.assertKey(key);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key
    }));
    if (!result.Body) throw new Error("Object storage returned an empty media object");
    await pipeline(result.Body as Readable, createWriteStream(destinationPath, { flags: "wx" }));
  }

  async openObject(key: string): Promise<{ stream: Readable; contentLength: number | null }> {
    this.assertKey(key);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key
    }));
    if (!result.Body) throw new Error("Object storage returned an empty media object");
    return {
      stream: result.Body as Readable,
      contentLength: result.ContentLength ?? null
    };
  }

  async uploadFile(key: string, sourcePath: string, contentType: string): Promise<void> {
    this.assertKey(key);
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
        ServerSideEncryption: "AES256"
      },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false
    }).done();
  }

  destroy(): void {
    this.client.destroy();
  }

  private assertKey(key: string): void {
    if (!isSafeStorageKey(key) || !key.startsWith("videos/")) {
      throw new Error("Unsafe object storage key");
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
