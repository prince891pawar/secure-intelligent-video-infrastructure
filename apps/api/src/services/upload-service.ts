import { basename, win32 } from "node:path";
import type { Readable } from "node:stream";
import type {
  CreateUploadRequest,
  UploadedPart,
  UploadSessionResponse
} from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import type { VideoRepository } from "../repositories/mongoose-video-repository.js";
import type { StorageProvider } from "../storage/storage-provider.js";
import type { ProcessingQueue } from "./processing-queue.js";

export type UploadStatus =
  | "initiating"
  | "uploading"
  | "completing"
  | "completed"
  | "aborted"
  | "expired"
  | "failed";

export interface UploadSessionRecord {
  id: string;
  ownerId: string;
  videoId: string;
  storageKey: string;
  storageUploadId: string;
  title: string;
  fileName: string;
  contentType: CreateUploadRequest["contentType"];
  fileSizeBytes: number;
  partSizeBytes: number;
  expectedParts: number;
  transferMode: "proxy" | "presigned";
  status: UploadStatus;
  parts: UploadedPart[];
  expiresAt: Date;
}

export interface UploadSessionRepository {
  create(record: Omit<UploadSessionRecord, "id" | "parts">): Promise<UploadSessionRecord>;
  findOwned(id: string, ownerId: string): Promise<UploadSessionRecord | null>;
  setParts(id: string, parts: UploadedPart[]): Promise<void>;
  setStatus(id: string, status: UploadStatus): Promise<void>;
  delete(id: string): Promise<void>;
  findExpired(now: Date, limit: number): Promise<UploadSessionRecord[]>;
}

export interface UploadServiceConfig {
  maximumFileSizeBytes: number;
  partSizeBytes: number;
  sessionTtlHours: number;
}

export interface PartAuthorization {
  transferMode: "proxy" | "presigned";
  uploadUrl: string | null;
}

export class UploadService {
  constructor(
    private readonly sessions: UploadSessionRepository,
    private readonly videos: VideoRepository,
    private readonly storage: StorageProvider,
    private readonly config: UploadServiceConfig,
    private readonly processingQueue: ProcessingQueue
  ) {}

  async create(ownerId: string, input: CreateUploadRequest): Promise<UploadSessionResponse> {
    if (input.fileSizeBytes > this.config.maximumFileSizeBytes) {
      throw new ApiError(413, "UPLOAD_TOO_LARGE", "File exceeds the configured upload limit");
    }

    const expectedParts = Math.ceil(input.fileSizeBytes / this.config.partSizeBytes);
    if (expectedParts < 1 || expectedParts > 10_000) {
      throw new ApiError(400, "INVALID_UPLOAD_SIZE", "File cannot be represented by the configured part size");
    }

    const fileName = safeFileName(input.fileName);
    const videoId = await this.videos.createPending(ownerId, input.title, input.description);
    const storageKey = `videos/${ownerId}/${videoId}/original`;
    let multipart: Awaited<ReturnType<StorageProvider["createMultipart"]>> | undefined;

    try {
      multipart = await this.storage.createMultipart(storageKey, input.contentType);
      const session = await this.sessions.create({
        ownerId,
        videoId,
        storageKey,
        storageUploadId: multipart.uploadId,
        title: input.title,
        fileName,
        contentType: input.contentType,
        fileSizeBytes: input.fileSizeBytes,
        partSizeBytes: this.config.partSizeBytes,
        expectedParts,
        transferMode: multipart.transferMode,
        status: "uploading",
        expiresAt: new Date(Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000)
      });
      return toResponse(session);
    } catch (error) {
      if (multipart) {
        await this.storage.abortMultipart(multipart.uploadId, storageKey).catch(() => undefined);
      }
      await this.videos.delete(videoId);
      throw error;
    }
  }

  async get(ownerId: string, sessionId: string): Promise<UploadSessionResponse> {
    const session = await this.requireOwned(ownerId, sessionId);
    await this.ensureActive(session);
    if (session.status === "completed" || session.status === "aborted") return toResponse(session);

    const parts = await this.storage.listParts(session.storageUploadId, session.storageKey);
    await this.sessions.setParts(session.id, parts);
    return toResponse({ ...session, parts });
  }

  async authorizePart(ownerId: string, sessionId: string, partNumber: number, checksumSha256: string): Promise<PartAuthorization> {
    const session = await this.requireWritable(ownerId, sessionId, partNumber);
    validateChecksum(checksumSha256);
    const uploadUrl = await this.storage.createPartUrl(
      session.storageUploadId,
      session.storageKey,
      partNumber,
      expectedPartSize(session, partNumber),
      checksumSha256
    );
    return uploadUrl
      ? { transferMode: "presigned", uploadUrl }
      : { transferMode: "proxy", uploadUrl: null };
  }

