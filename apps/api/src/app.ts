import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import type { ReadinessResponse } from "@siv/shared";

export interface ReadinessProbes {
  mongodb: () => boolean;
  redis: () => boolean;
}

export function createApp(probes: ReadinessProbes, logger: Logger, webOrigin: string) {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: webOrigin, methods: ["GET"] }));
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

  app.use(((error: unknown, _request, response, _next) => {
    logger.error({
      requestId: response.getHeader("x-request-id"),
      errorType: error instanceof Error ? error.name : "UnknownError"
    }, "unhandled request error");
    response.status(500).json({ error: "Internal server error" });
  }) satisfies ErrorRequestHandler);

  return app;
}
