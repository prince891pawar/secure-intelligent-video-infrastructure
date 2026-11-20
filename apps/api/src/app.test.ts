import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createApp } from "./app.js";
import { AuthService, type AuthRepository, type StoredUser } from "./services/auth-service.js";
import type { PasswordHasher } from "./services/password-hasher.js";
import type { PublicUser, VideoListItem } from "@siv/shared";
import type { VideoRepository } from "./repositories/mongoose-video-repository.js";
import type { UploadService } from "./services/upload-service.js";
import type { ProcessingQueue } from "./services/processing-queue.js";

const unavailableUploadService = {
  async create() { throw new Error("Not used by this test"); },
  async get() { throw new Error("Not used by this test"); },
  async authorizePart() { throw new Error("Not used by this test"); },
  async uploadPart() { throw new Error("Not used by this test"); },
  async confirmPart() { throw new Error("Not used by this test"); },
  async complete() { throw new Error("Not used by this test"); },
  async abort() { throw new Error("Not used by this test"); }
} satisfies Pick<UploadService, "create" | "get" | "authorizePart" | "uploadPart" | "confirmPart" | "complete" | "abort">;

const servers: Array<ReturnType<ReturnType<typeof createApp>["listen"]>> = [];

const passwordHasher: PasswordHasher = {
  hash: async (password) => `test-hash:${password}`,
  verify: async (password, passwordHash) => passwordHash === `test-hash:${password}`,
  verifyUnknownUser: async () => undefined
};

class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, StoredUser>();
  readonly sessions = new Map<string, { userId: string; expiresAt: Date; revoked: boolean }>();

  async findUserByEmail(email: string) {
    return this.users.get(email) ?? null;
  }

  async createUser(input: { email: string; displayName: string; passwordHash: string }) {
    if (this.users.has(input.email)) {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    }

    const user: StoredUser = {
      id: crypto.randomUUID(),
      email: input.email,
      displayName: input.displayName,
      role: "user",
      createdAt: new Date().toISOString(),
      passwordHash: input.passwordHash
    };
    this.users.set(user.email, user);
    return user;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, { userId, expiresAt, revoked: false });
  }

  async findActiveSession(tokenHash: string, now: Date): Promise<PublicUser | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revoked || session.expiresAt <= now) return null;
    const user = [...this.users.values()].find((item) => item.id === session.userId);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt
    };
  }

  async revokeSession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    if (session) session.revoked = true;
  }
}

class MemoryVideoRepository implements VideoRepository {
  readonly items: Array<VideoListItem & { ownerId: string }> = [];
  readonly processingUpdatedAt = new Map<string, Date>();

  async createPending() {
    return crypto.randomUUID();
  }

  async markUploaded() { return 1; }

  async markUploadFailed() {}

  async delete() {}

  async getProcessingStatus(ownerId: string, videoId: string) {
    const item = this.items.find((video) => video.id === videoId && video.ownerId === ownerId);
    if (!item) return null;
    return {
      videoId,
      processingStatus: item.processingStatus,
      streamingStatus: item.streamingStatus,
      processingAttempt: 0,
      renditions: []
    };
  }

  async getQueuedAttempt() { return null; }

  async retryProcessing(ownerId: string, videoId: string, staleBefore: Date) {
    const item = this.items.find((video) => video.id === videoId && video.ownerId === ownerId);
    if (!item) return null;
    if (item.processingStatus === "queued") return 1;
    const stale = ["probing", "transcoding", "packaging"].includes(item.processingStatus)
      && (this.processingUpdatedAt.get(videoId)?.getTime() ?? Infinity) <= staleBefore.getTime();
    if (item.processingStatus !== "failed" && !stale) return -1;
    item.processingStatus = "queued";
    return 1;
  }

  async listByOwner(ownerId: string, limit: number) {
    return this.items.filter((item) => item.ownerId === ownerId).slice(0, limit).map(({ ownerId: _ownerId, ...item }) => item);
  }
}

function createTestDependencies(mongodb: boolean, redis: boolean) {
  const repository = new MemoryAuthRepository();
  const authService = new AuthService(repository, passwordHasher, 24);
  const videos = new MemoryVideoRepository();
  const processingJobs: Array<{ videoId: string; attempt: number }> = [];
  const processingQueue: ProcessingQueue = {
    async enqueue(videoId, attempt) { processingJobs.push({ videoId, attempt }); }
  };

  return {
    probes: { mongodb: () => mongodb, redis: () => redis },
    logger: pino({ level: "silent" }),
    authService,
    videos,
    uploads: unavailableUploadService,
    processingQueue,
    processingJobs,
    processingRetryStaleAfterMs: 30 * 60_000,
    authConfig: {
      webOrigin: "http://localhost:5173",
      sessionCookieName: "siv_session",
      secureCookies: false,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 20
    },
    uploadConfig: {
      webOrigin: "http://localhost:5173",
      sessionCookieName: "siv_session",
      rateLimitWindowMs: 60_000,
      rateLimitMax: 60
    }
  };
}

