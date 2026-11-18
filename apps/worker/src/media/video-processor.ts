import type { MediaAssetStorage, VideoRendition } from "@siv/shared";
import type { Job } from "bullmq";
import mongoose from "mongoose";
import type { Stats } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { WorkerVideo, type ProcessingState, type WorkerVideoRecord } from "../models/video.js";
import { probeMedia, runMediaCommand, type MediaCommandError } from "./ffmpeg.js";
import { packageAdaptiveStreaming } from "./streaming-packager.js";

export interface TranscodeJobData {
  videoId: string;
  attempt: number;
}

export interface VideoProcessorConfig {
  ffmpegPath: string;
  ffprobePath: string;
  temporaryRoot: string;
  maxDurationSeconds: number;
  maxOutputBytes: number;
  maxUploadBytes: number;
  threads: number;
  timeoutMs: number;
  resolutionHeights: number[];
  intelligenceEnabled?: boolean;
}

interface LoadedVideo extends WorkerVideoRecord {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  originalAssetStorageKey: string;
}

interface OutputRecord extends VideoRendition {
  storageKey: string;
  status: "ready";
}

export function createVideoProcessor(
  storage: MediaAssetStorage,
  config: VideoProcessorConfig,
  logger: pino.Logger
) {
  return async (job: Job<TranscodeJobData>): Promise<void> => {
    const { videoId, attempt } = job.data;
    if (!mongoose.Types.ObjectId.isValid(videoId) || !Number.isInteger(attempt) || attempt < 1) {
      throw new Error("Processing job data is invalid");
    }

    let workingDirectory: string | undefined;
    const outputKeys: string[] = [];

    try {
      const video = await WorkerVideo.findOne({
        _id: videoId,
        uploadStatus: "uploaded",
        processingAttempt: attempt
      }).select("+originalAssetStorageKey").exec() as LoadedVideo | null;
      if (!video || video.processingStatus === "completed" || video.processingStatus === "failed") return;
      if (!video.originalAssetStorageKey) throw new Error("Uploaded source asset reference is missing");
      assertSafeSourceKey(video.originalAssetStorageKey);

      const temporaryRoot = resolve(config.temporaryRoot || tmpdir());
      await mkdir(temporaryRoot, { recursive: true });
      workingDirectory = await mkdtemp(join(temporaryRoot, "siv-process-"));
      await updateStage(videoId, attempt, "probing");
      const sourcePath = join(workingDirectory, "source.media");
      let sourceDetails: Stats;
      try {
        await storage.downloadObject(video.originalAssetStorageKey, sourcePath);
        sourceDetails = await stat(sourcePath);
      } catch (error) {
        logger.error({
          videoId,
          attempt,
          sourceStorageKey: video.originalAssetStorageKey,
          resolvedSourcePath: sourcePath,
          ...(error instanceof Error && "code" in error && error.code === "ENOENT"
            ? { sourceFileExists: false }
            : {}),
          errorType: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error)
        }, "uploaded source media could not be resolved");
        throw error;
      }
      logger.info({
        videoId,
        attempt,
        sourceStorageKey: video.originalAssetStorageKey,
        resolvedSourcePath: sourcePath,
        sourceFileExists: true,
        sourceFileSizeBytes: sourceDetails.size
      }, "uploaded source media resolved");
      if (!sourceDetails.size || sourceDetails.size > config.maxUploadBytes
        || (video.fileSizeBytes !== undefined && sourceDetails.size !== video.fileSizeBytes)) {
        throw new Error("Uploaded media size does not match the verified video record");
      }

      const source = await probeMedia(config.ffprobePath, sourcePath, config.timeoutMs);
      if (source.durationSeconds > config.maxDurationSeconds) {
        throw new Error("Video duration exceeds the configured processing limit");
      }
      const heights = selectRenditionHeights(source.height, config.resolutionHeights);
      if (heights.length === 0) throw new Error("No supported output resolution is available for this source");
      await WorkerVideo.updateOne(
        { _id: videoId, processingAttempt: attempt },
        {
          $set: {
            processingStatus: "transcoding",
            processingUpdatedAt: new Date(),
            durationSeconds: source.durationSeconds,
            width: source.width,
            height: source.height,
            videoCodec: source.videoCodec,
            processingError: undefined
          }
        }
      ).exec();

      const outputs: Array<{ metadata: VideoRendition; path: string; storageKey: string }> = [];
      let totalOutputBytes = 0;
      const ownerId = video.owner.toString();
      for (const height of heights) {
        const name = `${height}p`;
        const outputPath = join(workingDirectory, `${name}.mp4`);
        const remainingOutputBytes = config.maxOutputBytes - totalOutputBytes;
        if (remainingOutputBytes <= 0) throw new Error("Generated renditions exceed the configured total output limit");
        await runMediaCommand(config.ffmpegPath, [
          "-hide_banner", "-nostdin", "-v", "error",
          "-i", sourcePath,
          "-map", "0:v:0",
          "-map", "0:a?",
          "-vf", `scale=-2:${height}`,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "23",
          "-threads", String(config.threads),
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          "-fs", String(remainingOutputBytes),
          outputPath
        ], config.timeoutMs, 64 * 1024);

        const outputSize = (await stat(outputPath)).size;
        if (outputSize <= 0 || outputSize > remainingOutputBytes) {
          throw new Error(`FFmpeg produced an invalid ${name} rendition size`);
        }
        totalOutputBytes += outputSize;
        if (totalOutputBytes > config.maxOutputBytes) {
          throw new Error("Generated renditions exceed the configured total output limit");
        }
        const outputProbe = await probeMedia(config.ffprobePath, outputPath, config.timeoutMs);
        if (outputProbe.width > source.width || outputProbe.height > source.height
          || outputProbe.height > height || outputProbe.durationSeconds <= 0) {
          throw new Error(`Generated ${name} rendition failed media validation`);
        }
        outputs.push({
          metadata: {
            name,
            width: outputProbe.width,
            height: outputProbe.height,
            codec: outputProbe.videoCodec,
            fileSizeBytes: outputSize
          },
          path: outputPath,
          storageKey: `videos/${ownerId}/${videoId}/renditions/${attempt}/${name}.mp4`
        });
      }

      for (const output of outputs) {
        await storage.uploadFile(output.storageKey, output.path, "video/mp4");
        outputKeys.push(output.storageKey);
      }

      await updateStage(videoId, attempt, "packaging");
      const packagingBudget = config.maxOutputBytes - totalOutputBytes;
      if (packagingBudget <= 0) throw new Error("Streaming packaging exceeds the configured total output limit");
      const streaming = await packageAdaptiveStreaming(outputs.map((output) => ({
        ...output.metadata,
        durationSeconds: source.durationSeconds,
        path: output.path
      })), join(workingDirectory, "streaming"), {
        ffmpegPath: config.ffmpegPath,
        timeoutMs: config.timeoutMs,
        threads: config.threads,
        maxOutputBytes: packagingBudget,
        logger,
        videoId,
        attempt
      });
      logger.info({
        videoId,
        attempt,
        manifestCount: streaming.manifests.length,
        assetCount: streaming.assets.length
      }, "streaming package validated");
      const streamingAssets = [];
      for (const asset of streaming.assets) {
        const storageKey = `videos/${ownerId}/${videoId}/streaming/${attempt}/${asset.relativePath}`;
        await storage.uploadFile(storageKey, asset.path, asset.contentType);
        outputKeys.push(storageKey);
        streamingAssets.push({
          relativePath: asset.relativePath,
          storageKey,
          contentType: asset.contentType,
          fileSizeBytes: asset.fileSizeBytes
        });
      }
      const manifests = streaming.manifests.map((manifest) => ({
        ...manifest,
        storageKey: `videos/${ownerId}/${videoId}/streaming/${attempt}/${manifest.relativePath}`,
        status: "ready" as const
      }));

      const renditions: OutputRecord[] = outputs.map(({ metadata, storageKey }) => ({
        ...metadata,
        storageKey,
        status: "ready"
      }));
      logger.info({
        videoId,
        attempt,
        fromStatus: "packaging",
        toStatus: "completed",
        renditionCount: renditions.length,
        manifestCount: manifests.length,
        assetCount: streamingAssets.length
      }, "persisting completed video processing status");
      const saved = await WorkerVideo.updateOne(
        { _id: videoId, processingAttempt: attempt, processingStatus: "packaging" },
        {
          $set: {
            processingStatus: "completed",
            streamingStatus: "ready",
            processingError: undefined,
            processingUpdatedAt: new Date(),
            renditions,
            manifests,
            streamingAssets,
            ...(config.intelligenceEnabled ? {
              "transcription.status": "queued",
              "transcription.updatedAt": new Date(),
              "chapterExtraction.status": "queued",
              "chapterExtraction.updatedAt": new Date()
            } : {
              "transcription.status": "unavailable",
              "transcription.error": "AI provider is not configured",
              "chapterExtraction.status": "unavailable",
              "chapterExtraction.error": "AI provider is not configured"
            })
          },
          ...(config.intelligenceEnabled ? {
            $unset: { "transcription.error": 1, "chapterExtraction.error": 1 }
          } : {})
        }
      ).exec();
      logger.info({
        videoId,
        attempt,
        matchedCount: saved.matchedCount,
        processingStatus: saved.matchedCount > 0 ? "completed" : "unchanged"
      }, "completed video processing status update finished");
      if (saved.matchedCount === 0) {
        await Promise.all(outputKeys.map((key) => storage.deleteObject(key)));
        return;
      }
      logger.info({ videoId, attempt, renditionCount: renditions.length }, "video processing completed");
    } catch (error) {
      const jobAttempts = job.opts.attempts ?? 1;
      const finalAttempt = job.attemptsMade + 1 >= jobAttempts;
      if (finalAttempt) {
        const publicError = toPublicProcessingError(error);
        try {
          await WorkerVideo.updateOne(
            { _id: videoId, processingAttempt: attempt },
            {
              $set: {
                processingStatus: "failed",
                streamingStatus: "failed",
                processingError: publicError,
                processingUpdatedAt: new Date(),
                renditions: [],
                manifests: [],
                streamingAssets: []
              }
            }
          ).exec();
        } catch (statusError) {
          logger.error({
            videoId,
            attempt,
            errorType: statusError instanceof Error ? statusError.name : "UnknownError"
          }, "failed to persist terminal processing failure");
        }
      }
      logger.error({
        videoId,
        attempt,
        retryable: !finalAttempt,
        errorType: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        ...(error instanceof Error && typeof (error as MediaCommandError).stderr === "string"
          ? { stderr: (error as MediaCommandError).stderr }
          : {})
      }, "video processing attempt failed");
      const cleanup = await Promise.allSettled(outputKeys.map((key) => storage.deleteObject(key)));
      for (const result of cleanup) {
        if (result.status === "rejected") {
          logger.warn({
            errorType: result.reason instanceof Error ? result.reason.name : "UnknownError"
          }, "failed to remove partial rendition output");
        }
      }
      throw error;
    } finally {
      if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
    }
  };
}

