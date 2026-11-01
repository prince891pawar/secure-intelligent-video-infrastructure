import type { Readable } from "node:stream";
import type { UploadedPart } from "@siv/shared";
import type { MediaAssetStorage } from "@siv/shared";

export interface MultipartUpload {
  uploadId: string;
  transferMode: "proxy" | "presigned";
}

export interface CompletedObject {
  sizeBytes: number;
  checksumSha256: string;
}

export interface StorageProvider extends MediaAssetStorage {
  openObject(key: string): Promise<{ stream: Readable; contentLength: number | null }>;
  createMultipart(key: string, contentType: string): Promise<MultipartUpload>;
  createPartUrl(uploadId: string, key: string, partNumber: number, sizeBytes: number, checksumSha256: string): Promise<string | null>;
  uploadPart(uploadId: string, key: string, partNumber: number, body: Readable, expectedSize: number, expectedChecksum?: string): Promise<UploadedPart>;
  confirmPart(uploadId: string, key: string, partNumber: number, sizeBytes: number, checksumSha256: string): Promise<UploadedPart>;
  listParts(uploadId: string, key: string): Promise<UploadedPart[]>;
  completeMultipart(uploadId: string, key: string, parts: UploadedPart[], expectedSize: number): Promise<CompletedObject>;
  abortMultipart(uploadId: string, key: string): Promise<void>;
  cleanupOrphanedParts(olderThan: Date): Promise<number>;
  readHeader(key: string, length: number): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

export function isSafeStorageKey(key: string): boolean {
  return key.length > 0
    && key.length <= 1024
    && !key.startsWith("/")
    && !key.includes("\\")
    && key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
