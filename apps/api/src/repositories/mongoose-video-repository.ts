import { Types } from "mongoose";
import type { VideoListItem, VideoProcessingStatus } from "@siv/shared";
import { Video } from "../models/video.js";

export interface VideoRepository {
  listByOwner(ownerId: string, limit: number): Promise<VideoListItem[]>;
  createPending(ownerId: string, title: string, description?: string): Promise<string>;
  markUploaded(id: string, storageKey: string, sizeBytes: number): Promise<number>;
  markUploadFailed(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  getProcessingStatus(ownerId: string, videoId: string): Promise<VideoProcessingStatus | null>;
  getQueuedAttempt(videoId: string): Promise<number | null>;
  retryProcessing(ownerId: string, videoId: string): Promise<number | null>;
}

export class MongooseVideoRepository implements VideoRepository {
  async createPending(ownerId: string, title: string, description?: string): Promise<string> {
    const video = await Video.create({
      owner: ownerId,
      title,
      ...(description === undefined ? {} : { description }),
      uploadStatus: "uploading",
      processingStatus: "not_started",
      visibility: "private"
    });
    return video.id;
  }

  async markUploaded(id: string, storageKey: string, sizeBytes: number): Promise<number> {
    const now = new Date();
    const changed = await Video.findOneAndUpdate(
      { _id: id, uploadStatus: { $ne: "uploaded" } },
      {
        $set: {
          uploadStatus: "uploaded",
          processingStatus: "queued",
          processingUpdatedAt: now,
          originalAssetStorageKey: storageKey,
          fileSizeBytes: sizeBytes
        },
        $inc: { processingAttempt: 1 }
      },
      { new: true }
    ).exec();
    if (changed) return changed.processingAttempt;

    const existing = await Video.findById(id).select("processingAttempt").exec();
    if (!existing) throw new Error("Video record disappeared during upload completion");
    return existing.processingAttempt;
  }

  async markUploadFailed(id: string): Promise<void> {
    await Video.updateOne({ _id: id }, { $set: { uploadStatus: "failed" } }).exec();
  }

  async delete(id: string): Promise<void> {
    await Video.deleteOne({ _id: id }).exec();
  }

  async getProcessingStatus(ownerId: string, videoId: string): Promise<VideoProcessingStatus | null> {
    if (!Types.ObjectId.isValid(ownerId) || !Types.ObjectId.isValid(videoId)) return null;
    const video = await Video.findOne({ _id: videoId, owner: ownerId })
      .select("processingStatus streamingStatus processingError processingAttempt durationSeconds width height videoCodec renditions manifests")
      .lean()
      .exec();
    if (!video) return null;
    return {
      videoId: video._id.toString(),
      processingStatus: video.processingStatus,
      streamingStatus: video.streamingStatus,
      ...(video.processingError ? { processingError: video.processingError } : {}),
      processingAttempt: video.processingAttempt,
      ...(video.durationSeconds === undefined ? {} : { durationSeconds: video.durationSeconds }),
      ...(video.width === undefined ? {} : { width: video.width }),
      ...(video.height === undefined ? {} : { height: video.height }),
      ...(video.videoCodec ? { videoCodec: video.videoCodec } : {}),
      renditions: video.renditions.map(({ name, width, height, codec, fileSizeBytes }) => ({
        name, width, height, codec, fileSizeBytes
      }))
    };
  }

  async getQueuedAttempt(videoId: string): Promise<number | null> {
    const video = await Video.findOne({ _id: videoId, uploadStatus: "uploaded", processingStatus: "queued" })
      .select("processingAttempt")
      .lean()
      .exec();
    return video?.processingAttempt ?? null;
  }

  async retryProcessing(ownerId: string, videoId: string): Promise<number | null> {
    if (!Types.ObjectId.isValid(ownerId) || !Types.ObjectId.isValid(videoId)) return null;
    const now = new Date();
    const retried = await Video.findOneAndUpdate(
      { _id: videoId, owner: ownerId, uploadStatus: "uploaded", processingStatus: "failed" },
      {
        $set: {
          processingStatus: "queued",
          streamingStatus: "not_started",
          processingUpdatedAt: now,
          renditions: [],
          manifests: [],
          streamingAssets: []
        },
        $unset: { processingError: 1, processingStartedAt: 1 },
        $inc: { processingAttempt: 1 }
      },
      { new: true }
    ).exec();
    if (retried) return retried.processingAttempt;

    const existing = await Video.findOne({ _id: videoId, owner: ownerId, uploadStatus: "uploaded" })
      .select("processingStatus processingAttempt")
      .lean()
      .exec();
    if (!existing) return null;
    return existing.processingStatus === "queued" ? existing.processingAttempt : -1;
  }

  async listByOwner(ownerId: string, limit: number): Promise<VideoListItem[]> {
    const videos = await Video.find({ owner: ownerId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("title description uploadStatus processingStatus streamingStatus maxConcurrentPlaybackSessions processingError durationSeconds width height fileSizeBytes visibility createdAt")
      .lean()
      .exec();

    return videos.map((video) => ({
      id: video._id.toString(),
      title: video.title,
      ...(video.description === undefined ? {} : { description: video.description }),
      uploadStatus: video.uploadStatus,
      processingStatus: video.processingStatus,
      streamingStatus: video.streamingStatus,
      maxConcurrentPlaybackSessions: video.maxConcurrentPlaybackSessions,
      ...(video.processingError ? { processingError: video.processingError } : {}),
      ...(video.durationSeconds === undefined ? {} : { durationSeconds: video.durationSeconds }),
      ...(video.width === undefined ? {} : { width: video.width }),
      ...(video.height === undefined ? {} : { height: video.height }),
      ...(video.fileSizeBytes === undefined ? {} : { fileSizeBytes: video.fileSizeBytes }),
      visibility: video.visibility,
      createdAt: video.createdAt.toISOString()
    }));
  }
}
