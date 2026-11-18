import type { MediaAssetStorage } from "@siv/shared";
import {
  AIProviderUnavailableError,
  OpenAiVideoIntelligenceProvider,
  type VideoIntelligenceProvider,
  buildTranscriptChunks,
  createWebVtt,
  validateWebVtt
} from "@siv/shared";
import type { Job } from "bullmq";
import mongoose from "mongoose";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkerTranscript } from "../models/transcript.js";
import { WorkerVideo } from "../models/video.js";
import { runMediaCommand } from "./ffmpeg.js";

export interface IntelligenceJobData {
  videoId: string;
  retryCount: number;
}

export interface IntelligenceProcessorConfig {
  ffmpegPath: string;
  ffprobePath: string;
  temporaryRoot: string;
  maxAudioBytes: number;
  timeoutMs: number;
  apiKey?: string;
  textModel: string;
  embeddingModel: string;
}

export function createIntelligenceProcessor(
  storage: MediaAssetStorage,
  config: IntelligenceProcessorConfig,
  configuredProvider?: VideoIntelligenceProvider
) {
  const provider = configuredProvider ?? new OpenAiVideoIntelligenceProvider(
    config.apiKey,
    config.timeoutMs,
    config.textModel,
    config.embeddingModel
  );
  return async (job: Job<IntelligenceJobData>): Promise<void> => {
    const { videoId, retryCount } = job.data;
    if (!mongoose.Types.ObjectId.isValid(videoId) || !Number.isInteger(retryCount) || retryCount < 0) {
      throw new Error("Intelligence job data is invalid");
    }

    let workingDirectory: string | undefined;
    let subtitleKey: string | undefined;
    try {
      const video = await WorkerVideo.findOne({
        _id: videoId,
        uploadStatus: "uploaded",
        processingStatus: "completed",
        "transcription.retryCount": retryCount,
        "transcription.status": "queued"
      }).select("+originalAssetStorageKey").exec();
      if (!video || !video.originalAssetStorageKey) return;
      if (!video.originalAssetStorageKey.startsWith(`videos/${video.owner.toString()}/${videoId}/`)) {
        throw new Error("Uploaded source asset reference is invalid");
      }

      const started = await WorkerVideo.updateOne(
        { _id: videoId, "transcription.retryCount": retryCount, "transcription.status": "queued" },
        { $set: {
          "transcription.status": "processing",
          "transcription.provider": provider.provider,
          "transcription.model": provider.transcriptionModel,
          "transcription.updatedAt": new Date(),
          "chapterExtraction.status": "processing",
          "chapterExtraction.provider": provider.provider,
          "chapterExtraction.model": provider.textModel,
          "chapterExtraction.updatedAt": new Date()
        }, $unset: { "transcription.error": 1, "chapterExtraction.error": 1 } }
      ).exec();
      if (!started.matchedCount) return;

      const temporaryRoot = resolve(config.temporaryRoot);
      await mkdir(temporaryRoot, { recursive: true });
      workingDirectory = await mkdtemp(join(temporaryRoot, "siv-ai-"));
      const sourcePath = join(workingDirectory, "source.media");
      await storage.downloadObject(video.originalAssetStorageKey, sourcePath);
      const audioProbe = await runMediaCommand(config.ffprobePath, [
        "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "json", sourcePath
      ], config.timeoutMs, 64 * 1024);
      const audioMetadata = JSON.parse(audioProbe.stdout) as { streams?: Array<{ codec_type?: string }> };
      if (!audioMetadata.streams?.some((stream) => stream.codec_type === "audio")) {
        throw new Error("Uploaded video contains no audio track to transcribe");
      }

      const audioPath = join(workingDirectory, "audio.mp3");
      await runMediaCommand(config.ffmpegPath, [
        "-hide_banner", "-nostdin", "-v", "error", "-i", sourcePath,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
        "-fs", String(config.maxAudioBytes + 1), audioPath
      ], config.timeoutMs, 64 * 1024);
      const audioSize = (await stat(audioPath)).size;
      if (!audioSize || audioSize > config.maxAudioBytes) {
        throw new Error("Extracted audio exceeds the configured transcription provider limit");
      }
      const audio = await readFile(audioPath);
      const speech = await provider.transcribe(new Uint8Array(audio), "audio.mp3");
      const duration = video.durationSeconds;
      if (!duration || duration <= 0) throw new Error("Video duration is unavailable for transcript validation");
      const segments = speech.segments.filter((segment) => segment.startSeconds < duration && segment.endSeconds <= duration);
      const transcriptCharacters = segments.reduce((total, segment) => total + segment.text.length, 0);
      if (!segments.length) throw new Error("Transcription returned no valid speech segments");
      if (segments.length > 20_000 || transcriptCharacters > 2_000_000) {
        throw new Error("Transcript exceeds the configured persistence limits");
      }

      const chunks = buildTranscriptChunks(segments);
      if (chunks.length > 250) throw new Error("Transcript creates too many searchable chunks for the configured storage limit");
      const generated = await provider.extractChaptersAndTopics(segments, duration);
      for (let start = 0; start < chunks.length; start += 100) {
        const batch = chunks.slice(start, start + 100);
        const vectors = await provider.embed(batch.map((chunk) => chunk.text));
        batch.forEach((chunk, index) => {
          const vector = vectors[index];
          if (!vector) throw new Error("Embedding provider returned an incomplete batch");
          chunk.embedding = vector;
        });
      }
      const webVtt = createWebVtt(segments);
      validateWebVtt(webVtt);
      const subtitlePath = join(workingDirectory, "subtitles.vtt");
      await writeFile(subtitlePath, webVtt, { encoding: "utf8", flag: "wx" });
      const subtitleSize = (await stat(subtitlePath)).size;
      if (!subtitleSize || subtitleSize > 10 * 1024 * 1024) throw new Error("Generated subtitle file exceeds the safe size limit");
      const language = normalizeLanguage(speech.language);
      subtitleKey = `videos/${video.owner.toString()}/${videoId}/subtitles/${language}.vtt`;
      await storage.uploadFile(subtitleKey, subtitlePath, "text/vtt");

      await WorkerTranscript.findOneAndUpdate(
        { videoId },
        { $set: {
          videoId,
          language,
          provider: provider.provider,
          model: provider.transcriptionModel,
          embeddingModel: provider.embeddingModel,
          segments,
          chunks,
          chapters: generated.chapters,
          topics: generated.topics
        } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      ).exec();
      const saved = await WorkerVideo.updateOne(
        { _id: videoId, "transcription.retryCount": retryCount, "transcription.status": "processing" },
        { $set: {
          "transcription.status": "ready",
          "transcription.provider": provider.provider,
          "transcription.model": provider.transcriptionModel,
          "transcription.updatedAt": new Date(),
          "chapterExtraction.status": "ready",
          "chapterExtraction.provider": provider.provider,
          "chapterExtraction.model": provider.textModel,
          "chapterExtraction.updatedAt": new Date(),
          subtitles: [{ language, storageKey: subtitleKey, contentType: "text/vtt", fileSizeBytes: subtitleSize }]
        }, $unset: { "transcription.error": 1, "chapterExtraction.error": 1 } }
      ).exec();
      if (!saved.matchedCount) {
        await storage.deleteObject(subtitleKey);
      }
    } catch (error) {
      let cleanupError: unknown;
      if (subtitleKey) {
        try {
          await storage.deleteObject(subtitleKey);
        } catch (caught) {
          cleanupError = caught;
        }
      }
      const maxAttempts = job.opts.attempts ?? 1;
      const finalAttempt = job.attemptsMade + 1 >= maxAttempts;
      if (finalAttempt) {
        const message = cleanupError
          ? `${publicIntelligenceError(error)} (subtitle cleanup needs operator review)`
          : publicIntelligenceError(error);
        await WorkerVideo.updateOne(
          { _id: videoId, "transcription.retryCount": retryCount, "transcription.status": { $in: ["queued", "processing"] } },
          { $set: {
            "transcription.status": "failed",
            "transcription.error": message,
            "transcription.updatedAt": new Date(),
            "chapterExtraction.status": "failed",
            "chapterExtraction.error": message,
            "chapterExtraction.updatedAt": new Date()
          } }
        ).exec();
      } else {
        await WorkerVideo.updateOne(
          { _id: videoId, "transcription.retryCount": retryCount, "transcription.status": "processing" },
          { $set: {
            "transcription.status": "queued",
            "transcription.updatedAt": new Date(),
            "chapterExtraction.status": "queued",
            "chapterExtraction.updatedAt": new Date()
          } }
        ).exec();
      }
      if (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Intelligence processing failed and subtitle cleanup also failed",
          { cause: error }
        );
      }
      throw error;
    } finally {
      if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
    }
  };
}

