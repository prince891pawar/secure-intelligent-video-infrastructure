import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { validateWebVtt } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import { requireAuthentication } from "../middleware/require-authentication.js";
import { requireOrigin } from "../middleware/require-origin.js";
import type { AuthService } from "../services/auth-service.js";
import type { VideoIntelligenceService } from "../services/video-intelligence-service.js";
import type { StorageProvider } from "../storage/storage-provider.js";

const questionSchema = z.object({
  question: z.string().trim().min(3).max(1000)
}).strict();

export function createVideoIntelligenceRoutes(
  authService: AuthService,
  intelligence: VideoIntelligenceService,
  storage: StorageProvider,
  config: { cookieName: string; webOrigin: string; rateLimitWindowMs: number; rateLimitMax: number }
): Router {
  const router = Router();
  const requireUser = requireAuthentication(authService, config.cookieName);
  const expensiveLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: Math.min(config.rateLimitMax, 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many video intelligence requests. Please try again later." }
  });
  const readLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: Math.max(100, Math.min(config.rateLimitMax * 30, 600)),
    standardHeaders: true,
    legacyHeaders: false
  });
  router.use(requireUser);

  router.get("/videos/:videoId/status", readLimit, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ intelligence: await intelligence.getStatus(request.auth!.user.id, routeId(request.params.videoId)) });
  });

  router.get("/videos/:videoId/transcript", readLimit, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ transcript: await intelligence.getTranscript(request.auth!.user.id, routeId(request.params.videoId)) });
  });

  router.get("/videos/:videoId/subtitles/:language", readLimit, async (request, response) => {
    const videoId = routeId(request.params.videoId);
    const language = routeLanguage(request.params.language);
    const asset = await intelligence.getSubtitle(request.auth!.user.id, videoId, language);
    if (asset.fileSizeBytes > 10 * 1024 * 1024) {
      throw new ApiError(502, "SUBTITLE_INVALID", "Subtitle asset exceeds the safe read limit");
    }
    const object = await storage.openObject(asset.storageKey);
    if (object.contentLength !== null && object.contentLength !== asset.fileSizeBytes) {
      object.stream.destroy();
      throw new ApiError(502, "SUBTITLE_INVALID", "Subtitle metadata does not match stored asset");
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of object.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > asset.fileSizeBytes || totalBytes > 10 * 1024 * 1024) {
        object.stream.destroy();
        throw new ApiError(502, "SUBTITLE_INVALID", "Subtitle asset exceeds its verified size");
      }
      chunks.push(buffer);
    }
    if (totalBytes !== asset.fileSizeBytes) {
      throw new ApiError(502, "SUBTITLE_INVALID", "Subtitle asset size does not match its stored metadata");
    }
    const subtitle = Buffer.concat(chunks).toString("utf8");
    try {
      validateWebVtt(subtitle);
    } catch {
      throw new ApiError(502, "SUBTITLE_INVALID", "Stored subtitle failed WebVTT validation");
    }
    response.setHeader("Content-Type", "text/vtt; charset=utf-8");
    response.setHeader("Content-Length", String(asset.fileSizeBytes));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(subtitle);
  });

  router.post("/videos/:videoId/retry", expensiveLimit, requireOrigin(config.webOrigin), async (request, response) => {
    const result = await intelligence.retry(request.auth!.user.id, routeId(request.params.videoId));
    response.setHeader("Cache-Control", "no-store");
    response.status(202).json({ transcription: result });
  });

  router.get("/search", readLimit, async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (query.length < 2 || query.length > 200) throw new ApiError(400, "INVALID_SEARCH_QUERY", "Search query must contain 2 to 200 characters");
    response.setHeader("Cache-Control", "no-store");
    response.json(await intelligence.search(request.auth!.user.id, query));
  });

  router.post("/videos/:videoId/questions", expensiveLimit, requireOrigin(config.webOrigin), async (request, response) => {
    const parsed = questionSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_QUESTION", "Question must contain 3 to 1000 characters");
    const result = await intelligence.answer(
      request.auth!.user.id,
      routeId(request.params.videoId),
      parsed.data.question
    );
    response.setHeader("Cache-Control", "no-store");
    response.json(result);
  });

  router.get("/videos/:videoId/review-signals", readLimit, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ review: await intelligence.getReviewSignals(request.auth!.user.id, routeId(request.params.videoId)) });
  });
  return router;
}

function routeId(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) {
    throw new ApiError(400, "INVALID_VIDEO_ID", "Video identifier is invalid");
  }
  return value;
}

function routeLanguage(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value)) {
    throw new ApiError(400, "INVALID_LANGUAGE", "Subtitle language is invalid");
  }
  return value;
}
