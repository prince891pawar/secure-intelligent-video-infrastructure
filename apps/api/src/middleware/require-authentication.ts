import type { RequestHandler } from "express";
import type { PublicUser } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import type { AuthService } from "../services/auth-service.js";

export interface AuthContext {
  user: PublicUser;
  token: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function requireAuthentication(authService: AuthService, cookieName: string): RequestHandler {
  return async (request, _response, next) => {
    const token = readCookie(request.headers.cookie, cookieName);
    if (!token) {
      next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
      return;
    }

    try {
      const user = await authService.getCurrentUser(token);
      if (!user) {
        next(new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required"));
        return;
      }

      request.auth = { user, token };
      next();
    } catch (error) {
      next(error);
    }
  };
}

function readCookie(header: string | undefined, cookieName: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;

    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }

  return null;
}
