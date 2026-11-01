import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { loginRequestSchema, registerRequestSchema } from "@siv/shared";
import { ApiError } from "../errors/api-error.js";
import { requireAuthentication } from "../middleware/require-authentication.js";
import { requireOrigin } from "../middleware/require-origin.js";
import type { AuthService, IssuedSession } from "../services/auth-service.js";

export interface AuthRouteConfig {
  webOrigin: string;
  sessionCookieName: string;
  secureCookies: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export function createAuthRoutes(authService: AuthService, config: AuthRouteConfig): Router {
  const router = Router();
  const originCheck = requireOrigin(config.webOrigin);
  const authenticate = requireAuthentication(authService, config.sessionCookieName);
  const registrationLimit = createLimiter(config.rateLimitWindowMs, config.rateLimitMax);
  const loginLimit = createLimiter(config.rateLimitWindowMs, config.rateLimitMax);

  router.post("/register", originCheck, registrationLimit, async (request, response) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "Registration details are invalid");
    }

    const session = await authService.register(parsed.data);
    response.setHeader("Cache-Control", "no-store");
    setSessionCookie(response, session, config);
    response.status(201).json({ user: session.user });
  });

  router.post("/login", originCheck, loginLimit, async (request, response) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "Email or password is invalid");
    }

    const session = await authService.login(parsed.data.email, parsed.data.password);
    response.setHeader("Cache-Control", "no-store");
    setSessionCookie(response, session, config);
    response.json({ user: session.user });
  });

  router.get("/me", authenticate, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ user: request.auth!.user });
  });

  router.post("/logout", originCheck, authenticate, async (request, response) => {
    await authService.revoke(request.auth!.token);
    clearSessionCookie(response, config);
    response.setHeader("Cache-Control", "no-store");
    response.status(204).end();
  });

  return router;
}

function createLimiter(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again later." }
  });
}

function setSessionCookie(response: import("express").Response, session: IssuedSession, config: AuthRouteConfig) {
  const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  response.append(
    "Set-Cookie",
    `${config.sessionCookieName}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.secureCookies ? "; Secure" : ""}`
  );
}

function clearSessionCookie(response: import("express").Response, config: AuthRouteConfig) {
  response.append(
    "Set-Cookie",
    `${config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? "; Secure" : ""}`
  );
}
