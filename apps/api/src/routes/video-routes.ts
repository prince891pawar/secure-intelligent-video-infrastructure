import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuthentication } from "../middleware/require-authentication.js";
import { requireOrigin } from "../middleware/require-origin.js";
import type { AuthService } from "../services/auth-service.js";
import type { VideoRepository } from "../repositories/mongoose-video-repository.js";
import type { ProcessingQueue } from "../services/processing-queue.js";
import { ApiError } from "../errors/api-error.js";

export function createVideoRoutes(
  authService: AuthService,
  videos: VideoRepository,
  queue: ProcessingQueue,
  cookieName: string,
  webOrigin: string,
  rateLimitWindowMs: number,
  rateLimitMax: number
): Router {
  const router = Router();
  router.use(requireAuthentication(authService, cookieName));
  const retryLimit = rateLimit({
    windowMs: rateLimitWindowMs,
    limit: Math.min(rateLimitMax, 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many processing retry requests. Please try again later." }
  });

  router.get("/", async (request, response) => {
    const items = await videos.listByOwner(request.auth!.user.id, 50);
    response.setHeader("Cache-Control", "no-store");
    response.json({ videos: items });
  });

  router.get("/:videoId/processing", async (request, response) => {
    const videoId = routeVideoId(request.params.videoId);
    const status = await videos.getProcessingStatus(request.auth!.user.id, videoId);
    if (!status) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    response.setHeader("Cache-Control", "no-store");
    response.json({ processing: status });
  });

  router.post("/:videoId/retry", retryLimit, requireOrigin(webOrigin), async (request, response) => {
    const videoId = routeVideoId(request.params.videoId);
    const attempt = await videos.retryProcessing(request.auth!.user.id, videoId);
    if (attempt === null) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    if (attempt < 0) throw new ApiError(409, "PROCESSING_NOT_RETRYABLE", "Video processing is not currently retryable");
    await queue.enqueue(videoId, attempt);
    const status = await videos.getProcessingStatus(request.auth!.user.id, videoId);
    if (!status) throw new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
    response.setHeader("Cache-Control", "no-store");
    response.status(202).json({ processing: status });
  });

  return router;
}

function routeVideoId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_VIDEO_ID", "Video identifier is invalid");
  return value;
}