export function selectRenditionHeights(sourceHeight: number, configuredHeights: number[]): number[] {
  const ladder = [...new Set(configuredHeights)]
    .filter((height) => Number.isInteger(height) && height > 0 && height <= 1080)
    .sort((left, right) => right - left);
  const supported = ladder.filter((height) => height <= sourceHeight);
  if (supported.length > 0) return supported;
  return sourceHeight > 0 ? [sourceHeight] : [];
}

export async function reconcileQueuedVideos(
  queue: { add(name: string, data: TranscodeJobData, options: { jobId: string; attempts: number; backoff: { type: "exponential"; delay: number }; removeOnComplete: number; removeOnFail: number }): Promise<unknown> },
  limit = 100
): Promise<number> {
  const videos = await WorkerVideo.find({ uploadStatus: "uploaded", processingStatus: "queued" })
    .select("processingAttempt")
    .sort({ processingUpdatedAt: 1 })
    .limit(limit)
    .lean()
    .exec();
  for (const video of videos) {
    const videoId = video._id.toString();
    await queue.add("transcode-video", { videoId, attempt: video.processingAttempt }, {
      jobId: `${videoId}-${video.processingAttempt}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000
    });
  }
  return videos.length;
}

export async function recoverStaleVideos(staleBefore: Date, limit = 100): Promise<Array<{ videoId: string; attempt: number }>> {
  const stale = await WorkerVideo.find({
    uploadStatus: "uploaded",
    processingStatus: { $in: ["probing", "transcoding", "packaging"] },
    processingUpdatedAt: { $lte: staleBefore }
  }).select("processingAttempt").sort({ processingUpdatedAt: 1 }).limit(limit).lean().exec();
  const recovered: Array<{ videoId: string; attempt: number }> = [];
  for (const video of stale) {
    const videoId = video._id.toString();
    const updated = await WorkerVideo.findOneAndUpdate(
      {
        _id: video._id,
        processingAttempt: video.processingAttempt,
        processingStatus: { $in: ["probing", "transcoding", "packaging"] },
        processingUpdatedAt: { $lte: staleBefore }
      },
      {
        $set: { processingStatus: "queued", processingUpdatedAt: new Date() },
        $inc: { processingAttempt: 1 }
      },
      { new: true }
    ).select("processingAttempt").lean().exec();
    if (updated) recovered.push({ videoId, attempt: updated.processingAttempt });
  }
  return recovered;
}

async function updateStage(videoId: string, attempt: number, stage: ProcessingState): Promise<void> {
  const result = await WorkerVideo.updateOne(
    { _id: videoId, processingAttempt: attempt, processingStatus: { $in: ["queued", "probing", "transcoding", "packaging"] } },
    {
      $set: {
        processingStatus: stage,
        processingUpdatedAt: new Date(),
        ...(stage === "packaging" ? { streamingStatus: "packaging" } : {})
      },
      $min: { processingStartedAt: new Date() }
    }
  ).exec();
  if (result.matchedCount === 0) throw new Error("Processing attempt is no longer current");
}

function assertSafeSourceKey(key: string): void {
  if (!key.startsWith("videos/") || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Uploaded source asset reference is invalid");
  }
}

function toPublicProcessingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown processing failure";
  const safe = raw
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\/)[^"'\r\n]*\1/g, "[temporary media file]")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]*/g, "[temporary media file]")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || "Media processing failed").slice(0, 1000);
}
