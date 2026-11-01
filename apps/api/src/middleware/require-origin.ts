import type { RequestHandler } from "express";
import { ApiError } from "../errors/api-error.js";

export function requireOrigin(webOrigin: string): RequestHandler {
  return (request, _response, next) => {
    if (request.get("origin") !== webOrigin) {
      next(new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed"));
      return;
    }

    next();
  };
}
