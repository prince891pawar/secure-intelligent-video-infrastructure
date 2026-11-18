import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import mongoose from "mongoose";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProbeMetadata, probeMedia, resolveMediaExecutablePaths, runMediaCommand } from "./ffmpeg.js";
import { createVideoProcessor, selectRenditionHeights } from "./video-processor.js";
import { connectWithBoundedRetries } from "../runtime/connection.js";
import { WorkerVideo } from "../models/video.js";
import type { MediaAssetStorage } from "@siv/shared";
import {
  generateHlsMasterPlaylist,
  packageAdaptiveStreaming,
  validateDashManifest,
  validateHlsMasterPlaylist,
  validateHlsMediaPlaylist
} from "./streaming-packager.js";

const temporaryDirectories: string[] = [];
const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-version"], { shell: false }).status === 0;
const ffprobeAvailable = spawnSync(process.env.FFPROBE_PATH ?? "ffprobe", ["-version"], { shell: false }).status === 0;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("media worker safeguards", () => {
  it("uses configured executable paths for media commands", async () => {
    const executablePaths = resolveMediaExecutablePaths({
      FFMPEG_PATH: process.execPath,
      FFPROBE_PATH: process.execPath
    });

    expect(executablePaths).toEqual({
      ffmpegPath: process.execPath,
      ffprobePath: process.execPath
    });
    await expect(runMediaCommand(
      executablePaths.ffmpegPath,
      ["-e", "process.stdout.write('custom ffmpeg executable')"],
      5_000,
      1024
    )).resolves.toMatchObject({ stdout: "custom ffmpeg executable" });
    await expect(runMediaCommand(
      executablePaths.ffprobePath,
      ["-e", "process.stdout.write('custom ffprobe executable')"],
      5_000,
      1024
    )).resolves.toMatchObject({ stdout: "custom ffprobe executable" });
  });

  it("falls back to FFmpeg and FFprobe commands resolved from PATH", () => {
    expect(resolveMediaExecutablePaths({})).toEqual({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe"
    });
    expect(resolveMediaExecutablePaths({ FFMPEG_PATH: "", FFPROBE_PATH: "" })).toEqual({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe"
    });
  });

  it("preserves bounded stderr from failed media commands", async () => {
    await expect(runMediaCommand(
      process.execPath,
      ["-e", "process.stderr.write('FFprobe diagnostic'); process.exit(2)"],
      5_000,
      1024
    )).rejects.toMatchObject({
      message: expect.stringContaining("FFprobe diagnostic"),
      stderr: "FFprobe diagnostic",
      stack: expect.any(String)
    });
  });

  it("only chooses configured output heights supported by the source", () => {
    expect(selectRenditionHeights(720, [1080, 720, 480, 360])).toEqual([720, 480, 360]);
    expect(selectRenditionHeights(144, [1080, 720, 480, 360, 240])).toEqual([144]);
    expect(selectRenditionHeights(0, [1080, 720])).toEqual([]);
  });

  it("extracts validated duration, dimensions and codec from FFprobe JSON", () => {
    expect(parseProbeMetadata(JSON.stringify({
      format: { duration: "12.5" },
      streams: [
        { codec_type: "audio", codec_name: "aac" },
        { codec_type: "video", codec_name: "h264", width: 1280, height: 720 }
      ]
    }))).toEqual({
      durationSeconds: 12.5,
      width: 1280,
      height: 720,
      videoCodec: "h264"
    });
    expect(() => parseProbeMetadata(JSON.stringify({ format: { duration: "0" }, streams: [] }))).toThrow();
  });

  it("stops bounded startup retries and does not retry indefinitely", async () => {
    let attempts = 0;
    await expect(connectWithBoundedRetries(async () => {
      attempts++;
      throw new Error("offline");
    }, 3, 0)).rejects.toThrow("offline");
    expect(attempts).toBe(3);
  });

  it("generates a master playlist referencing only verified rendition names", () => {
    const renditions = [
      { name: "720p", width: 1280, height: 720, codec: "h264", fileSizeBytes: 120_000, durationSeconds: 30, path: "720.mp4" },
      { name: "360p", width: 640, height: 360, codec: "h264", fileSizeBytes: 60_000, durationSeconds: 30, path: "360.mp4" }
    ];
    const master = generateHlsMasterPlaylist(renditions);
    expect(master).toContain("720p/index.m3u8");
    expect(master).toContain("360p/index.m3u8");
    expect(() => validateHlsMasterPlaylist(master, ["720p", "360p"])).not.toThrow();
    expect(() => validateHlsMasterPlaylist(master, ["1080p"])).toThrow();
  });

  it("rejects HLS playlists with missing or unsafe segments and DASH manifests with absent references", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-packaging-validation-"));
    temporaryDirectories.push(root);
    const hlsDirectory = join(root, "hls", "360p");
    await mkdir(hlsDirectory, { recursive: true });
    const mediaPlaylistPath = join(hlsDirectory, "index.m3u8");
    await writeFile(mediaPlaylistPath, "#EXTM3U\n#EXTINF:1.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n");
    await expect(validateHlsMediaPlaylist(mediaPlaylistPath, await (await import("node:fs/promises")).readFile(mediaPlaylistPath, "utf8"))).rejects.toThrow();
    await writeFile(join(hlsDirectory, "segment-00001.ts"), Buffer.from([0x47, 0x00]));
    expect(await validateHlsMediaPlaylist(mediaPlaylistPath, await (await import("node:fs/promises")).readFile(mediaPlaylistPath, "utf8")))
      .toEqual([join(hlsDirectory, "segment-00001.ts")]);
    await writeFile(join(hlsDirectory, "segment-00001.ts"), "not a transport stream");
    await expect(validateHlsMediaPlaylist(mediaPlaylistPath, await (await import("node:fs/promises")).readFile(mediaPlaylistPath, "utf8"))).rejects.toThrow("corrupt segment");
    const dashDirectory = join(root, "dash");
    await mkdir(dashDirectory, { recursive: true });
    await writeFile(join(dashDirectory, "init-0.m4s"), Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]));
    await writeFile(join(dashDirectory, "chunk-0-1.m4s"), Buffer.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]));
    expect(await validateDashManifest(
      join(dashDirectory, "stream.mpd"),
      '<MPD type="static"><Initialization sourceURL="init-0.m4s"/><SegmentURL media="chunk-0-1.m4s"/></MPD>'
    )).toHaveLength(2);
    await expect(validateDashManifest(join(root, "stream.mpd"), '<MPD type="static"><SegmentURL media="missing.m4s"/></MPD>')).rejects.toThrow();
  });

  it("persists terminal failure and removes temporary media after invalid input", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-invalid-media-"));
    temporaryDirectories.push(root);
    const videoId = new mongoose.Types.ObjectId().toString();
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(),
      uploadStatus: "uploaded",
      processingStatus: "queued",
      processingAttempt: 1,
      fileSizeBytes: 17,
      originalAssetStorageKey: `videos/${new mongoose.Types.ObjectId()}/${videoId}/original`
    };
    const query = { select: () => query, exec: async () => video };
    const updates: Array<Record<string, unknown>> = [];
    const findOne = vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query as never);
    const updateOne = vi.spyOn(WorkerVideo, "updateOne").mockImplementation((...args: unknown[]) => {
      updates.push(args[1] as Record<string, unknown>);
      return { exec: async () => ({ matchedCount: 1 }) } as never;
    });
    const storage = {
      async downloadObject(_key: string, destination: string) {
        await writeFile(destination, "not a valid video");
      },
      async uploadFile() {},
      async deleteObject() {}
    } satisfies MediaAssetStorage;
    const processor = createVideoProcessor(storage, {
      ffmpegPath: "ffmpeg-not-used",
      ffprobePath: "missing-ffprobe-command",
      temporaryRoot: root,
      maxDurationSeconds: 100,
      maxOutputBytes: 1024 * 1024,
      maxUploadBytes: 1024 * 1024,
      threads: 1,
      timeoutMs: 1_000,
      resolutionHeights: [240]
    }, pino({ level: "silent" }));

    await expect(processor({
      data: { videoId, attempt: 1 },
      attemptsMade: 0,
      opts: { attempts: 3 }
    } as never)).rejects.toThrow();
    expect(updates.some((update) => (update.$set as { processingStatus?: string } | undefined)?.processingStatus === "failed")).toBe(false);
    updates.length = 0;

    await expect(processor({
      data: { videoId, attempt: 1 },
      attemptsMade: 2,
      opts: { attempts: 3 }
    } as never)).rejects.toThrow();

    expect(updates.some((update) => (update.$set as { processingStatus?: string } | undefined)?.processingStatus === "failed")).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalled();
  });

  it("logs error message, stack and media-command stderr without replacing the error", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-error-logging-"));
    temporaryDirectories.push(root);
    const videoId = new mongoose.Types.ObjectId().toString();
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(),
      uploadStatus: "uploaded",
      processingStatus: "queued",
      processingAttempt: 1,
      fileSizeBytes: 17,
      originalAssetStorageKey: `videos/${new mongoose.Types.ObjectId()}/${videoId}/original`
    };
    const query = { select: () => query, exec: async () => video };
    vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query as never);
    vi.spyOn(WorkerVideo, "updateOne").mockReturnValue({
      exec: async () => ({ matchedCount: 1 })
    } as never);

    const logs: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "error" }, {
      write: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); }
    });
    const originalError = Object.assign(new Error("Video processing command failed"), {
      stderr: "invalid media container"
    });
    const storage = {
      async downloadObject() { throw originalError; },
      async uploadFile() {},
      async deleteObject() {}
    } satisfies MediaAssetStorage;
    const processor = createVideoProcessor(storage, {
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      temporaryRoot: root,
      maxDurationSeconds: 100,
      maxOutputBytes: 1024 * 1024,
      maxUploadBytes: 1024 * 1024,
      threads: 1,
      timeoutMs: 1_000,
      resolutionHeights: [240]
    }, logger);

    await expect(processor({
      data: { videoId, attempt: 1 },
      attemptsMade: 0,
      opts: { attempts: 3 }
    } as never)).rejects.toBe(originalError);

    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msg: "video processing attempt failed",
        message: "Video processing command failed",
        stack: expect.stringContaining("Video processing command failed"),
        stderr: "invalid media container",
        retryable: true
      })
    ]));
  });

  it("logs the resolved source path and confirms source existence when paths contain spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv source path with spaces-"));
    temporaryDirectories.push(root);
    const videoId = new mongoose.Types.ObjectId().toString();
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(),
      uploadStatus: "uploaded",
      processingStatus: "queued",
      processingAttempt: 1,
      fileSizeBytes: 17,
      originalAssetStorageKey: `videos/${new mongoose.Types.ObjectId()}/${videoId}/original`
    };
    const query = { select: () => query, exec: async () => video };
    vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query as never);
    vi.spyOn(WorkerVideo, "updateOne").mockReturnValue({
      exec: async () => ({ matchedCount: 1 })
    } as never);

    const logs: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "info" }, {
      write: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); }
    });
    const storage = {
      async downloadObject(_key: string, destination: string) {
        await writeFile(destination, Buffer.alloc(17));
      },
      async uploadFile() {},
      async deleteObject() {}
    } satisfies MediaAssetStorage;
    const processor = createVideoProcessor(storage, {
      ffmpegPath: "ffmpeg",
      ffprobePath: join(root, "missing ffprobe.exe"),
      temporaryRoot: root,
      maxDurationSeconds: 100,
      maxOutputBytes: 1024 * 1024,
      maxUploadBytes: 1024 * 1024,
      threads: 1,
      timeoutMs: 1_000,
      resolutionHeights: [240]
    }, logger);

    await expect(processor({
      data: { videoId, attempt: 1 },
      attemptsMade: 0,
      opts: { attempts: 1 }
    } as never)).rejects.toMatchObject({ code: "ENOENT" });

    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msg: "uploaded source media resolved",
        sourceStorageKey: video.originalAssetStorageKey,
        resolvedSourcePath: expect.stringContaining("siv source path with spaces"),
        sourceFileExists: true,
        sourceFileSizeBytes: 17
      })
    ]));
  });

  it("redacts a complete quoted Windows path without corrupting its space-separated components", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv path redaction-"));
    temporaryDirectories.push(root);
    const videoId = new mongoose.Types.ObjectId().toString();
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(),
      uploadStatus: "uploaded",
      processingStatus: "queued",
      processingAttempt: 1,
      fileSizeBytes: 17,
      originalAssetStorageKey: `videos/${new mongoose.Types.ObjectId()}/${videoId}/original`
    };
    const query = { select: () => query, exec: async () => video };
    vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query as never);
    const updates: Array<Record<string, unknown>> = [];
    vi.spyOn(WorkerVideo, "updateOne").mockImplementation((...args: unknown[]) => {
      updates.push(args[1] as Record<string, unknown>);
      return { exec: async () => ({ matchedCount: 1 }) } as never;
    });
    const failingPath = join(root, "streaming", "dash", "chunk-0-1.m4s");
    const storage = {
      async downloadObject() {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, stat '${failingPath}'`),
          { code: "ENOENT" }
        );
      },
      async uploadFile() {},
      async deleteObject() {}
    } satisfies MediaAssetStorage;
    const processor = createVideoProcessor(storage, {
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      temporaryRoot: root,
      maxDurationSeconds: 100,
      maxOutputBytes: 1024 * 1024,
      maxUploadBytes: 1024 * 1024,
      threads: 1,
      timeoutMs: 1_000,
      resolutionHeights: [240]
    }, pino({ level: "silent" }));

    await expect(processor({
      data: { videoId, attempt: 1 },
      attemptsMade: 0,
      opts: { attempts: 1 }
    } as never)).rejects.toMatchObject({ code: "ENOENT" });

    const processingError = updates
      .map((update) => (update.$set as { processingError?: string } | undefined)?.processingError)
      .find((message) => message !== undefined);
    expect(processingError).toBe("ENOENT: no such file or directory, stat [temporary media file]");
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)("creates and probes a real small MP4 rendition with FFmpeg", async () => {
    const directory = await mkdtemp(join(tmpdir(), "siv-ffmpeg-test-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.mp4");
    const outputPath = join(directory, "240p.mp4");
    const corruptPath = join(directory, "corrupt.mp4");
    await runMediaCommand(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      sourcePath
    ], 60_000, 64 * 1024);
    const source = await probeMedia(process.env.FFPROBE_PATH ?? "ffprobe", sourcePath, 20_000);
    await runMediaCommand(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error",
      "-i", sourcePath, "-map", "0:v:0", "-vf", "scale=-2:240",
      "-c:v", "libx264", "-threads", "1", outputPath
    ], 60_000, 64 * 1024);
    const output = await probeMedia(process.env.FFPROBE_PATH ?? "ffprobe", outputPath, 20_000);

    expect(source).toMatchObject({ width: 320, height: 240 });
    expect(output.width).toBeLessThanOrEqual(source.width);
    expect(output.height).toBeLessThanOrEqual(source.height);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
    await writeFile(corruptPath, "not a valid video");
    await expect(probeMedia(process.env.FFPROBE_PATH ?? "ffprobe", corruptPath, 20_000)).rejects.toThrow();
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)("packages a real MP4 as validated HLS and DASH assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "siv-adaptive-test-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.mp4");
    await runMediaCommand(process.env.FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      sourcePath
    ], 60_000, 64 * 1024);
    const metadata = await probeMedia(process.env.FFPROBE_PATH ?? "ffprobe", sourcePath, 20_000);
    const outputRoot = join(directory, "adaptive");
    const packaged = await packageAdaptiveStreaming([{
      name: "240p",
      width: metadata.width,
      height: metadata.height,
      codec: metadata.videoCodec,
      fileSizeBytes: (await stat(sourcePath)).size,
      durationSeconds: metadata.durationSeconds,
      path: sourcePath
    }], outputRoot, {
      ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
      timeoutMs: 60_000,
      threads: 1,
      maxOutputBytes: 20 * 1024 * 1024
    });

    expect(packaged.manifests.map(({ protocol }) => protocol)).toEqual(expect.arrayContaining(["hls", "dash"]));
    expect(packaged.assets.some(({ relativePath }) => relativePath === "hls/master.m3u8")).toBe(true);
    expect(packaged.assets.some(({ relativePath }) => relativePath.endsWith(".ts"))).toBe(true);
    expect(packaged.assets.some(({ relativePath }) => relativePath.endsWith(".m4s"))).toBe(true);
    expect(packaged.assets.some(({ relativePath }) => relativePath.startsWith("dash/"))).toBe(true);
  });
});
