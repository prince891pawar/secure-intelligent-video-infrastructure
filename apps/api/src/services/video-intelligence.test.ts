import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIProviderUnavailableError,
  OpenAiVideoIntelligenceProvider,
  buildTranscriptChunks,
  createWebVtt,
  normalizeChapterTopics,
  normalizeSpeechSegments,
  validateWebVtt
} from "@siv/shared";
import { Transcript } from "../models/transcript.js";
import { Video } from "../models/video.js";
import { VideoIntelligenceService } from "./video-intelligence-service.js";

const userId = new mongoose.Types.ObjectId().toString();
const videoId = new mongoose.Types.ObjectId().toString();

function chain(value: unknown) {
  const query = {
    exec: async () => value,
    lean: () => query,
    select: () => query,
    sort: () => query,
    limit: () => query,
    slice: () => query
  };
  return query;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("video intelligence helpers", () => {
  it("normalizes timestamps, builds time-preserving chunks and rejects empty subtitle data", () => {
    const segments = normalizeSpeechSegments([
      { startSeconds: 4, endSeconds: 5, text: "  second   line " },
      { startSeconds: -1, endSeconds: 2, text: "invalid" },
      { startSeconds: 1, endSeconds: 2, text: "first line" }
    ]);
    expect(segments.map(({ startSeconds }) => startSeconds)).toEqual([1, 4]);
    expect(buildTranscriptChunks(segments, 12)).toEqual([
      { startSeconds: 1, endSeconds: 2, text: "first line" },
      { startSeconds: 4, endSeconds: 5, text: "second line" }
    ]);
    expect(() => createWebVtt([])).toThrow("without valid transcript");
  });

  it("generates valid WebVTT and rejects malformed timestamps", () => {
    const webVtt = createWebVtt([{ startSeconds: 0.25, endSeconds: 1.5, text: "Safe <subtitle>" }]);
    expect(webVtt).toContain("00:00:00.250 --> 00:00:01.500");
    expect(webVtt).toContain("Safe &lt;subtitle&gt;");
    expect(() => validateWebVtt(webVtt)).not.toThrow();
    expect(() => validateWebVtt("WEBVTT\n\n1\nbad --> timing\nText")).toThrow();
  });

  it("drops chapters and topics outside the real video duration or without transcript overlap", () => {
    expect(normalizeChapterTopics({
      chapters: [
        { startSeconds: 0, endSeconds: 3, title: " Valid " },
        { startSeconds: 4, endSeconds: 12, title: "Too long" }
      ],
      topics: [{ name: "Unrelated", keywords: [], startSeconds: 6, endSeconds: 7 }]
    }, 10, [{ startSeconds: 0, endSeconds: 4, text: "real transcript" }])).toEqual({
      chapters: [{ startSeconds: 0, endSeconds: 3, title: "Valid" }],
      topics: []
    });
  });

  it("reports missing provider configuration instead of inventing a transcript", async () => {
    const provider = new OpenAiVideoIntelligenceProvider(undefined, 1000);
    await expect(provider.transcribe(new Uint8Array([1]), "audio.mp3")).rejects.toBeInstanceOf(AIProviderUnavailableError);
  });

  it("rejects malformed provider segments and surfaces rate limits without leaking provider bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      language: "en",
      segments: [{ start: "invalid", end: 0, text: "" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = new OpenAiVideoIntelligenceProvider("test-key", 1000);
    await expect(provider.transcribe(new Uint8Array([1]), "audio.mp3"))
      .rejects.toThrow("invalid timed segments");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private response body", { status: 429 })));
    await expect(provider.embed(["query"])).rejects.toThrow("rate limit reached");
  });

  it("validates and abstains when provider citations are not grounded in supplied transcript text", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer: "Unverified answer",
        citations: [{ startSeconds: 1, endSeconds: 2, quote: "invented quote" }],
        insufficientEvidence: false
      }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = new OpenAiVideoIntelligenceProvider("test-key", 1000);
    await expect(provider.answer("Question?", [{ startSeconds: 0, endSeconds: 3, text: "actual words" }]))
      .resolves.toMatchObject({ insufficientEvidence: true, citations: [] });
    vi.stubGlobal("fetch", originalFetch);
  });
});

describe("video intelligence API service (mocked MongoDB)", () => {
  it("reports legacy videos without an AI job as explicitly unavailable", async () => {
    vi.spyOn(Video, "findOne").mockReturnValue(chain({}) as never);
    const service = new VideoIntelligenceService({ enqueue: async () => undefined }, {
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      timeoutMs: 1000
    });
    await expect(service.getStatus(userId, videoId)).resolves.toMatchObject({
      transcription: { status: "unavailable", retryCount: 0 },
      chapters: { status: "unavailable", retryCount: 0 },
      subtitles: []
    });
  });

  it("denies transcript access when the authenticated user does not own the video", async () => {
    vi.spyOn(Video, "findOne").mockReturnValue(chain(null) as never);
    const service = new VideoIntelligenceService({ enqueue: async () => undefined }, {
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      timeoutMs: 1000
    });
    await expect(service.getTranscript(userId, videoId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("restricts keyword fallback results to transcript ids returned by the owner's video query", async () => {
    const ownedIds = [new mongoose.Types.ObjectId(videoId)];
    vi.spyOn(Video, "find").mockReturnValue(chain(ownedIds) as never);
    vi.spyOn(Transcript, "find").mockReturnValue(chain([{
      videoId: ownedIds[0],
      chunks: [{ startSeconds: 12, endSeconds: 18, text: "Distributed systems reliability" }]
    }]) as never);
    const service = new VideoIntelligenceService({ enqueue: async () => undefined }, {
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      timeoutMs: 1000
    });
    await expect(service.search(userId, "distributed reliability")).resolves.toMatchObject({
      mode: "keyword",
      results: [{ videoId, startSeconds: 12, relevance: 1 }]
    });
    expect(Video.find).toHaveBeenCalledWith(expect.objectContaining({ owner: userId }));
    expect(Transcript.find).toHaveBeenCalledWith({ videoId: { $in: ownedIds } });
  });

  it("returns an explicit provider-unavailable error for Q&A without configured credentials", async () => {
    vi.spyOn(Video, "findOne").mockReturnValue(chain({ transcription: { status: "ready" } }) as never);
    const service = new VideoIntelligenceService({ enqueue: async () => undefined }, {
      textModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      timeoutMs: 1000
    });
    await expect(service.answer(userId, videoId, "What happened?"))
      .rejects.toMatchObject({ statusCode: 503, code: "AI_PROVIDER_UNAVAILABLE" });
  });
});
