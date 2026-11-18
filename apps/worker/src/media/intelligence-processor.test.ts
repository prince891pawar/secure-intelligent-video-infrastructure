import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { MediaAssetStorage } from "@siv/shared";
import { WorkerTranscript } from "../models/transcript.js";
import { WorkerVideo } from "../models/video.js";
import * as mediaCommands from "./ffmpeg.js";
import {
  createIntelligenceProcessor,
  reconcileQueuedIntelligence,
  type IntelligenceJobData
} from "./intelligence-processor.js";

const temporaryDirectories: string[] = [];
const videoId = new mongoose.Types.ObjectId().toString();
const ownerId = new mongoose.Types.ObjectId().toString();

function query(value: unknown) {
  const result = {
    exec: async () => value,
    select: () => result,
    lean: () => result,
    sort: () => result,
    limit: () => result
  };
  return result;
}

function providerResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("video intelligence worker (mocked storage, provider, MongoDB and media tools)", () => {
  it("reconciles persisted queued intelligence into a deterministic BullMQ job", async () => {
    vi.spyOn(WorkerVideo, "updateMany").mockReturnValue(query({ modifiedCount: 0 }) as never);
    vi.spyOn(WorkerVideo, "find").mockReturnValue(query([{
      _id: new mongoose.Types.ObjectId(videoId),
      transcription: { retryCount: 3 }
    }]) as never);
    const add = vi.fn(async () => undefined);
    const created = await reconcileQueuedIntelligence({ add }, new Date());
    expect(created).toBe(1);
    expect(add).toHaveBeenCalledWith(
      "transcribe-video",
      { videoId, retryCount: 3 },
      expect.objectContaining({ jobId: `${videoId}-intelligence-3`, attempts: 3 })
    );
  });

  it("writes real provider transcript/subtitles and removes temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-ai-worker-"));
    temporaryDirectories.push(root);
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(ownerId),
      originalAssetStorageKey: `videos/${ownerId}/${videoId}/original/source.mp4`,
      durationSeconds: 10,
      transcription: { retryCount: 0 }
    };
    vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query(video) as never);
    vi.spyOn(WorkerVideo, "updateOne").mockReturnValue(query({ matchedCount: 1 }) as never);
    vi.spyOn(WorkerTranscript, "findOneAndUpdate").mockReturnValue(query({}) as never);
    const storedSubtitles: string[] = [];
    const storage: MediaAssetStorage = {
      async downloadObject(_key, destination) { await writeFile(destination, "source-video"); },
      async uploadFile(key, sourcePath) { storedSubtitles.push(`${key}:${await (await import("node:fs/promises")).readFile(sourcePath, "utf8")}`); },
      async deleteObject() {}
    };
    vi.spyOn(mediaCommands, "runMediaCommand").mockImplementation(async (_executable, args) => {
      if (args.includes("-select_streams")) return { stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }), stderr: "" };
      const outputPath = args[args.length - 1]!;
      await writeFile(outputPath, Buffer.from("bounded-audio"));
      return { stdout: "", stderr: "" };
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) {
        return providerResponse({ language: "en", segments: [{ start: 0, end: 2, text: "A verified spoken sentence." }] });
      }
      if (url.endsWith("/chat/completions")) {
        return providerResponse({ choices: [{ message: { content: JSON.stringify({
          chapters: [{ startSeconds: 0, endSeconds: 2, title: "Introduction" }],
          topics: [{ name: "Introduction", keywords: ["intro"], startSeconds: 0, endSeconds: 2 }]
        }) } }] });
      }
      return providerResponse({ data: [{ index: 0, embedding: Array.from({ length: 8 }, (_, index) => index ? 0 : 1) }] });
    }));

    await createIntelligenceProcessor(storage, {
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      temporaryRoot: root,
      maxAudioBytes: 1024 * 1024,
      timeoutMs: 1000,
      apiKey: "test-key",
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small"
    })({
      data: { videoId, retryCount: 0 },
      opts: { attempts: 3 },
      attemptsMade: 0
    } as Job<IntelligenceJobData>);

    expect(storedSubtitles).toHaveLength(1);
    expect(storedSubtitles[0]).toContain("subtitles/en.vtt:WEBVTT");
    expect(WorkerTranscript.findOneAndUpdate).toHaveBeenCalledWith(
      { videoId },
      expect.objectContaining({ $set: expect.objectContaining({
        segments: [{ startSeconds: 0, endSeconds: 2, text: "A verified spoken sentence." }]
      }) }),
      expect.any(Object)
    );
    expect(WorkerVideo.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: videoId }),
      expect.objectContaining({ $set: expect.objectContaining({ "transcription.status": "ready", "chapterExtraction.status": "ready" }) })
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("marks a video without an audio stream failed on its final attempt and cleans temporary data", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv-ai-no-audio-"));
    temporaryDirectories.push(root);
    const video = {
      _id: new mongoose.Types.ObjectId(videoId),
      owner: new mongoose.Types.ObjectId(ownerId),
      originalAssetStorageKey: `videos/${ownerId}/${videoId}/original/source.mp4`,
      durationSeconds: 10
    };
    vi.spyOn(WorkerVideo, "findOne").mockReturnValue(query(video) as never);
    const updates = vi.spyOn(WorkerVideo, "updateOne").mockReturnValue(query({ matchedCount: 1 }) as never);
    const storage: MediaAssetStorage = {
      async downloadObject(_key, destination) { await writeFile(destination, "source-video"); },
      async uploadFile() {},
      async deleteObject() {}
    };
    vi.spyOn(mediaCommands, "runMediaCommand").mockResolvedValue({
      stdout: JSON.stringify({ streams: [] }),
      stderr: ""
    });
    const processor = createIntelligenceProcessor(storage, {
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      temporaryRoot: root,
      maxAudioBytes: 1024 * 1024,
      timeoutMs: 1000,
      apiKey: "test-key",
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small"
    });
    await expect(processor({
      data: { videoId, retryCount: 0 },
      opts: { attempts: 1 },
      attemptsMade: 0
    } as Job<IntelligenceJobData>)).rejects.toThrow("no audio track");
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ _id: videoId }),
      expect.objectContaining({ $set: expect.objectContaining({ "transcription.status": "failed" }) })
    );
    expect(await readdir(root)).toEqual([]);
  });
});