  async uploadPart(
    ownerId: string,
    sessionId: string,
    partNumber: number,
    body: Readable,
    checksumSha256?: string
  ): Promise<UploadedPart> {
    const session = await this.requireWritable(ownerId, sessionId, partNumber);
    const existing = (await this.storage.listParts(session.storageUploadId, session.storageKey))
      .find((part) => part.partNumber === partNumber);
    const expectedSize = expectedPartSize(session, partNumber);
    if (existing && existing.sizeBytes === expectedSize && (!checksumSha256 || existing.checksumSha256 === checksumSha256)) {
      return existing;
    }

    let part: UploadedPart;
    try {
      part = await this.storage.uploadPart(
        session.storageUploadId,
        session.storageKey,
        partNumber,
        body,
        expectedSize,
        checksumSha256
      );
    } catch {
      throw new ApiError(400, "INVALID_PART", "Upload part failed size or checksum verification");
    }
    const parts = await this.storage.listParts(session.storageUploadId, session.storageKey);
    await this.sessions.setParts(session.id, parts);
    return part;
  }

  async confirmPart(
    ownerId: string,
    sessionId: string,
    partNumber: number,
    sizeBytes: number,
    checksumSha256: string
  ): Promise<UploadedPart> {
    const session = await this.requireWritable(ownerId, sessionId, partNumber);
    const expectedSize = expectedPartSize(session, partNumber);
    if (sizeBytes !== expectedSize) {
      throw new ApiError(400, "INVALID_PART_SIZE", "Part size does not match the session");
    }
    validateChecksum(checksumSha256);
    let part: UploadedPart;
    try {
      part = await this.storage.confirmPart(
        session.storageUploadId,
        session.storageKey,
        partNumber,
        sizeBytes,
        checksumSha256
      );
    } catch {
      throw new ApiError(400, "PART_NOT_VERIFIED", "Object storage has not verified this part");
    }
    const parts = await this.storage.listParts(session.storageUploadId, session.storageKey);
    await this.sessions.setParts(session.id, parts);
    return part;
  }

