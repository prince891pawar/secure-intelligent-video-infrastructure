import dotenv from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url().default("http://localhost:5173"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/secure-video"),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86_400_000).default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100).default(5),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_ROOT: z.string().min(1).default("../../.local-media"),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(8 * 1024 ** 3),
  UPLOAD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).max(5 * 1024 ** 3).default(16 * 1024 * 1024),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  PROCESSING_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(86_400).default(14_400),
  PROCESSING_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(10 * 1024 ** 3),
  PROCESSING_THREADS: z.coerce.number().int().min(1).max(16).default(2),
  PROCESSING_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(7_200_000).default(1_800_000),
  PROCESSING_RESOLUTIONS: z.string().default("1080,720,480,360,240"),
  PROCESSING_TEMP_ROOT: z.string().min(1).default("../../.processing-temp"),
  AI_OPENAI_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  AI_TEXT_MODEL: z.string().min(1).max(80).default("gpt-4o-mini"),
  AI_EMBEDDING_MODEL: z.string().min(1).max(80).default("text-embedding-3-small"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  PLAYBACK_SIGNING_SECRET: z.string().min(32).default("development-only-change-before-production-playback-secret"),
  PLAYBACK_SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).superRefine((values, context) => {
  if (values.NODE_ENV === "production" && !values.WEB_ORIGIN.startsWith("https://")) {
    context.addIssue({
      code: "custom",
      path: ["WEB_ORIGIN"],
      message: "WEB_ORIGIN must use HTTPS in production"
    });
  }
  if (values.STORAGE_PROVIDER === "s3" && !values.S3_BUCKET) {
    context.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: "S3_BUCKET is required when STORAGE_PROVIDER=s3"
    });
  }
  if (values.NODE_ENV === "production" && (
    values.PLAYBACK_SIGNING_SECRET.startsWith("development-only-")
    || values.PLAYBACK_SIGNING_SECRET.startsWith("replace-with-")
  )) {
    context.addIssue({
      code: "custom",
      path: ["PLAYBACK_SIGNING_SECRET"],
      message: "PLAYBACK_SIGNING_SECRET must be replaced with a production secret"
    });
  }
  if (values.MAX_UPLOAD_SIZE_BYTES > values.UPLOAD_PART_SIZE_BYTES * 10_000) {
    context.addIssue({
      code: "custom",
      path: ["MAX_UPLOAD_SIZE_BYTES"],
      message: "Maximum upload size exceeds the multipart part limit"
    });
  }
  const resolutions = values.PROCESSING_RESOLUTIONS.split(",").map((value) => Number(value));
  if (resolutions.length < 1 || resolutions.some((height) => !Number.isInteger(height) || height < 1 || height > 1080)) {
    context.addIssue({
      code: "custom",
      path: ["PROCESSING_RESOLUTIONS"],
      message: "PROCESSING_RESOLUTIONS must be comma-separated heights from 1 through 1080"
    });
  }
});

export const config = envSchema.parse(process.env);