async function startServer(mongodb: boolean, redis: boolean) {
  const app = createApp(createTestDependencies(mongodb, redis));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

const origin = "http://localhost:5173";

async function postJson(baseUrl: string, path: string, body: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  ));
});

describe("health endpoints", () => {
  it("reports liveness and assigns a request ID", async () => {
    const baseUrl = await startServer(true, true);
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("reports readiness only when all dependencies are available", async () => {
    const baseUrl = await startServer(true, false);
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      dependencies: { mongodb: true, redis: false }
    });
  });

  it("returns ready when MongoDB and Redis probes succeed", async () => {
    const baseUrl = await startServer(true, true);
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      dependencies: { mongodb: true, redis: true }
    });
  });

  it("allows browser preflight for authenticated part uploads", async () => {
    const baseUrl = await startServer(true, false);
    const response = await fetch(`${baseUrl}/api/uploads/session-id/parts/1`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,x-part-sha256"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-part-sha256");
  });
});

describe("authentication API (in-memory repository; not MongoDB integration)", () => {
    it("registers an account and never returns its password hash", async () => {
      const baseUrl = await startServer(true, false);
      const response = await postJson(baseUrl, "/api/auth/register", {
        email: "  VIDEO@EXAMPLE.COM ",
        password: "correct horse battery staple",
        displayName: "Video Owner"
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.user).toMatchObject({
        email: "video@example.com",
        displayName: "Video Owner",
        role: "user"
      });
      expect(JSON.stringify(body)).not.toContain("passwordHash");
      expect(JSON.stringify(body)).not.toContain("test-hash");
      expect(body).not.toHaveProperty("token");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const restoredSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
      expect(restoredSession.status).toBe(200);
      expect((await restoredSession.json()).user.email).toBe("video@example.com");
    });

    it("rejects duplicate normalized email addresses", async () => {
      const baseUrl = await startServer(true, false);
      const input = {
        email: "person@example.com",
        password: "correct horse battery staple",
        displayName: "Person"
      };
      await postJson(baseUrl, "/api/auth/register", input);
      const response = await postJson(baseUrl, "/api/auth/register", {
        ...input,
        email: " PERSON@example.com "
      });

      expect(response.status).toBe(409);
    });

    it("rejects invalid registration input", async () => {
      const baseUrl = await startServer(true, false);
      const response = await postJson(baseUrl, "/api/auth/register", {
        email: "not-an-email",
        password: "short",
        displayName: ""
      });

      expect(response.status).toBe(400);
    });

    it("logs in with valid credentials and returns a safe user", async () => {
      const baseUrl = await startServer(true, false);
      await postJson(baseUrl, "/api/auth/register", {
        email: "person@example.com",
        password: "correct horse battery staple",
        displayName: "Person"
      });
      const response = await postJson(baseUrl, "/api/auth/login", {
        email: "PERSON@example.com",
        password: "correct horse battery staple"
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user.email).toBe("person@example.com");
      expect(JSON.stringify(body)).not.toContain("passwordHash");
      expect(body).not.toHaveProperty("token");
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect(cookie).toContain("siv_session=");
      const restoredSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
      expect(restoredSession.status).toBe(200);
      expect((await restoredSession.json()).user.email).toBe("person@example.com");
    });

    it("returns the same authentication error for invalid credentials", async () => {
      const baseUrl = await startServer(true, false);
      const response = await postJson(baseUrl, "/api/auth/login", {
        email: "missing@example.com",
        password: "correct horse battery staple"
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "Invalid email or password" });
    });

    it("requires authentication for the current-user endpoint", async () => {
      const baseUrl = await startServer(true, false);
      const response = await fetch(`${baseUrl}/api/auth/me`);

      expect(response.status).toBe(401);
    });

    it("returns current user, revokes session on logout, and hides private fields", async () => {
      const baseUrl = await startServer(true, false);
      const registration = await postJson(baseUrl, "/api/auth/register", {
        email: "person@example.com",
        password: "correct horse battery staple",
        displayName: "Person"
      });
      const cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
      const currentUser = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });

      expect(currentUser.status).toBe(200);
      expect(JSON.stringify(await currentUser.json())).not.toContain("passwordHash");

      const logout = await postJson(baseUrl, "/api/auth/logout", {}, cookie);
      const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
      expect(logout.status).toBe(204);
      expect(afterLogout.status).toBe(401);
    });

    it("rejects cross-origin state-changing auth requests", async () => {
      const baseUrl = await startServer(true, false);
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "person@example.com",
          password: "correct horse battery staple",
          displayName: "Person"
        })
      });

      expect(response.status).toBe(403);
    });

    it("does not require Redis for authentication and fails clearly when MongoDB is unavailable", async () => {
      const baseUrl = await startServer(false, false);
      const response = await postJson(baseUrl, "/api/auth/register", {
        email: "person@example.com",
        password: "correct horse battery staple",
        displayName: "Person"
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    });

    it("restricts video metadata listing to the authenticated owner", async () => {
      const dependencies = createTestDependencies(true, false);
      const owner = await dependencies.authService.register({
        email: "owner@example.com",
        password: "correct horse battery staple",
        displayName: "Owner"
      });
      const otherOwner = await dependencies.authService.register({
        email: "other@example.com",
        password: "correct horse battery staple",
        displayName: "Other"
      });
      const video = (id: string, ownerId: string): VideoListItem & { ownerId: string } => ({
        id,
        ownerId,
        title: id,
        uploadStatus: "awaiting_upload",
        processingStatus: "not_started",
        streamingStatus: "not_started",
        maxConcurrentPlaybackSessions: 2,
        visibility: "private",
        createdAt: new Date().toISOString()
      });
      dependencies.videos.items.push(video("mine", owner.user.id), video("theirs", otherOwner.user.id));
      const app = createApp(dependencies);
      const server = app.listen(0);
      servers.push(server);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const unauthorized = await fetch(`${baseUrl}/api/videos`);
      const response = await fetch(`${baseUrl}/api/videos`, {
        headers: { Cookie: `siv_session=${owner.token}` }
      });
      const ownerIsolated = await fetch(`${baseUrl}/api/videos/theirs/processing`, {
        headers: { Cookie: `siv_session=${owner.token}` }
      });
      const body = await response.json();

      expect(unauthorized.status).toBe(401);
      expect(response.status).toBe(200);
      expect(body.videos.map((item: VideoListItem) => item.id)).toEqual(["mine"]);
    expect(ownerIsolated.status).toBe(404);
  });

  it("allows an owner to view and retry a failed processing job", async () => {
    const dependencies = createTestDependencies(true, false);
    const owner = await dependencies.authService.register({
      email: "retry-owner@example.com",
      password: "correct horse battery staple",
      displayName: "Retry owner"
    });
    dependencies.videos.items.push({
      id: "retry-me",
      ownerId: owner.user.id,
      title: "Retry me",
      uploadStatus: "uploaded",
      processingStatus: "failed",
      streamingStatus: "failed",
      maxConcurrentPlaybackSessions: 2,
      visibility: "private",
      createdAt: new Date().toISOString()
    });
    const app = createApp(dependencies);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const status = await fetch(`${baseUrl}/api/videos/retry-me/processing`, {
      headers: { Cookie: `siv_session=${owner.token}` }
    });
    const retry = await postJson(baseUrl, "/api/videos/retry-me/retry", {}, `siv_session=${owner.token}`);

    expect(status.status).toBe(200);
    expect((await status.json()).processing.processingStatus).toBe("failed");
    expect(retry.status).toBe(202);
    expect((await retry.json()).processing.processingStatus).toBe("queued");
    expect(dependencies.processingJobs).toEqual([{ videoId: "retry-me", attempt: 1 }]);
  });

  it("allows the owner to safely requeue a stale packaging attempt", async () => {
    const dependencies = createTestDependencies(true, false);
    const owner = await dependencies.authService.register({
      email: "stale-owner@example.com",
      password: "correct horse battery staple",
      displayName: "Stale owner"
    });
    dependencies.videos.items.push({
      id: "stale-packaging",
      ownerId: owner.user.id,
      title: "Stale packaging",
      uploadStatus: "uploaded",
      processingStatus: "packaging",
      streamingStatus: "packaging",
      maxConcurrentPlaybackSessions: 2,
      visibility: "private",
      createdAt: new Date().toISOString()
    });
    dependencies.videos.processingUpdatedAt.set("stale-packaging", new Date(Date.now() - 45 * 60_000));
    const app = createApp(dependencies);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const retry = await postJson(baseUrl, "/api/videos/stale-packaging/retry", {}, `siv_session=${owner.token}`);

    expect(retry.status).toBe(202);
    expect((await retry.json()).processing.processingStatus).toBe("queued");
    expect(dependencies.processingJobs).toEqual([{ videoId: "stale-packaging", attempt: 1 }]);
  });
});
