import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import type { ReadinessResponse } from "@siv/shared";
import { ApiError } from "./errors/api-error.js";
import { createAuthRoutes, type AuthRouteConfig } from "./routes/auth-routes.js";
import { createVideoRoutes } from "./routes/video-routes.js";
import type { AuthService } from "./services/auth-service.js";
import type { VideoRepository } from "./repositories/mongoose-video-repository.js";
import { createUploadRoutes, type UploadRoutesConfig } from "./routes/upload-routes.js";
import type { UploadService } from "./services/upload-service.js";
import type { ProcessingQueue } from "./services/processing-queue.js";
import type { PlaybackService } from "./services/playback-service.js";
import type { StorageProvider } from "./storage/storage-provider.js";
import { createPlaybackRoutes } from "./routes/playback-routes.js";
import { createVideoIntelligenceRoutes } from "./routes/video-intelligence-routes.js";
import type { VideoIntelligenceService } from "./services/video-intelligence-service.js";

export interface ReadinessProbes {
  mongodb: () => boolean;
  redis: () => boolean;
}

export interface AppDependencies {
  probes: ReadinessProbes;
  logger: Logger;
  authService: AuthService;
  videos: VideoRepository;
  uploads: Pick<UploadService, "create" | "get" | "authorizePart" | "uploadPart" | "confirmPart" | "complete" | "abort">;
  processingQueue: ProcessingQueue;
  authConfig: AuthRouteConfig;
  uploadConfig: UploadRoutesConfig;
  playback?: PlaybackService;
  storage?: StorageProvider;
  intelligence?: VideoIntelligenceService;
}

function requireMongo(probes: ReadinessProbes) {
  return (_request: express.Request, _response: express.Response, next: express.NextFunction) => {
    if (!probes.mongodb()) {
      next(new ApiError(503, "DATABASE_UNAVAILABLE", "Database is temporarily unavailable"));
      return;
    }

    next();
  };
}

export function createApp({ probes, logger, authService, videos, uploads, processingQueue, authConfig, uploadConfig, playback, storage, intelligence }: AppDependencies) {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({
    origin: authConfig.webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Part-Sha256"]
  }));
  app.use((request, response, next) => {
    const requestId = crypto.randomUUID();
    response.setHeader("x-request-id", requestId);
    const startedAt = performance.now();

    response.on("finish", () => {
      logger.info({
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt)
      }, "request completed");
    });

    next();
  });
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/ready", (_request, response) => {
    const dependencies = {
      mongodb: probes.mongodb(),
      redis: probes.redis()
    };
    const ready = Object.values(dependencies).every(Boolean);
    const payload: ReadinessResponse = {
      status: ready ? "ready" : "not_ready",
      dependencies
    };

    response.status(ready ? 200 : 503).json(payload);
  });

  app.use("/api/auth", requireMongo(probes), createAuthRoutes(authService, authConfig));
  app.use("/api/videos", requireMongo(probes), createVideoRoutes(
    authService,
    videos,
    processingQueue,
    authConfig.sessionCookieName,
    authConfig.webOrigin,
    authConfig.rateLimitWindowMs,
    authConfig.rateLimitMax
  ));
  app.use("/api/uploads", requireMongo(probes), createUploadRoutes(authService, uploads, uploadConfig));
  if (playback && storage) {
    app.use("/api/playback", requireMongo(probes), createPlaybackRoutes(authService, playback, storage, {
      cookieName: authConfig.sessionCookieName,
      webOrigin: authConfig.webOrigin,
      rateLimitWindowMs: authConfig.rateLimitWindowMs,
      rateLimitMax: authConfig.rateLimitMax
    }));
  }
  if (intelligence && storage) {
    app.use("/api/intelligence", requireMongo(probes), createVideoIntelligenceRoutes(authService, intelligence, storage, {
      cookieName: authConfig.sessionCookieName,
      webOrigin: authConfig.webOrigin,
      rateLimitWindowMs: authConfig.rateLimitWindowMs,
      rateLimitMax: authConfig.rateLimitMax
    }));
  }

  app.use(((error: unknown, _request, response, _next) => {
    logger.error({
      requestId: response.getHeader("x-request-id"),
      errorType: error instanceof Error ? error.name : "UnknownError"
    }, "unhandled request error");
    if (error instanceof ApiError) {
      response.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must be valid JSON", code: "INVALID_JSON" });
      return;
    }

    if (isRequestSizeError(error)) {
      response.status(413).json({ error: "Request body is too large", code: "REQUEST_TOO_LARGE" });
      return;
    }

    response.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  }) satisfies ErrorRequestHandler);

  return app;
}

function isRequestSizeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 413;
}