  async complete(ownerId: string, sessionId: string): Promise<UploadSessionResponse> {
    const session = await this.requireOwned(ownerId, sessionId);
    if (session.status === "completed") {
      await this.enqueueIfQueued(session.videoId);
      return toResponse(session);
    }
    await this.ensureActive(session, true);

    const parts = await this.storage.listParts(session.storageUploadId, session.storageKey);
    await this.assertCompleteParts(session, parts);
    await this.sessions.setStatus(session.id, "completing");

    let completed: Awaited<ReturnType<StorageProvider["completeMultipart"]>>;
    let processingAttempt: number;
    try {
      completed = await this.storage.completeMultipart(
        session.storageUploadId,
        session.storageKey,
        parts,
        session.fileSizeBytes
      );
      if (completed.sizeBytes !== session.fileSizeBytes) {
        throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "Completed file size does not match the upload session");
      }
      const header = await this.storage.readHeader(session.storageKey, 16);
      if (!isSupportedMediaHeader(header, session.contentType)) {
        await this.storage.deleteObject(session.storageKey);
        await this.sessions.setStatus(session.id, "failed");
        await this.videos.markUploadFailed(session.videoId);
        throw new ApiError(400, "INVALID_MEDIA_FORMAT", "File contents do not match the declared video format");
      }

      processingAttempt = await this.videos.markUploaded(session.videoId, session.storageKey, completed.sizeBytes);
      await this.sessions.setStatus(session.id, "completed");
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "INVALID_MEDIA_FORMAT")) {
        await this.sessions.setStatus(session.id, "uploading");
      }
      throw error;
    }
    await this.enqueueIfQueued(session.videoId, processingAttempt);
    return toResponse({ ...session, parts, status: "completed" });
  }

  private async enqueueIfQueued(videoId: string, attempt?: number): Promise<void> {
    const queuedAttempt = attempt ?? await this.videos.getQueuedAttempt(videoId);
    if (queuedAttempt === null) return;
    await this.processingQueue.enqueue(videoId, queuedAttempt);
  }

  async abort(ownerId: string, sessionId: string): Promise<void> {
    const session = await this.requireOwned(ownerId, sessionId);
    if (session.status === "aborted") return;
    if (session.status === "completed") {
      throw new ApiError(409, "UPLOAD_ALREADY_COMPLETED", "Completed uploads cannot be aborted");
    }

    await this.storage.abortMultipart(session.storageUploadId, session.storageKey);
    await this.sessions.setStatus(session.id, "aborted");
    await this.videos.markUploadFailed(session.videoId);
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    const expired = await this.sessions.findExpired(now, 100);
    for (const session of expired) {
      await this.storage.abortMultipart(session.storageUploadId, session.storageKey);
      await this.sessions.setStatus(session.id, "expired");
      await this.videos.markUploadFailed(session.videoId);
    }
    return expired.length;
  }

  private async requireOwned(ownerId: string, sessionId: string): Promise<UploadSessionRecord> {
    const session = await this.sessions.findOwned(sessionId, ownerId);
    if (!session) throw new ApiError(404, "UPLOAD_NOT_FOUND", "Upload session was not found");
    return session;
  }

  private async requireWritable(ownerId: string, sessionId: string, partNumber: number): Promise<UploadSessionRecord> {
    const session = await this.requireOwned(ownerId, sessionId);
    await this.ensureActive(session);
    if (session.status !== "uploading") {
      throw new ApiError(409, "UPLOAD_NOT_WRITABLE", "Upload session is not accepting parts");
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.expectedParts) {
      throw new ApiError(400, "INVALID_PART_NUMBER", "Part number is outside this upload session");
    }
    return session;
  }

  private async ensureActive(session: UploadSessionRecord, allowCompleting = false): Promise<void> {
    if (session.expiresAt <= new Date() && session.status !== "completed") {
      await this.storage.abortMultipart(session.storageUploadId, session.storageKey);
      await this.sessions.setStatus(session.id, "expired");
      await this.videos.markUploadFailed(session.videoId);
      throw new ApiError(410, "UPLOAD_EXPIRED", "Upload session has expired");
    }
    if (session.status === "expired" || session.status === "aborted" || session.status === "failed") {
      throw new ApiError(410, "UPLOAD_UNAVAILABLE", "Upload session is no longer available");
    }
    if (session.status === "completing" && !allowCompleting) {
      throw new ApiError(409, "UPLOAD_COMPLETING", "Upload session is being completed");
    }
  }

  private async assertCompleteParts(session: UploadSessionRecord, parts: UploadedPart[]): Promise<void> {
    if (parts.length !== session.expectedParts) {
      throw new ApiError(409, "UPLOAD_PARTS_MISSING", "Upload is missing one or more parts");
    }
    for (let index = 0; index < session.expectedParts; index++) {
      const part = parts[index];
      const partNumber = index + 1;
      if (!part || part.partNumber !== partNumber || part.sizeBytes !== expectedPartSize(session, partNumber)) {
        throw new ApiError(409, "UPLOAD_PARTS_INVALID", "Uploaded parts are incomplete or have invalid sizes");
      }
    }
  }
}

function expectedPartSize(session: UploadSessionRecord, partNumber: number): number {
  return partNumber === session.expectedParts
    ? session.fileSizeBytes - session.partSizeBytes * (session.expectedParts - 1)
    : session.partSizeBytes;
}

function safeFileName(value: string): string {
  const name = basename(win32.basename(value))
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!name || name === "." || name === "..") {
    throw new ApiError(400, "INVALID_FILE_NAME", "File name is invalid");
  }
  return name.slice(0, 255);
}

function validateChecksum(checksum: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(checksum)) {
    throw new ApiError(400, "INVALID_CHECKSUM", "SHA-256 checksum must use base64 encoding");
  }
}

function isSupportedMediaHeader(header: Buffer, contentType: CreateUploadRequest["contentType"]): boolean {
  if (header.length >= 12 && header.toString("ascii", 4, 8) === "ftyp") {
    const brand = header.toString("ascii", 8, 12);
    return contentType === "video/quicktime" ? brand === "qt  " : contentType === "video/mp4";
  }
  return contentType === "video/webm"
    && header.length >= 4
    && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function toResponse(session: UploadSessionRecord): UploadSessionResponse {
  return {
    id: session.id,
    videoId: session.videoId,
    title: session.title,
    fileName: session.fileName,
    contentType: session.contentType,
    fileSizeBytes: session.fileSizeBytes,
    partSizeBytes: session.partSizeBytes,
    expectedParts: session.expectedParts,
    transferMode: session.transferMode,
    status: session.status,
    parts: session.parts,
    expiresAt: session.expiresAt.toISOString()
  };
}
