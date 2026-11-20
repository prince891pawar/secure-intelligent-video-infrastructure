import { createHmac, timingSafeEqual } from "node:crypto";
import { Types } from "mongoose";
import type { PlaybackEventRecord } from "../models/playback-event.js";
import { PlaybackEvent } from "../models/playback-event.js";
import { PlaybackSession } from "../models/playback-session.js";
import { Video } from "../models/video.js";
import { WatchProgress } from "../models/watch-progress.js";
import { SecuritySignal } from "../models/security-signal.js";
import { ApiError } from "../errors/api-error.js";

interface PlaybackClaims {
  sid: string;
  vid: string;
  exp: number;
}

export interface PlaybackConfig {
  signingSecret: string;
  sessionTtlMinutes: number;
}

export interface PlaybackEventInput {
  eventId: string;
  type: PlaybackEventRecord["type"];
  currentTimeSeconds: number;
  durationSeconds?: number;
  errorCode?: string;
}

export class PlaybackService {
  constructor(private readonly config: PlaybackConfig) {
    if (Buffer.byteLength(config.signingSecret) < 32) {
      throw new Error("Playback signing secret must contain at least 32 bytes");
    }
  }

  async createSession(userId: string, videoId: string): Promise<{
    sessionId: string;
    credential: string;
    expiresAt: string;
    manifestUrl: string;
    watermarkId: string;
    progressSeconds: number;
    qualities: Array<{ name: string; width: number; height: number }>;
    subtitleLanguages: string[];
  }> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(videoId)) {
      throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    }
    const video = await Video.findOne({
      _id: videoId,
      processingStatus: "completed",
      streamingStatus: "ready"
    }).select("owner visibility maxConcurrentPlaybackSessions renditions manifests streamingAssets subtitles").lean().exec();
    if (!video || (!video.owner.equals(userId) && video.visibility !== "public")) {
      throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    }
    if (!video.manifests.some((manifest) => manifest.protocol === "hls" && manifest.relativePath === "hls/master.m3u8")) {
      throw new ApiError(409, "PLAYBACK_UNAVAILABLE", "Video has no verified HLS master playlist");
    }

    const now = new Date();
    await PlaybackSession.updateMany(
      { userId, videoId, status: "active", expiresAt: { $lte: now } },
      { $set: { status: "expired" } }
    ).exec();
    const limit = video.maxConcurrentPlaybackSessions ?? 2;
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * 60_000);
    const progress = await WatchProgress.findOne({ userId, videoId }).select("positionSeconds completed").lean().exec();
    let sessionId: string | null = null;
    for (let slot = 1; slot <= limit; slot++) {
      try {
        const session = await PlaybackSession.create({
          userId,
          videoId,
          slot,
          status: "active",
          expiresAt,
          lastActivityAt: now
        });
        sessionId = session.id;
        break;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    if (!sessionId) {
      const activeCount = await PlaybackSession.countDocuments({ userId, videoId, status: "active", expiresAt: { $gt: now } });
      await SecuritySignal.create({
        videoId,
        type: "concurrent_session_limit",
        severity: activeCount >= limit * 2 ? "high" : "medium",
        observedAt: now,
        evidence: { count: activeCount, windowSeconds: 60 }
      });
      throw new ApiError(409, "PLAYBACK_SESSION_LIMIT", "Concurrent playback session limit reached");
    }

    const credential = this.sign({ sid: sessionId, vid: videoId, exp: Math.floor(expiresAt.getTime() / 1000) });
    const assetUrl = `/api/playback/sessions/${sessionId}/assets`;
    const manifestPath = encodeAssetPath("hls/master.m3u8");
    return {
      sessionId,
      credential,
      expiresAt: expiresAt.toISOString(),
      manifestUrl: `${assetUrl}?path=${manifestPath}&token=${encodeURIComponent(credential)}`,
      watermarkId: `viewer-${sessionId.slice(-8)}`,
      progressSeconds: progress?.completed ? 0 : progress?.positionSeconds ?? 0,
      qualities: video.renditions.map(({ name, width, height }) => ({ name, width, height })),
      subtitleLanguages: (video.subtitles ?? []).map(({ language }) => language)
    };
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(sessionId)) return false;
    const result = await PlaybackSession.updateOne(
      { _id: sessionId, userId, status: "active" },
      { $set: { status: "revoked", lastActivityAt: new Date() } }
    ).exec();
    return result.matchedCount > 0;
  }

  async setConcurrentSessionLimit(userId: string, videoId: string, limit: number): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(videoId)) return false;
    const updated = await Video.updateOne(
      { _id: videoId, owner: userId },
      { $set: { maxConcurrentPlaybackSessions: limit } }
    ).exec();
    return updated.matchedCount > 0;
  }

  async getAuthorizedAsset(sessionId: string, credential: string, encodedPath: string): Promise<{
    storageKey: string;
    relativePath: string;
    contentType: string;
    fileSizeBytes: number;
    videoId: string;
    manifest: boolean;
  }> {
    const claims = this.verify(credential);
    if (!claims || claims.sid !== sessionId) throw unauthorizedPlayback();
    const session = await PlaybackSession.findOne({
      _id: sessionId,
      videoId: claims.vid,
      status: "active",
      expiresAt: { $gt: new Date() }
    }).lean().exec();
    if (!session) throw unauthorizedPlayback();
    const relativePath = decodeAssetPath(encodedPath);
    const video = await Video.findById(claims.vid)
      .select("owner visibility processingStatus streamingStatus manifests.protocol manifests.relativePath manifests.contentType manifests.fileSizeBytes +manifests.storageKey streamingAssets.relativePath streamingAssets.contentType streamingAssets.fileSizeBytes +streamingAssets.storageKey")
      .lean()
      .exec();
    if (!video || (video.owner.toString() !== session.userId.toString() && video.visibility !== "public")
      || video.processingStatus !== "completed" || video.streamingStatus !== "ready") {
      throw unauthorizedPlayback();
    }
    const manifest = video.manifests.find((item) => item.relativePath === relativePath);
    const asset = video.streamingAssets.find((item) => item.relativePath === relativePath);
    const selected = manifest ?? asset;
    if (!selected || !selected.storageKey) throw unauthorizedPlayback();
    await PlaybackSession.updateOne({ _id: sessionId, status: "active" }, { $set: { lastActivityAt: new Date() } }).exec();
    return {
      storageKey: selected.storageKey,
      relativePath,
      contentType: selected.contentType,
      fileSizeBytes: selected.fileSizeBytes,
      videoId: claims.vid,
      manifest: Boolean(manifest)
    };
  }

  async recordEvent(userId: string, sessionId: string, credential: string, input: PlaybackEventInput): Promise<{ duplicate: boolean }> {
    const claims = this.verify(credential);
    if (!claims || claims.sid !== sessionId || !Types.ObjectId.isValid(userId)) throw unauthorizedPlayback();
    const session = await PlaybackSession.findOne({
      _id: sessionId,
      userId,
      videoId: claims.vid,
      status: "active",
      expiresAt: { $gt: new Date() }
    }).lean().exec();
    if (!session) throw unauthorizedPlayback();
    const video = await Video.findById(claims.vid).select("owner visibility processingStatus streamingStatus durationSeconds").lean().exec();
    if (!video || (video.owner.toString() !== userId && video.visibility !== "public")
      || video.processingStatus !== "completed" || video.streamingStatus !== "ready"
      || input.currentTimeSeconds > (video.durationSeconds ?? 0) + 2) {
      throw unauthorizedPlayback();
    }
    if (input.durationSeconds !== undefined && video.durationSeconds !== undefined) {
      const durationTolerance = Math.max(2, video.durationSeconds * 0.01);
      if (Math.abs(input.durationSeconds - video.durationSeconds) > durationTolerance) {
        throw new ApiError(400, "INVALID_PLAYBACK_EVENT", "Playback event duration does not match the video");
      }
    }

    const previousProgress = input.type === "progress"
      ? await PlaybackEvent.findOne({
        sessionId,
        type: "progress",
        occurredAt: { $gte: new Date(Date.now() - 5_000) }
      }).sort({ occurredAt: -1 }).select("currentTimeSeconds occurredAt").lean().exec()
      : null;
    try {
      await PlaybackEvent.create({
        sessionId,
        userId,
        videoId: claims.vid,
        ...input,
        occurredAt: new Date()
      });
    } catch (error) {
      if (isDuplicateKey(error)) return { duplicate: true };
      throw error;
    }
    if (previousProgress && Math.abs(input.currentTimeSeconds - previousProgress.currentTimeSeconds) >= 60) {
      const now = new Date();
      const rapidSeekCount = await SecuritySignal.countDocuments({
        sessionId,
        type: "rapid_seek",
        observedAt: { $gte: new Date(now.getTime() - 60_000) }
      });
      await SecuritySignal.create({
        videoId: claims.vid,
        sessionId,
        type: "rapid_seek",
        severity: rapidSeekCount >= 2 ? "medium" : "low",
        observedAt: now,
        evidence: {
          count: rapidSeekCount + 1,
          windowSeconds: 60,
          currentPositionSeconds: input.currentTimeSeconds,
          previousPositionSeconds: previousProgress.currentTimeSeconds
        }
      });
    }
    await PlaybackSession.updateOne({ _id: sessionId }, { $set: { lastActivityAt: new Date() } }).exec();
    if (input.type === "progress" || input.type === "complete") {
      await WatchProgress.findOneAndUpdate(
        { userId, videoId: claims.vid },
        {
          $set: {
            positionSeconds: input.currentTimeSeconds,
            completed: input.type === "complete"
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec();
    }
    return { duplicate: false };
  }

  async getProgress(userId: string, videoId: string): Promise<{ positionSeconds: number; completed: boolean } | null> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(videoId)) return null;
    const video = await Video.findById(videoId).select("owner visibility").lean().exec();
    if (!video || (video.owner.toString() !== userId && video.visibility !== "public")) return null;
    const progress = await WatchProgress.findOne({ userId, videoId }).select("positionSeconds completed").lean().exec();
    return progress ? { positionSeconds: progress.positionSeconds, completed: progress.completed } : null;
  }

  async getAnalytics(userId: string, videoId: string): Promise<{
    views: number;
    completions: number;
    playbackErrors: number;
    activeSessions: number;
    averageSessionSeconds: number;
  } | null> {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(videoId)) return null;
    const video = await Video.exists({ _id: videoId, owner: userId });
    if (!video) return null;
    const [events, activeSessions, durations] = await Promise.all([
      PlaybackEvent.aggregate([
        { $match: { videoId: new Types.ObjectId(videoId) } },
        { $group: {
          _id: "$type",
          sessions: { $addToSet: "$sessionId" },
          count: { $sum: 1 }
        } }
      ]),
      PlaybackSession.countDocuments({ videoId, status: "active", expiresAt: { $gt: new Date() } }),
      PlaybackSession.aggregate([
        { $match: { videoId: new Types.ObjectId(videoId) } },
        { $group: { _id: null, average: { $avg: { $divide: [{ $subtract: ["$lastActivityAt", "$createdAt"] }, 1000] } } } }
      ])
    ]);
    const start = events.find((item: { _id: string }) => item._id === "start");
    const complete = events.find((item: { _id: string }) => item._id === "complete");
    const error = events.find((item: { _id: string }) => item._id === "error");
    return {
      views: start?.sessions.length ?? 0,
      completions: complete?.sessions.length ?? 0,
      playbackErrors: error?.count ?? 0,
      activeSessions,
      averageSessionSeconds: Math.max(0, Math.round(durations[0]?.average ?? 0))
    };
  }

  private sign(claims: PlaybackClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  private verify(token: string): PlaybackClaims | null {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = this.signature(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PlaybackClaims;
      if (!Types.ObjectId.isValid(claims.sid) || !Types.ObjectId.isValid(claims.vid)
        || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.config.signingSecret).update(payload).digest("base64url");
  }
}

export function encodeAssetPath(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

export function decodeAssetPath(encoded: string): string {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw unauthorizedPlayback();
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded
    || decoded.startsWith("/")
    || decoded.includes("\\")
    || decoded.split("/").some((part) => !part || part === "." || part === "..")) {
    throw unauthorizedPlayback();
  }
  return decoded;
}

function unauthorizedPlayback(): ApiError {
  return new ApiError(403, "PLAYBACK_UNAUTHORIZED", "Playback authorization is invalid or expired");
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