export async function reconcileQueuedIntelligence(
  queue: { add(name: string, data: IntelligenceJobData, options: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: number;
    removeOnFail: number;
  }): Promise<unknown> },
  staleBefore: Date,
  limit = 100
): Promise<number> {
  await WorkerVideo.updateMany(
    { processingStatus: "completed", "transcription.status": "processing", "transcription.updatedAt": { $lte: staleBefore } },
    {
      $set: {
        "transcription.status": "queued",
        "transcription.updatedAt": new Date(),
        "chapterExtraction.status": "queued",
        "chapterExtraction.updatedAt": new Date()
      },
      $inc: { "transcription.retryCount": 1 }
    }
  ).exec();
  const videos = await WorkerVideo.find({
    processingStatus: "completed",
    "transcription.status": "queued"
  }).select("transcription.retryCount").sort({ "transcription.updatedAt": 1 }).limit(limit).lean().exec();
  for (const video of videos) {
    const videoId = video._id.toString();
    const retryCount = video.transcription.retryCount;
    await queue.add("transcribe-video", { videoId, retryCount }, {
      jobId: `${videoId}-intelligence-${retryCount}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 1000
    });
  }
  return videos.length;
}

function normalizeLanguage(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : "und";
}

function publicIntelligenceError(error: unknown): string {
  if (error instanceof AIProviderUnavailableError) return "AI provider is not configured";
  if (!(error instanceof Error)) return "Video intelligence processing failed";
  const safe = error.message.replace(/[\r\n]+/g, " ").trim();
  return safe.slice(0, 300) || "Video intelligence processing failed";
}
