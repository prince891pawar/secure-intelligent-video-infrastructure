import { OpenAiVideoIntelligenceProvider, type VideoIntelligenceProvider } from "@siv/shared";
import { Types } from "mongoose";
import { ApiError } from "../errors/api-error.js";
import { SecuritySignal } from "../models/security-signal.js";
import { Transcript } from "../models/transcript.js";
import { Video } from "../models/video.js";

export interface VideoIntelligenceQueue {
  enqueue(videoId: string, retryCount: number): Promise<void>;
}

export interface VideoIntelligenceConfig {
  apiKey?: string;
  textModel: string;
  embeddingModel: string;
  timeoutMs: number;
}

export class VideoIntelligenceService {
  private readonly provider: VideoIntelligenceProvider;
  private readonly configured: boolean;

  constructor(
    private readonly queue: VideoIntelligenceQueue,
    config: VideoIntelligenceConfig,
    provider?: VideoIntelligenceProvider
  ) {
    this.configured = Boolean(config.apiKey || provider);
    this.provider = provider ?? new OpenAiVideoIntelligenceProvider(
      config.apiKey,
      config.timeoutMs,
      config.textModel,
      config.embeddingModel
    );
  }

  async getStatus(ownerId: string, videoId: string) {
    const video = await ownedVideo(ownerId, videoId, "transcription chapterExtraction subtitles");
    return {
      transcription: publicJobStatus(video.transcription),
      chapters: publicJobStatus(video.chapterExtraction),
      subtitles: (video.subtitles ?? []).map(({ language, contentType, fileSizeBytes }) => ({ language, contentType, fileSizeBytes }))
    };
  }

  async getTranscript(ownerId: string, videoId: string) {
    const video = await ownedVideo(ownerId, videoId, "transcription chapterExtraction");
    if (video.transcription?.status !== "ready") {
      throw new ApiError(409, "TRANSCRIPT_NOT_READY", "Transcript is not ready");
    }
    const transcript = await Transcript.findOne({ videoId }).select("-chunks.embedding").lean().exec();
    if (!transcript) throw new ApiError(503, "TRANSCRIPT_UNAVAILABLE", "Transcript data is temporarily unavailable");
    return {
      language: transcript.language,
      provider: transcript.provider,
      model: transcript.model,
      embeddingModel: transcript.embeddingModel,
      segments: transcript.segments,
      chapters: transcript.chapters,
      topics: transcript.topics
    };
  }

