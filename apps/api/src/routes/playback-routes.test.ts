import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors/api-error.js";
import type { AuthRepository } from "../services/auth-service.js";
import { AuthService } from "../services/auth-service.js";
import type { PasswordHasher } from "../services/password-hasher.js";
import { decodeAssetPath, encodeAssetPath, type PlaybackService } from "../services/playback-service.js";
import { createPlaybackRoutes } from "./playback-routes.js";
import { LocalStorageProvider } from "../storage/local-storage-provider.js";

const sessionId = "6af7e1cf91febf9ea9868d04";
const credential = "valid-test-credential";
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

const authRepository: AuthRepository = {
  async findUserByEmail() { return null; },
  async createUser() { throw new Error("Not used by this test"); },
  async createSession() {},
  async findActiveSession() { return null; },
  async revokeSession() {}
};
const passwordHasher: PasswordHasher = {
  async hash() { return ""; },
  async verify() { return false; },
  async verifyUnknownUser() {}
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("playback asset routes", () => {
  it("serves rewritten HLS manifests and authorized segments with streaming MIME types", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-playback-route-"));
    temporaryDirectories.push(root);
    const masterPath = join(root, "hls", "master.m3u8");
    const variantPath = join(root, "hls", "360p", "index.m3u8");
    const segmentPath = join(root, "hls", "360p", "segment-00001.ts");
    await mkdir(join(root, "hls", "360p"), { recursive: true });
    await writeFile(masterPath, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\n360p/index.m3u8\n");
    await writeFile(variantPath, "#EXTM3U\n#EXTINF:1.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n");
    const segmentBytes = Buffer.from([0x47, 0x00, 0x01, 0x02]);
    await writeFile(segmentPath, segmentBytes);

    const assets = new Map([
      ["hls/master.m3u8", { storageKey: "hls/master.m3u8", contentType: "application/vnd.apple.mpegurl", fileSizeBytes: (await stat(masterPath)).size, manifest: true }],
      ["hls/360p/index.m3u8", { storageKey: "hls/360p/index.m3u8", contentType: "application/vnd.apple.mpegurl", fileSizeBytes: (await stat(variantPath)).size, manifest: true }],
      ["hls/360p/segment-00001.ts", { storageKey: "hls/360p/segment-00001.ts", contentType: "video/mp2t", fileSizeBytes: segmentBytes.length, manifest: false }]
    ]);
    const playback = {
      async getAuthorizedAsset(requestSessionId: string, token: string, encodedPath: string) {
        if (requestSessionId !== sessionId || token !== credential) throw new ApiError(403, "PLAYBACK_UNAUTHORIZED", "Unauthorized");
        const path = decodeAssetPath(encodedPath);
        const asset = assets.get(path);
        if (!asset) throw new ApiError(403, "PLAYBACK_UNAUTHORIZED", "Unauthorized");
        return { ...asset, relativePath: path, videoId: "video-id" };
      }
    } as unknown as PlaybackService;
    const app = express();
    app.use("/api/playback", createPlaybackRoutes(
      new AuthService(authRepository, passwordHasher, 1),
      playback,
      new LocalStorageProvider(root),
      { cookieName: "siv_session", webOrigin: "http://localhost:5173", rateLimitWindowMs: 60_000, rateLimitMax: 10 }
    ));
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(error instanceof ApiError ? error.statusCode : 500).json({ error: "Playback asset request failed" });
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const assetUrl = (path: string) =>
      `${base}/api/playback/sessions/${sessionId}/assets?path=${encodeAssetPath(path)}&token=${credential}`;

    const masterResponse = await fetch(assetUrl("hls/master.m3u8"));
    const masterText = await masterResponse.text();
    const variantUrl = masterText.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
    expect(masterResponse.status).toBe(200);
    expect(masterResponse.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    expect(variantUrl).toContain(encodeAssetPath("hls/360p/index.m3u8"));

    const variantResponse = await fetch(new URL(variantUrl!, base));
    const variantText = await variantResponse.text();
    const segmentUrl = variantText.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
    expect(variantResponse.status).toBe(200);
    expect(variantResponse.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    expect(segmentUrl).toContain(encodeAssetPath("hls/360p/segment-00001.ts"));

    const segmentResponse = await fetch(new URL(segmentUrl!, base));
    expect(segmentResponse.status).toBe(200);
    expect(segmentResponse.headers.get("content-type")).toContain("video/mp2t");
    expect(Buffer.from(await segmentResponse.arrayBuffer())).toEqual(segmentBytes);
  });
});
