import { resolve } from "node:path";
import mongoose from "mongoose";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import pino from "pino";
import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { MongooseAuthRepository } from "./repositories/mongoose-auth-repository.js";
import { MongooseVideoRepository } from "./repositories/mongoose-video-repository.js";
import { AuthService } from "./services/auth-service.js";
import { passwordHasher } from "./services/password-hasher.js";
import { UploadService } from "./services/upload-service.js";
import { MongooseUploadSessionRepository } from "./repositories/mongoose-upload-repository.js";
import { LocalStorageProvider } from "./storage/local-storage-provider.js";
import { S3StorageProvider } from "./storage/s3-storage-provider.js";
import { BullMqProcessingQueue } from "./services/processing-queue.js";
import { PlaybackService } from "./services/playback-service.js";
import { VideoIntelligenceService } from "./services/video-intelligence-service.js";
import { BullMqVideoIntelligenceQueue } from "./services/intelligence-queue.js";

const logger = pino({ level: config.LOG_LEVEL });
const authService = new AuthService(
  new MongooseAuthRepository(),
  passwordHasher,
  config.AUTH_SESSION_TTL_HOURS
);
const storage = config.STORAGE_PROVIDER === "s3"
  ? new S3StorageProvider({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE === "true"
  })
  : new LocalStorageProvider(resolve(config.LOCAL_STORAGE_ROOT));
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 500, 5000)
});
const mediaQueue = new Queue("media-processing", { connection: redis });
const intelligenceQueue = new Queue("video-intelligence", { connection: redis });
const processingQueue = new BullMqProcessingQueue(mediaQueue);
const videoIntelligence = new VideoIntelligenceService(
  new BullMqVideoIntelligenceQueue(intelligenceQueue),
  {
    ...(config.AI_OPENAI_API_KEY ? { apiKey: config.AI_OPENAI_API_KEY } : {}),
    textModel: config.AI_TEXT_MODEL,
    embeddingModel: config.AI_EMBEDDING_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS
  }
);
const uploadService = new UploadService(
  new MongooseUploadSessionRepository(),
  new MongooseVideoRepository(),
  storage,
  {
    maximumFileSizeBytes: config.MAX_UPLOAD_SIZE_BYTES,
    partSizeBytes: config.UPLOAD_PART_SIZE_BYTES,
    sessionTtlHours: config.UPLOAD_SESSION_TTL_HOURS
  },
  processingQueue
);
const playbackService = new PlaybackService({
  signingSecret: config.PLAYBACK_SIGNING_SECRET,
  sessionTtlMinutes: config.PLAYBACK_SESSION_TTL_MINUTES
});

redis.on("error", () => {
  logger.warn("Redis connection error");
});

const sessionCookieName = config.NODE_ENV === "production" ? "__Host-siv_session" : "siv_session";
const app = createApp({
  probes: {
    mongodb: () => mongoose.connection.readyState === 1,
    redis: () => redis.status === "ready"
  },
  logger,
  authService,
  videos: new MongooseVideoRepository(),
  uploads: uploadService,
  processingQueue,
  processingRetryStaleAfterMs: config.PROCESSING_MANUAL_RETRY_AFTER_MS,
  playback: playbackService,
  intelligence: videoIntelligence,
  storage,
  authConfig: {
    webOrigin: config.WEB_ORIGIN,
    sessionCookieName,
    secureCookies: config.NODE_ENV === "production",
    rateLimitWindowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX
  },
  uploadConfig: {
    webOrigin: config.WEB_ORIGIN,
    sessionCookieName,
    rateLimitWindowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: Math.max(config.AUTH_RATE_LIMIT_MAX, 60)
  }
});

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  logger.info({
    host: config.API_HOST,
    port: config.API_PORT,
    storageProvider: config.STORAGE_PROVIDER,
    ...(config.STORAGE_PROVIDER === "local" ? { localStorageRoot: config.LOCAL_STORAGE_ROOT } : {})
  }, "API listening");
});

async function connectDependencies() {
  const results = await Promise.allSettled([
    mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 3000 }),
    redis.connect()
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error({
        dependency: index === 0 ? "mongodb" : "redis",
        errorType: result.reason instanceof Error ? result.reason.name : "UnknownError"
      }, "dependency connection failed");
    }
  });
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down API");
  clearInterval(cleanupTimer);
  server.close(async (error) => {
    if (error) {
      logger.error("HTTP server shutdown failed");
      process.exitCode = 1;
    }

    const queueClose = await Promise.all([mediaQueue.close(), intelligenceQueue.close()]).then(
      () => true,
      (closeError: unknown) => {
        logger.error({ errorType: closeError instanceof Error ? closeError.name : "UnknownError" }, "media queue shutdown failed");
        return false;
      }
    );
    if (!queueClose) process.exitCode = 1;
    await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
    if (storage instanceof S3StorageProvider) storage.destroy();
    process.exit();
  });
}

const cleanupTimer = setInterval(() => {
  void uploadService.cleanupExpired()
    .then(() => storage.cleanupOrphanedParts(new Date(Date.now() - config.UPLOAD_SESSION_TTL_HOURS * 2 * 60 * 60 * 1000)))
    .catch((error: unknown) => {
      logger.warn({
        errorType: error instanceof Error ? error.name : "UnknownError"
      }, "upload cleanup failed");
    });
}, 15 * 60 * 1000);
cleanupTimer.unref();

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void connectDependencies();
