import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { uploadPartNumberSchema, createUploadRequestSchema } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import { requireAuthentication } from "../middleware/require-authentication.js";
import { requireOrigin } from "../middleware/require-origin.js";
import type { AuthService } from "../services/auth-service.js";
import type { UploadService } from "../services/upload-service.js";

const confirmPartSchema = z.object({
  sizeBytes: z.number().int().positive(),
  checksumSha256: z.string()
}).strict();

const authorizePartSchema = z.object({
  checksumSha256: z.string()
}).strict();

export interface UploadRoutesConfig {
  webOrigin: string;
  sessionCookieName: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export function createUploadRoutes(
  authService: AuthService,
  uploads: Pick<UploadService, "create" | "get" | "authorizePart" | "uploadPart" | "confirmPart" | "complete" | "abort">,
  config: UploadRoutesConfig
): Router {
  const router = Router();
  const authenticate = requireAuthentication(authService, config.sessionCookieName);
  const originCheck = requireOrigin(config.webOrigin);
  const requestLimit = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many upload requests. Please try again later." }
  });

  router.use(authenticate, requestLimit);

  router.post("/", originCheck, async (request, response) => {
    const parsed = createUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_UPLOAD_REQUEST", "Upload details are invalid");
    const session = await uploads.create(request.auth!.user.id, parsed.data);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({ upload: session });
  });

  router.get("/:sessionId", async (request, response) => {
    const session = await uploads.get(request.auth!.user.id, routeParam(request.params.sessionId));
    response.setHeader("Cache-Control", "no-store");
    response.json({ upload: session });
  });

  router.get("/:sessionId/parts", async (request, response) => {
    const session = await uploads.get(request.auth!.user.id, routeParam(request.params.sessionId));
    response.setHeader("Cache-Control", "no-store");
    response.json({ parts: session.parts });
  });

  router.post("/:sessionId/parts/:partNumber/authorize", originCheck, async (request, response) => {
    const parsed = authorizePartSchema.safeParse(request.body);
    const partNumber = uploadPartNumberSchema.safeParse(request.params.partNumber);
    if (!parsed.success || !partNumber.success) {
      throw new ApiError(400, "INVALID_PART_REQUEST", "Part authorization details are invalid");
    }

    const authorization = await uploads.authorizePart(
      request.auth!.user.id,
      routeParam(request.params.sessionId),
      partNumber.data,
      parsed.data.checksumSha256
    );
    response.setHeader("Cache-Control", "no-store");
    response.json(authorization);
  });

  router.put("/:sessionId/parts/:partNumber", originCheck, async (request, response) => {
    const partNumber = uploadPartNumberSchema.safeParse(request.params.partNumber);
    if (!partNumber.success) throw new ApiError(400, "INVALID_PART_NUMBER", "Part number is invalid");
    if (request.headers["content-type"] !== "application/octet-stream") {
      throw new ApiError(415, "UNSUPPORTED_PART_CONTENT_TYPE", "Upload parts must use application/octet-stream");
    }
    if (!request.headers["content-length"] || !/^\d+$/.test(request.headers["content-length"])) {
      throw new ApiError(411, "PART_LENGTH_REQUIRED", "Upload part Content-Length is required");
    }

    const part = await uploads.uploadPart(
      request.auth!.user.id,
      routeParam(request.params.sessionId),
      partNumber.data,
      request,
      typeof request.headers["x-part-sha256"] === "string" ? request.headers["x-part-sha256"] : undefined
    );
    response.json({ part });
  });

  router.post("/:sessionId/parts/:partNumber/confirm", originCheck, async (request, response) => {
    const parsed = confirmPartSchema.safeParse(request.body);
    const partNumber = uploadPartNumberSchema.safeParse(request.params.partNumber);
    if (!parsed.success || !partNumber.success) {
      throw new ApiError(400, "INVALID_PART_REQUEST", "Part confirmation details are invalid");
    }
    const part = await uploads.confirmPart(
      request.auth!.user.id,
      routeParam(request.params.sessionId),
      partNumber.data,
      parsed.data.sizeBytes,
      parsed.data.checksumSha256
    );
    response.json({ part });
  });

  router.post("/:sessionId/complete", originCheck, async (request, response) => {
    const session = await uploads.complete(request.auth!.user.id, routeParam(request.params.sessionId));
    response.setHeader("Cache-Control", "no-store");
    response.json({ upload: session });
  });

  router.delete("/:sessionId", originCheck, async (request, response) => {
    await uploads.abort(request.auth!.user.id, routeParam(request.params.sessionId));
    response.status(204).end();
  });

  router.use(rejectUnsupportedTransferRoute);
  return router;
}

function routeParam(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_ROUTE_PARAMETER", "Route parameter is invalid");
  return value;
}

function rejectUnsupportedTransferRoute(_request: Request, _response: Response, next: NextFunction): void {
  next(new ApiError(404, "ROUTE_NOT_FOUND", "Route was not found"));
}