  async retry(ownerId: string, videoId: string) {
    await ownedVideo(ownerId, videoId, "uploadStatus processingStatus");
    if (!this.configured) {
      throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "Transcription retry is unavailable until an AI provider is configured");
    }
    const video = await Video.findOneAndUpdate(
      { _id: videoId, owner: ownerId, uploadStatus: "uploaded", processingStatus: "completed", "transcription.status": "failed" },
      {
        $set: {
          "transcription.status": "queued",
          "transcription.updatedAt": new Date(),
          "chapterExtraction.status": "queued",
          "chapterExtraction.updatedAt": new Date()
        },
        $inc: { "transcription.retryCount": 1 },
        $unset: { "transcription.error": 1, "chapterExtraction.error": 1 }
      },
      { new: true }
    ).select("transcription.retryCount").lean().exec();
    if (!video) {
      const existing = await Video.exists({ _id: videoId, owner: ownerId });
      if (!existing) throw notFound();
      throw new ApiError(409, "INTELLIGENCE_NOT_RETRYABLE", "Video intelligence is not currently retryable");
    }
    await this.queue.enqueue(videoId, video.transcription.retryCount);
    return { status: "queued" as const, retryCount: video.transcription.retryCount };
  }

  async getSubtitle(ownerId: string, videoId: string, language: string) {
    const video = await ownedVideo(ownerId, videoId, "+subtitles.storageKey subtitles");
    if (video.transcription?.status !== "ready") throw new ApiError(404, "SUBTITLE_NOT_FOUND", "Subtitle was not found");
    const subtitle = video.subtitles?.find((item) => item.language === language);
    if (!subtitle?.storageKey) throw new ApiError(404, "SUBTITLE_NOT_FOUND", "Subtitle was not found");
    return {
      storageKey: subtitle.storageKey,
      contentType: subtitle.contentType,
      fileSizeBytes: subtitle.fileSizeBytes
    };
  }

  async search(ownerId: string, query: string, limit = 20) {
    const videoIds = await ownerVideoIds(ownerId);
    if (videoIds.length === 0) return { mode: "keyword" as const, results: [] };
    const transcripts = await Transcript.find({ videoId: { $in: videoIds } })
      .select("+chunks.embedding videoId")
      .slice("chunks", 200)
      .limit(50)
      .lean()
      .exec();
    const chunks = transcripts.flatMap((transcript) => transcript.chunks.map((chunk) => ({
      videoId: transcript.videoId.toString(),
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      text: chunk.text,
      embedding: chunk.embedding
    })));
    if (chunks.length === 0) return { mode: "keyword" as const, results: [] };

    let mode: "vector" | "keyword" = "keyword";
    let queryVector: number[] | undefined;
    if (this.providerConfigured()) {
      try {
        queryVector = (await this.provider.embed([query]))[0];
      } catch {
        throw new ApiError(503, "SEARCH_PROVIDER_UNAVAILABLE", "Search provider is temporarily unavailable");
      }
      if (queryVector && chunks.length > 0 && chunks.every((chunk) => chunk.embedding?.length === queryVector!.length)) mode = "vector";
    }
    const terms = tokenize(query);
    const results = chunks.map((chunk) => ({
      videoId: chunk.videoId,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      excerpt: chunk.text,
      score: mode === "vector"
        ? cosineSimilarity(queryVector!, chunk.embedding!)
        : keywordScore(terms, chunk.text)
    }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ score, ...result }) => ({ ...result, relevance: Math.round(score * 1000) / 1000 }));
    return { mode, results };
  }

  async answer(ownerId: string, videoId: string, question: string) {
    const video = await ownedVideo(ownerId, videoId, "transcription");
    if (video.transcription?.status !== "ready") throw new ApiError(409, "TRANSCRIPT_NOT_READY", "Transcript is not ready");
    if (!this.providerConfigured()) {
      throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "Question answering is unavailable until an AI provider is configured");
    }
    const transcript = await Transcript.findOne({ videoId }).select("+chunks.embedding").slice("chunks", 1000).lean().exec();
    if (!transcript) throw new ApiError(409, "TRANSCRIPT_NOT_READY", "Transcript is not ready");
    const chunks = transcript.chunks;
    let queryVector: number[] | undefined;
    try {
      queryVector = (await this.provider.embed([question]))[0];
    } catch {
      throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "Question-answer provider is temporarily unavailable");
    }
    const terms = tokenize(question);
    const useVectors = chunks.length > 0 && chunks.every((chunk) => chunk.embedding?.length === queryVector?.length);
    const evidence = chunks.map((chunk) => ({
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      text: chunk.text,
      score: useVectors && queryVector && chunk.embedding?.length === queryVector.length
        ? cosineSimilarity(queryVector, chunk.embedding)
        : keywordScore(terms, chunk.text)
    })).sort((left, right) => right.score - left.score).slice(0, 5);
    const selected = evidence.filter((item) => item.score > 0.05);
    if (!selected.length) {
      return {
        answer: "The transcript does not contain enough information to answer this question.",
        insufficientEvidence: true,
        citations: []
      };
    }
    let result;
    try {
      result = await this.provider.answer(question, selected);
    } catch {
      throw new ApiError(503, "AI_PROVIDER_UNAVAILABLE", "Question-answer provider is temporarily unavailable");
    }
    return {
      answer: result.answer,
      insufficientEvidence: result.insufficientEvidence,
      citations: result.citations.map((citation) => ({ videoId, ...citation }))
    };
  }

  async getReviewSignals(ownerId: string, videoId: string) {
    await ownedVideo(ownerId, videoId, "");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const signals = await SecuritySignal.find({ videoId, observedAt: { $gte: since } })
      .select("-sessionId -_id")
      .sort({ observedAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return {
      label: "Review signals only; these heuristics are not evidence of wrongdoing.",
      windowStart: since.toISOString(),
      signals
    };
  }

  private providerConfigured(): boolean {
    return this.configured;
  }
}

async function ownedVideo(ownerId: string, videoId: string, select: string) {
  if (!Types.ObjectId.isValid(ownerId) || !Types.ObjectId.isValid(videoId)) throw notFound();
  const query = Video.findOne({ _id: videoId, owner: ownerId });
  if (select) query.select(select);
  const video = await query.lean().exec();
  if (!video) throw notFound();
  return video;
}

async function ownerVideoIds(ownerId: string): Promise<Types.ObjectId[]> {
  if (!Types.ObjectId.isValid(ownerId)) return [];
  const videos = await Video.find({ owner: ownerId, uploadStatus: "uploaded", processingStatus: "completed", "transcription.status": "ready" })
    .select("_id")
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()
    .exec();
  return videos.map((video) => video._id);
}

function publicJobStatus(job: { status: string; provider?: string; model?: string; error?: string; retryCount: number; updatedAt?: Date } | undefined) {
  if (!job) return { status: "unavailable", error: "Video intelligence has not been processed", retryCount: 0 };
  return {
    status: job.status,
    ...(job.provider ? { provider: job.provider } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.error ? { error: job.error } : {}),
    retryCount: job.retryCount,
    ...(job.updatedAt ? { updatedAt: job.updatedAt.toISOString() } : {})
  };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 20);
}

function keywordScore(terms: string[], text: string): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length / terms.length;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)) : 0;
}

function notFound(): ApiError {
  return new ApiError(404, "VIDEO_NOT_FOUND", "Video was not found");
}
