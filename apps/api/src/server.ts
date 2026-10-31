import mongoose from "mongoose";
import { Redis } from "ioredis";
import pino from "pino";
import { createApp } from "./app.js";
import { config } from "./config/env.js";

const logger = pino({ level: config.LOG_LEVEL });
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 500, 5000)
});

redis.on("error", () => {
  logger.warn("Redis connection error");
});

const app = createApp(
  {
    mongodb: () => mongoose.connection.readyState === 1,
    redis: () => redis.status === "ready"
  },
  logger,
  config.WEB_ORIGIN
);

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  logger.info({ host: config.API_HOST, port: config.API_PORT }, "API listening");
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
  server.close(async (error) => {
    if (error) {
      logger.error("HTTP server shutdown failed");
      process.exitCode = 1;
    }

    await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
    process.exit();
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void connectDependencies();
