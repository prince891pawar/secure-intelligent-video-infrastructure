import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { UploadedPart } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import type { VideoRepository } from "../repositories/mongoose-video-repository.js";
import type { ProcessingQueue } from "./processing-queue.js";
import { LocalStorageProvider } from "../storage/local-storage-provider.js";
import type { StorageProvider } from "../storage/storage-provider.js";
import {
  UploadService,
  type UploadSessionRecord,
  type UploadSessionRepository
} from "./upload-service.js";

const temporaryDirectories: string[] = [];
const ownerA = "owner-a";
const ownerB = "owner-b";
const partSizeBytes = 5 * 1024 * 1024;
const validMp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 16]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 0, 0])
]);

class MemorySessions implements UploadSessionRepository {
  readonly sessions = new Map<string, UploadSessionRecord>();

  async create(record: Omit<UploadSessionRecord, "id" | "parts">) {
    const session: UploadSessionRecord = {
      ...record,
      id: crypto.randomUUID(),
      parts: []
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findOwned(id: string, ownerId: string) {
    const session = this.sessions.get(id);
    return session?.ownerId === ownerId ? session : null;
  }

  async setParts(id: string, parts: UploadedPart[]) {
    const session = this.sessions.get(id);
    if (session) session.parts = parts;
  }

  async setStatus(id: string, status: UploadSessionRecord["status"]) {
    const session = this.sessions.get(id);
    if (session) session.status = status;
  }

  async delete(id: string) {
    this.sessions.delete(id);
  }

  async findExpired(now: Date, limit: number) {
    return [...this.sessions.values()]
      .filter((session) => session.expiresAt <= now && ["uploading", "completing", "failed"].includes(session.status))
      .slice(0, limit);
  }
}

class MemoryVideos implements VideoRepository {
  readonly videos = new Map<string, {
    ownerId: string;
    storageKey?: string;
    size?: number;
    failed: boolean;
    processingStatus: "not_started" | "queued" | "failed";
    processingAttempt: number;
  }>();

  async createPending(ownerId: string) {
    const id = crypto.randomUUID();
    this.videos.set(id, { ownerId, failed: false, processingStatus: "not_started", processingAttempt: 0 });
    return id;
  }

  async markUploaded(id: string, storageKey: string, size: number) {
    const video = this.videos.get(id)!;
    video.storageKey = storageKey;
    video.size = size;
    if (video.processingStatus === "not_started") {
      video.processingStatus = "queued";
      video.processingAttempt = 1;
    }
    return video.processingAttempt;
  }

  async markUploadFailed(id: string) {
    const video = this.videos.get(id);
    if (video) video.failed = true;
  }

  async delete(id: string) {
    this.videos.delete(id);
  }

  async listByOwner() {
    return [];
  }

  async getProcessingStatus(ownerId: string, videoId: string) {
    const video = this.videos.get(videoId);
    if (!video || video.ownerId !== ownerId) return null;
    return {
      videoId,
      processingStatus: video.processingStatus === "not_started" ? "not_started" as const : video.processingStatus,
      streamingStatus: "not_started" as const,
      maxConcurrentPlaybackSessions: 2,
      processingAttempt: video.processingAttempt,
      renditions: []
    };
  }

  async getQueuedAttempt(videoId: string) {
    const video = this.videos.get(videoId);
    return video?.processingStatus === "queued" ? video.processingAttempt : null;
  }

  async retryProcessing(ownerId: string, videoId: string, _staleBefore: Date) {
    const video = this.videos.get(videoId);
    if (!video || video.ownerId !== ownerId) return null;
    if (video.processingStatus === "queued") return video.processingAttempt;
    if (video.processingStatus !== "failed") return -1;
    video.processingStatus = "queued";
    video.processingAttempt++;
    return video.processingAttempt;
  }
}

class MemoryProcessingQueue implements ProcessingQueue {
  readonly jobs: Array<{ videoId: string; attempt: number }> = [];
  unavailable = false;
  async enqueue(videoId: string, attempt: number) {
    if (this.unavailable) throw new Error("Redis unavailable");
    if (!this.jobs.some((job) => job.videoId === videoId && job.attempt === attempt)) {
      this.jobs.push({ videoId, attempt });
    }
  }
}

async function createHarness(options: {
  maximumFileSizeBytes?: number;
  partSizeBytes?: number;
  storage?: StorageProvider;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "siv-upload-test-"));
  temporaryDirectories.push(root);
  const sessions = new MemorySessions();
  const videos = new MemoryVideos();
  const queue = new MemoryProcessingQueue();
  const storage = options.storage ?? new LocalStorageProvider(root);
  const config = {
    maximumFileSizeBytes: options.maximumFileSizeBytes ?? 20 * 1024 * 1024,
    partSizeBytes: options.partSizeBytes ?? partSizeBytes,
    sessionTtlHours: 24
  };
  return {
    root,
    sessions,
    videos,
    queue,
    storage,
    config,
    service: new UploadService(sessions, videos, storage, config, queue)
  };
}

async function createMp4(service: UploadService, ownerId = ownerA, bytes = validMp4) {
  return service.create(ownerId, {
    fileName: "..\\private\\clip.mp4",
    contentType: "video/mp4",
    fileSizeBytes: bytes.length,
    title: "Test clip"
  });
}

function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resumable upload service (memory metadata repository + local filesystem adapter)", () => {
  it("creates a server-owned session and returns authoritative status", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    const status = await harness.service.get(ownerA, session.id);

    expect(session.status).toBe("uploading");
    expect(session.transferMode).toBe("proxy");
    expect(session.fileName).toBe("clip.mp4");
    expect(status.parts).toEqual([]);
    expect(status.videoId).toBe(session.videoId);
  });

  it("rejects oversized file metadata and invalid part numbers", async () => {
    const harness = await createHarness({ maximumFileSizeBytes: 10 });
    await expect(createMp4(harness.service)).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });

    const normal = await createHarness();
    const session = await createMp4(normal.service);
    await expect(normal.service.authorizePart(ownerA, session.id, 0, checksum(validMp4)))
      .rejects.toMatchObject({ code: "INVALID_PART_NUMBER" });
    await expect(normal.service.authorizePart(ownerA, session.id, 2, checksum(validMp4)))
      .rejects.toMatchObject({ code: "INVALID_PART_NUMBER" });
  });

  it("enforces upload ownership and does not reveal another owner's session", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);

    await expect(harness.service.get(ownerB, session.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(harness.service.abort(ownerB, session.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("retries checksum failures and treats an identical part request idempotently", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    const digest = checksum(validMp4);

    await expect(harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), Buffer.alloc(32, 1).toString("base64")))
      .rejects.toMatchObject({ code: "INVALID_PART" });

    const part = await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), digest);
    const repeated = await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(Buffer.from("ignored")), digest);

    expect(part).toEqual(repeated);
    expect((await harness.service.get(ownerA, session.id)).parts).toHaveLength(1);
  });

  it("recovers uploaded parts from persistent storage after service reconstruction", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), checksum(validMp4));
    const restartedService = new UploadService(harness.sessions, harness.videos, harness.storage, harness.config, harness.queue);
    const recovered = await restartedService.get(ownerA, session.id);

    expect(recovered.parts.map((part) => part.partNumber)).toEqual([1]);
  });

  it("rejects missing parts, persists a processing outbox job and deduplicates completion enqueue", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    await harness.sessions.setParts(session.id, []);
    await expect(harness.service.complete(ownerA, session.id)).rejects.toMatchObject({ code: "UPLOAD_PARTS_MISSING" });

    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), checksum(validMp4));
    const completed = await harness.service.complete(ownerA, session.id);
    const video = harness.videos.videos.get(session.videoId);
    expect(completed.status).toBe("completed");
    expect(video?.storageKey).toBe(`videos/${ownerA}/${session.videoId}/original`);
    expect(video?.size).toBe(validMp4.length);
    expect(video?.failed).toBe(false);
    expect(video?.processingStatus).toBe("queued");
    expect(harness.queue.jobs).toEqual([{ videoId: session.videoId, attempt: 1 }]);
    await harness.service.complete(ownerA, session.id);
    expect(harness.queue.jobs).toHaveLength(1);
  });

  it("recovers a queued outbox job when Redis enqueue fails after upload finalization", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), checksum(validMp4));
    harness.queue.unavailable = true;

    await expect(harness.service.complete(ownerA, session.id)).rejects.toThrow("Redis unavailable");
    expect(harness.sessions.sessions.get(session.id)?.status).toBe("completed");
    expect(harness.videos.videos.get(session.videoId)?.processingStatus).toBe("queued");

    harness.queue.unavailable = false;
    await harness.service.complete(ownerA, session.id);
    expect(harness.queue.jobs).toEqual([{ videoId: session.videoId, attempt: 1 }]);
    expect((await stat(join(harness.root, "videos", ownerA, session.videoId, "original"))).size).toBe(validMp4.length);
  });

  it("rejects files whose bytes do not match the declared format", async () => {
    const harness = await createHarness();
    const bytes = Buffer.from("this is not a video");
    const session = await harness.service.create(ownerA, {
      fileName: "clip.mp4",
      contentType: "video/mp4",
      fileSizeBytes: bytes.length,
      title: "Invalid"
    });
    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(bytes), checksum(bytes));
    await expect(harness.service.complete(ownerA, session.id)).rejects.toMatchObject({ code: "INVALID_MEDIA_FORMAT" });
    expect(harness.videos.videos.get(session.videoId)?.failed).toBe(true);
  });

  it("aborts and cleans partial files idempotently", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), checksum(validMp4));
    await harness.service.abort(ownerA, session.id);
    await harness.service.abort(ownerA, session.id);

    const record = harness.sessions.sessions.get(session.id)!;
    expect(await harness.storage.listParts(record.storageUploadId, record.storageKey)).toEqual([]);
    await expect(harness.service.get(ownerA, session.id)).rejects.toBeInstanceOf(ApiError);
    expect(harness.videos.videos.get(session.videoId)?.failed).toBe(true);
  });

  it("maps storage adapter failures without leaking provider details", async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), "siv-upload-failure-"));
    temporaryDirectories.push(baseRoot);
    class FailingStorage extends LocalStorageProvider {
      override async uploadPart(): Promise<UploadedPart> {
        throw new Error("private provider endpoint or secret");
      }
    }

    const sessions = new MemorySessions();
    const videos = new MemoryVideos();
    const service = new UploadService(
      sessions,
      videos,
      new FailingStorage(baseRoot),
      { maximumFileSizeBytes: 10_000_000, partSizeBytes, sessionTtlHours: 24 },
      new MemoryProcessingQueue()
    );
    const session = await createMp4(service);

    await expect(service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4)))
      .rejects.toMatchObject({ code: "INVALID_PART", message: "Upload part failed size or checksum verification" });
  });

  it("removes expired incomplete sessions and marks their videos failed", async () => {
    const harness = await createHarness();
    const session = await createMp4(harness.service);
    await harness.service.uploadPart(ownerA, session.id, 1, Readable.from(validMp4), checksum(validMp4));
    const record = harness.sessions.sessions.get(session.id)!;
    record.expiresAt = new Date(Date.now() - 1000);

    expect(await harness.service.cleanupExpired()).toBe(1);
    expect(record.status).toBe("expired");
    expect(harness.videos.videos.get(session.videoId)?.failed).toBe(true);
  });
});
