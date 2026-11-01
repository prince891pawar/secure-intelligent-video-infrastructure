import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { ApiError } from "../errors/api-error.js";
import { requireAuthentication } from "../middleware/require-authentication.js";
import { requireOrigin } from "../middleware/require-origin.js";
import type { AuthService } from "../services/auth-service.js";
import { decodeAssetPath, encodeAssetPath, PlaybackService } from "../services/playback-service.js";
import type { StorageProvider } from "../storage/storage-provider.js";

const eventSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(["start", "progress", "complete", "error"]),
  currentTimeSeconds: z.number().finite().min(0).max(31_536_000),
  durationSeconds: z.number().finite().positive().max(31_536_000).optional(),
  errorCode: z.string().trim().min(1).max(80).optional()
}).strict();
const sessionLimitSchema = z.object({ maxConcurrentSessions: z.number().int().min(1).max(20) }).strict();

export interface PlaybackRoutesConfig {
  cookieName: string;
  webOrigin: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export function createPlaybackRoutes(
  authService: AuthService,
  playback: PlaybackService,
  storage: StorageProvider,
  config: PlaybackRoutesConfig
): Router {
  const router = Router();
  const requireUser = requireAuthentication(authService, config.cookieName);
  const createLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: Math.min(config.rateLimitMax, 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many playback requests. Please try again later." }
  });
  const eventLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: Math.max(300, Math.min(config.rateLimitMax * 60, 600)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many playback events. Please try again later." }
  });
  const assetLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: 1200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many playback asset requests. Please try again later." }
  });

  router.post("/videos/:videoId/sessions", requireUser, createLimit, requireOrigin(config.webOrigin), async (request, response) => {
    const videoId = routeId(request.params.videoId, "video");
    const session = await playback.createSession(request.auth!.user.id, videoId);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({ playback: session });
  });

  router.put("/videos/:videoId/playback-settings", requireUser, requireOrigin(config.webOrigin), async (request, response) => {
    const input = sessionLimitSchema.safeParse(request.body);
    if (!input.success) throw new ApiError(400, "INVALID_PLAYBACK_SETTINGS", "Playback settings are invalid");
    const videoId = routeId(request.params.videoId, "video");
    const updated = await playback.setConcurrentSessionLimit(request.auth!.user.id, videoId, input.data.maxConcurrentSessions);
    if (!updated) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    response.json({ maxConcurrentSessions: input.data.maxConcurrentSessions });
  });

  router.delete("/sessions/:sessionId", requireUser, requireOrigin(config.webOrigin), async (request, response) => {
    const sessionId = routeId(request.params.sessionId, "session");
    const revoked = await playback.revokeSession(request.auth!.user.id, sessionId);
    if (!revoked) throw new ApiError(404, "PLAYBACK_SESSION_NOT_FOUND", "Playback session was not found");
    response.status(204).end();
  });

  router.get("/sessions/:sessionId/assets", assetLimit, async (request, response) => {
    const sessionId = routeId(request.params.sessionId, "session");
    const token = queryString(request.query.token);
    const encodedPath = queryString(request.query.path);
    const asset = await playback.getAuthorizedAsset(sessionId, token, encodedPath);
    if (asset.manifest) {
      if (asset.fileSizeBytes > 2 * 1024 * 1024) throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "Streaming manifest exceeds the safe read limit");
      const object = await storage.openObject(asset.storageKey);
      if (object.contentLength !== null && object.contentLength !== asset.fileSizeBytes) {
        object.stream.destroy();
        throw new ApiError(502, "PLAYBACK_ASSET_INVALID", "Streaming manifest metadata does not match storage");
      }
      const text = await readBoundedText(object.stream, asset.fileSizeBytes);
      const rewritten = rewriteManifest(text, asset.relativePath, sessionId, token);
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.send(rewritten);
      return;
    }

    const object = await storage.openObject(asset.storageKey);
    if (object.contentLength !== null && object.contentLength !== asset.fileSizeBytes) {
      object.stream.destroy();
      throw new ApiError(502, "PLAYBACK_ASSET_INVALID", "Streaming asset metadata does not match storage");
    }
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", String(asset.fileSizeBytes));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    object.stream.once("error", () => response.destroy());
    object.stream.pipe(response);
  });

  router.post("/sessions/:sessionId/events", requireUser, eventLimit, requireOrigin(config.webOrigin), async (request, response) => {
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_PLAYBACK_EVENT", "Playback event is invalid");
    const sessionId = routeId(request.params.sessionId, "session");
    const token = queryString(request.query.token);
    const result = await playback.recordEvent(request.auth!.user.id, sessionId, token, {
      eventId: parsed.data.eventId,
      type: parsed.data.type,
      currentTimeSeconds: parsed.data.currentTimeSeconds,
      ...(parsed.data.durationSeconds === undefined ? {} : { durationSeconds: parsed.data.durationSeconds }),
      ...(parsed.data.errorCode === undefined ? {} : { errorCode: parsed.data.errorCode })
    });
    response.status(result.duplicate ? 200 : 202).json({ recorded: !result.duplicate, duplicate: result.duplicate });
  });

  router.get("/videos/:videoId/progress", requireUser, async (request, response) => {
    const videoId = routeId(request.params.videoId, "video");
    const progress = await playback.getProgress(request.auth!.user.id, videoId);
    if (!progress) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    response.setHeader("Cache-Control", "no-store");
    response.json({ progress });
  });

  router.get("/videos/:videoId/analytics", requireUser, async (request, response) => {
    const videoId = routeId(request.params.videoId, "video");
    const analytics = await playback.getAnalytics(request.auth!.user.id, videoId);
    if (!analytics) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    response.setHeader("Cache-Control", "no-store");
    response.json({ analytics });
  });

  return router;
}

