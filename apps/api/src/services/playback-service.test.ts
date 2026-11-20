import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackEvent } from "../models/playback-event.js";
import { PlaybackSession } from "../models/playback-session.js";
import { SecuritySignal } from "../models/security-signal.js";
import { Video } from "../models/video.js";
import { WatchProgress } from "../models/watch-progress.js";
import { decodeAssetPath, encodeAssetPath, PlaybackService } from "./playback-service.js";

const secret = "test-playback-signing-secret-with-32-bytes-minimum";
const userId = new mongoose.Types.ObjectId().toString();
const videoId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId().toString();

function chain(value: unknown) {
  const query = { exec: async () => value, lean: () => query, select: (_fields?: string) => query, sort: () => query };
  return query;
}

function setReadyVideo(owner = userId, sessionLimit = 2) {
  vi.spyOn(Video, "findOne").mockReturnValue(chain({
    owner: new mongoose.Types.ObjectId(owner),
    visibility: "private",
    maxConcurrentPlaybackSessions: sessionLimit,
    renditions: [{ name: "360p", width: 640, height: 360 }],
    manifests: [{ protocol: "hls", relativePath: "hls/master.m3u8" }],
    streamingAssets: [],
    subtitles: []
  }) as never);
}

afterEach(() => vi.restoreAllMocks());

