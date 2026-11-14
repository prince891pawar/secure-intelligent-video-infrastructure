import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { resolve } from "node:path";
import pino from "pino";
import { z } from "zod";
import { createVideoProcessor, reconcileQueuedVideos, recoverStaleVideos } from "./media/video-processor.js";
import { createIntelligenceProcessor, reconcileQueuedIntelligence } from "./media/intelligence-processor.js";
import { WorkerStorage } from "./storage/worker-storage.js";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

const env = z.object({
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/secure-video"),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_ROOT: z.string().min(1).default("../../.local-media"),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().positive().default(8 * 1024 ** 3),
  PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  PROCESSING_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(86_400).default(14_400),
  PROCESSING_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  PROCESSING_THREADS: z.coerce.number().int().min(1).max(16).default(2),
  PROCESSING_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(7_200_000).default(1_800_000),
  PROCESSING_RESOLUTIONS: z.string().default("1080,720,480,360,240"),
  PROCESSING_TEMP_ROOT: z.string().min(1).default("../../.processing-temp"),
  PROCESSING_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  PROCESSING_STALE_AFTER_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(28_800_000),
  AI_OPENAI_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  AI_TEXT_MODEL: z.string().min(1).max(80).default("gpt-4o-mini"),
  AI_EMBEDDING_MODEL: z.string().min(1).max(80).default("text-embedding-3-small"),
  AI_MAX_AUDIO_BYTES: z.coerce.number().int().min(1_000_000).max(25 * 1024 * 1024).default(24 * 1024 * 1024),
  AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  AI_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).superRefine((values, context) => {
  if (values.STORAGE_PROVIDER === "s3" && !values.S3_BUCKET) {
    context.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "S3_BUCKET is required in S3 storage mode" });
  }
}).parse(process.env);

const logger = pino({ level: env.LOG_LEVEL });
const redactSensitiveText = (value: string): string => {
  let redacted = value
    .replace(/((?:mongodb(?:\+srv)?|rediss?|https?):\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:password|passwd|pwd|token|access_token|secret|api_key|apikey)=)[^&\s]+/gi, "$1[REDACTED]");
  for (const secret of [env.AI_OPENAI_API_KEY].filter((value): value is string => Boolean(value))) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
};

function serializeError(error: unknown, seen = new Set<object>()): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error, message: redactSensitiveText(String(error)) };
  }
  if (seen.has(error)) {
    return { errorType: error.name, message: "[Circular cause]" };
  }
  seen.add(error);
  return {
    errorType: error.name,
    message: redactSensitiveText(error.message),
    ...(error.stack ? { stack: redactSensitiveText(error.stack) } : {}),
    ...(error.cause !== undefined ? { cause: serializeError(error.cause, seen) } : {})
  };
}

const resolutionHeights = env.PROCESSING_RESOLUTIONS.split(",").map(Number);
if (resolutionHeights.some((height) => !Number.isInteger(height) || height < 1 || height > 1080)) {
  throw new Error("PROCESSING_RESOLUTIONS must contain integer heights from 1 through 1080");
}

const connection = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => attempt > 3 ? null : Math.min(attempt * 500, 3000)
});
const mediaQueue = new Queue("media-processing", { connection });
const intelligenceQueue = new Queue("video-intelligence", { connection });
const storage = new WorkerStorage({
  provider: env.STORAGE_PROVIDER,
  localRoot: resolve(env.LOCAL_STORAGE_ROOT),
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  forcePathStyle: env.S3_FORCE_PATH_STYLE === "true"
});

let worker: Worker | undefined;
let intelligenceWorker: Worker | undefined;
let reconciliationTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

connection.on("error", (error) => {
  logger.warn({ errorType: error.name }, "Redis connection error");
});