function routeId(value: string | string[] | undefined, kind: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) {
    throw new ApiError(400, `INVALID_${kind.toUpperCase()}_ID`, `${kind} identifier is invalid`);
  }
  return value;
}

function queryString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new ApiError(403, "PLAYBACK_UNAUTHORIZED", "Playback authorization is invalid or expired");
  }
  return value;
}

async function readBoundedText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === "string" ? chunk : chunk);
      bytes += buffer.length;
      if (bytes > maxBytes || bytes > 2 * 1024 * 1024) {
        throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "Streaming manifest exceeded its verified size");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "PLAYBACK_ASSET_UNAVAILABLE", "Streaming manifest could not be read");
  }
  if (bytes !== maxBytes) throw new ApiError(502, "PLAYBACK_ASSET_INVALID", "Streaming manifest size did not match metadata");
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function rewriteManifest(content: string, manifestPath: string, sessionId: string, token: string): string {
  const makeUrl = (target: string) => {
    const path = resolveManifestReference(manifestPath, target);
    return `/api/playback/sessions/${sessionId}/assets?path=${encodeAssetPath(path)}&token=${encodeURIComponent(token)}`;
  };
  if (manifestPath.endsWith(".m3u8")) {
    return content.split(/\r?\n/).map((line) => {
      if (!line || line.startsWith("#")) return line;
      return makeUrl(line);
    }).join("\n");
  }
  if (manifestPath.endsWith(".mpd")) {
    if (/<BaseURL\b/i.test(content)) throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "DASH manifest contains an unsupported base URL");
    let replacedCount = 0;
    const rewritten = content.replace(/\b(media|initialization|sourceURL|href)="([^"]+)"/g, (_whole, attribute: string, uri: string) => {
      replacedCount++;
      return `${attribute}="${makeUrl(uri)}"`;
    });
    if (replacedCount === 0) throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "DASH manifest contains no protected media references");
    return rewritten;
  }
  throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "Streaming manifest type is unsupported");
}

function resolveManifestReference(manifestPath: string, uri: string): string {
  if (!uri || uri.startsWith("/") || uri.includes("\\") || uri.includes(":") || uri.includes("?") || uri.includes("#")) {
    throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "Streaming manifest contains an unsafe reference");
  }
  const segments = [...manifestPath.split("/").slice(0, -1)];
  for (const part of uri.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) throw new ApiError(502, "PLAYBACK_MANIFEST_INVALID", "Streaming manifest reference escapes its asset directory");
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const result = segments.join("/");
  decodeAssetPath(encodeAssetPath(result));
  return result;
}
