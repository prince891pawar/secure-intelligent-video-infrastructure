import { Queue } from "bullmq";
import { Redis } from "ioredis";
import dotenv from "dotenv";
import { resolve } from "node:path";
import pino from "pino";
import { z } from "zod";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

const env = z.object({
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
}).parse(process.env);

const logger = pino({ level: env.LOG_LEVEL });
const connection = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => attempt > 3 ? null : Math.min(attempt * 500, 5000)
});
let queue: Queue | undefined;

connection.on("error", () => {
  logger.warn("Redis connection error");
});

async function start() {
  try {
    await connection.connect();
    queue = new Queue("media-processing", { connection });
    await queue.waitUntilReady();
    logger.info("worker scaffold connected; media processors are not implemented yet");
  } catch (error) {
    logger.error({
      errorType: error instanceof Error ? error.name : "UnknownError"
    }, "worker startup failed");
    process.exitCode = 1;
    connection.disconnect();
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down worker scaffold");
  if (queue) {
    await queue.close();
  }
  await connection.quit();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void start();