async function start(): Promise<void> {
  try {
    await connection.ping();
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await mediaQueue.waitUntilReady();
    await intelligenceQueue.waitUntilReady();
    worker = new Worker(
      "media-processing",
      createVideoProcessor(storage, {
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        temporaryRoot: resolve(env.PROCESSING_TEMP_ROOT),
        maxDurationSeconds: env.PROCESSING_MAX_DURATION_SECONDS,
        maxOutputBytes: env.PROCESSING_MAX_OUTPUT_BYTES,
        maxUploadBytes: env.MAX_UPLOAD_SIZE_BYTES,
        threads: env.PROCESSING_THREADS,
        timeoutMs: env.PROCESSING_TIMEOUT_MS,
        resolutionHeights,
        intelligenceEnabled: Boolean(env.AI_OPENAI_API_KEY)
      }, logger),
      {
        connection,
        concurrency: env.PROCESSING_CONCURRENCY,
        lockDuration: env.PROCESSING_TIMEOUT_MS + 60_000,
        maxStalledCount: 2,
        stalledInterval: 30_000
      }
    );
    worker.on("failed", (job, error) => {
      logger.warn({
        jobId: job?.id,
        errorType: error.name,
        attemptsMade: job?.attemptsMade
      }, "processing job attempt failed");
    });
    worker.on("error", (error) => logger.error({ errorType: error.name }, "BullMQ worker error"));
    await worker.waitUntilReady();

    intelligenceWorker = new Worker(
      "video-intelligence",
      createIntelligenceProcessor(storage, {
        ffmpegPath: env.FFMPEG_PATH,
        ffprobePath: env.FFPROBE_PATH,
        temporaryRoot: resolve(env.PROCESSING_TEMP_ROOT),
        maxAudioBytes: env.AI_MAX_AUDIO_BYTES,
        timeoutMs: env.AI_TIMEOUT_MS,
        ...(env.AI_OPENAI_API_KEY ? { apiKey: env.AI_OPENAI_API_KEY } : {}),
        textModel: env.AI_TEXT_MODEL,
        embeddingModel: env.AI_EMBEDDING_MODEL
      }),
      {
        connection,
        concurrency: env.AI_PROCESSING_CONCURRENCY,
        lockDuration: env.AI_TIMEOUT_MS * 3,
        maxStalledCount: 2,
        stalledInterval: 30_000
      }
    );
    intelligenceWorker.on("failed", (job, error) => {
      logger.warn({ jobId: job?.id, errorType: error.name, attemptsMade: job?.attemptsMade }, "intelligence job attempt failed");
    });
    intelligenceWorker.on("error", (error) => logger.error({ errorType: error.name }, "intelligence worker error"));
    await intelligenceWorker.waitUntilReady();

    await reconcileProcessingQueue();
    await reconcileIntelligenceQueue();
    let reconciliationRunning = false;
    reconciliationTimer = setInterval(() => {
      if (reconciliationRunning || shuttingDown || mongoose.connection.readyState !== 1 || connection.status !== "ready") return;
      reconciliationRunning = true;
      void Promise.all([reconcileProcessingQueue(), reconcileIntelligenceQueue()])
        .catch((error: unknown) => logger.error({
          errorType: error instanceof Error ? error.name : "UnknownError"
        }, "worker queue reconciliation failed"))
        .finally(() => { reconciliationRunning = false; });
    }, env.PROCESSING_RECONCILE_INTERVAL_MS);
    reconciliationTimer.unref();
    logger.info({
      concurrency: env.PROCESSING_CONCURRENCY,
      resolutionHeights,
      redis: "ready",
      mongodb: "ready"
    }, "media processing worker ready");
  } catch (error) {
    logger.fatal({
      ...serializeError(error)
    }, "media worker startup failed");
    process.exitCode = 1;
    await shutdown("startup-failure");
  }
}

async function reconcileProcessingQueue(): Promise<void> {
  const staleJobs = await recoverStaleVideos(new Date(Date.now() - env.PROCESSING_STALE_AFTER_MS));
  for (const job of staleJobs) {
    await mediaQueue.add("transcode-video", job, {
      jobId: `${job.videoId}-${job.attempt}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000
    });
  }
  await reconcileQueuedVideos(mediaQueue);
}

async function reconcileIntelligenceQueue(): Promise<void> {
  await reconcileQueuedIntelligence(
    intelligenceQueue,
    new Date(Date.now() - env.PROCESSING_STALE_AFTER_MS)
  );
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  logger.info({ signal }, "shutting down media worker");
  const queueClose = await Promise.allSettled([worker?.close(), intelligenceWorker?.close(), mediaQueue.close(), intelligenceQueue.close()]);
  const dependencyClose = await Promise.allSettled([mongoose.disconnect(), connection.quit()]);
  for (const result of [...queueClose, ...dependencyClose]) {
    if (result.status === "rejected") {
      logger.error({
        errorType: result.reason instanceof Error ? result.reason.name : "UnknownError"
      }, "worker shutdown resource close failed");
    }
  }
  storage.destroy();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void start();