describe("playback service (mocked MongoDB models)", () => {
  it("creates a signed short-lived playback session only for its owner", async () => {
    setReadyVideo();
    vi.spyOn(PlaybackSession, "updateMany").mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);
    vi.spyOn(PlaybackSession, "create").mockResolvedValue({ id: sessionId } as never);
    vi.spyOn(WatchProgress, "findOne").mockReturnValue(chain(null) as never);
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });

    const grant = await service.createSession(userId, videoId);

    expect(grant.sessionId).toBe(sessionId);
    expect(grant.manifestUrl).toContain(encodeAssetPath("hls/master.m3u8"));
    expect(grant.qualities).toEqual([{ name: "360p", width: 640, height: 360 }]);
    expect(grant.credential.split(".")).toHaveLength(2);
    expect(PlaybackSession.create).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      videoId,
      status: "active",
      slot: 1
    }));
  });

  it("denies private video playback to a different account", async () => {
    setReadyVideo(new mongoose.Types.ObjectId().toString());
    const createSession = vi.spyOn(PlaybackSession, "create");
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    await expect(service.createSession(userId, videoId)).rejects.toMatchObject({ statusCode: 404 });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("enforces the configured concurrent-session limit", async () => {
    setReadyVideo(userId, 1);
    vi.spyOn(PlaybackSession, "updateMany").mockReturnValue({ exec: async () => ({ modifiedCount: 0 }) } as never);
    vi.spyOn(PlaybackSession, "create").mockRejectedValue(Object.assign(new Error("slot occupied"), { code: 11000 }));
    vi.spyOn(PlaybackSession, "countDocuments").mockResolvedValue(1);
    vi.spyOn(SecuritySignal, "create").mockResolvedValue({} as never);
    vi.spyOn(WatchProgress, "findOne").mockReturnValue(chain(null) as never);
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    await expect(service.createSession(userId, videoId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects expired, tampered, and unsafe playback credentials before serving an asset", async () => {
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    const payload = Buffer.from(JSON.stringify({ sid: sessionId, vid: videoId, exp: 1 })).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    await expect(service.getAuthorizedAsset(sessionId, `${payload}.${signature}`, encodeAssetPath("hls/master.m3u8")))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.getAuthorizedAsset(sessionId, "not-a-valid-token", encodeAssetPath("hls/master.m3u8")))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(() => decodeAssetPath(encodeAssetPath("../private"))).toThrow();
    expect(() => decodeAssetPath("not-canonical!")).toThrow();
  });

  it("checks the live session record so revocation blocks subsequent assets", async () => {
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    const payload = Buffer.from(JSON.stringify({
      sid: sessionId,
      vid: videoId,
      exp: Math.floor(Date.now() / 1000) + 60
    })).toString("base64url");
    const credential = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    vi.spyOn(PlaybackSession, "findOne").mockReturnValue(chain(null) as never);
    await expect(service.getAuthorizedAsset(sessionId, credential, encodeAssetPath("hls/master.m3u8")))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("only resolves asset paths present in the persisted video allowlist", async () => {
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    let assetProjection = "";
    const payload = Buffer.from(JSON.stringify({
      sid: sessionId,
      vid: videoId,
      exp: Math.floor(Date.now() / 1000) + 60
    })).toString("base64url");
    const credential = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    vi.spyOn(PlaybackSession, "findOne").mockReturnValue(chain({
      userId: new mongoose.Types.ObjectId(userId)
    }) as never);
    vi.spyOn(Video, "findById").mockImplementation(() => {
      const query = chain({
        owner: new mongoose.Types.ObjectId(userId),
        visibility: "private",
        processingStatus: "completed",
        streamingStatus: "ready",
        manifests: [{
          relativePath: "hls/master.m3u8",
          storageKey: "videos/owner/video/streaming/hls/master.m3u8",
          contentType: "application/vnd.apple.mpegurl",
          fileSizeBytes: 120,
          status: "ready"
        }],
        streamingAssets: []
      });
      query.select = (fields?: string) => {
        assetProjection = fields ?? "";
        return query;
      };
      return query as never;
    });
    vi.spyOn(PlaybackSession, "updateOne").mockReturnValue({ exec: async () => ({ matchedCount: 1 }) } as never);

    await expect(service.getAuthorizedAsset(sessionId, credential, encodeAssetPath("hls/master.m3u8")))
      .resolves.toMatchObject({ contentType: "application/vnd.apple.mpegurl", manifest: true });
    expect(assetProjection).toContain("+manifests.storageKey");
    expect(assetProjection).not.toMatch(/(?:^|\s)manifests(?:\s|$)/);
    await expect(service.getAuthorizedAsset(sessionId, credential, encodeAssetPath("hls/other.m3u8")))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("deduplicates playback events using the client event ID", async () => {
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    const payload = Buffer.from(JSON.stringify({
      sid: sessionId,
      vid: videoId,
      exp: Math.floor(Date.now() / 1000) + 60
    })).toString("base64url");
    const credential = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    vi.spyOn(PlaybackSession, "findOne").mockReturnValue(chain({
      userId: new mongoose.Types.ObjectId(userId)
    }) as never);
    vi.spyOn(Video, "findById").mockReturnValue(chain({
      owner: new mongoose.Types.ObjectId(userId),
      visibility: "private",
      processingStatus: "completed",
      streamingStatus: "ready",
      durationSeconds: 100
    }) as never);
    vi.spyOn(PlaybackSession, "updateOne").mockReturnValue({ exec: async () => ({ matchedCount: 1 }) } as never);
    vi.spyOn(PlaybackEvent, "create").mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));
    vi.spyOn(PlaybackEvent, "findOne").mockReturnValue(chain(null) as never);
    const saveProgress = vi.spyOn(WatchProgress, "findOneAndUpdate");

    const result = await service.recordEvent(userId, sessionId, credential, {
      eventId: "74a2ea90-e54e-4be5-9d6d-90655b110599",
      type: "progress",
      currentTimeSeconds: 30
    });

    expect(result).toEqual({ duplicate: true });
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("validates event positions against the probed duration and updates watch progress", async () => {
    const service = new PlaybackService({ signingSecret: secret, sessionTtlMinutes: 10 });
    const payload = Buffer.from(JSON.stringify({
      sid: sessionId,
      vid: videoId,
      exp: Math.floor(Date.now() / 1000) + 60
    })).toString("base64url");
    const credential = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    vi.spyOn(PlaybackSession, "findOne").mockReturnValue(chain({
      userId: new mongoose.Types.ObjectId(userId)
    }) as never);
    vi.spyOn(Video, "findById").mockReturnValue(chain({
      owner: new mongoose.Types.ObjectId(userId),
      visibility: "private",
      processingStatus: "completed",
      streamingStatus: "ready",
      durationSeconds: 100
    }) as never);
    vi.spyOn(PlaybackSession, "updateOne").mockReturnValue({ exec: async () => ({ matchedCount: 1 }) } as never);
    const saveEvent = vi.spyOn(PlaybackEvent, "create").mockResolvedValue({} as never);
    vi.spyOn(PlaybackEvent, "findOne").mockReturnValue(chain(null) as never);
    const saveProgress = vi.spyOn(WatchProgress, "findOneAndUpdate").mockReturnValue({ exec: async () => ({}) } as never);

    await expect(service.recordEvent(userId, sessionId, credential, {
      eventId: "74a2ea90-e54e-4be5-9d6d-90655b110599",
      type: "progress",
      currentTimeSeconds: 35,
      durationSeconds: 100
    })).resolves.toEqual({ duplicate: false });
    expect(saveEvent).toHaveBeenCalled();
    expect(saveProgress).toHaveBeenCalledWith(
      { userId, videoId },
      { $set: { positionSeconds: 35, completed: false } },
      expect.any(Object)
    );
    await expect(service.recordEvent(userId, sessionId, credential, {
      eventId: "ebf69351-7fd5-49c8-87cf-ffdd4b211894",
      type: "progress",
      currentTimeSeconds: 103
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});
