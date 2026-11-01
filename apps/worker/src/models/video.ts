import mongoose, { Schema, model, type Model } from "mongoose";
import type { VideoRendition } from "@siv/shared";

export type ProcessingState = "queued" | "probing" | "transcoding" | "packaging" | "completed" | "failed";

export interface WorkerStreamingAsset {
  relativePath: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
}

export interface WorkerManifestRecord extends WorkerStreamingAsset {
  protocol: "hls" | "dash";
  status: "ready";
}

export interface WorkerVideoRecord {
  owner: mongoose.Types.ObjectId;
  uploadStatus: string;
  processingStatus: ProcessingState | "not_started";
  processingAttempt: number;
  streamingStatus: "not_started" | "packaging" | "ready" | "failed";
  processingUpdatedAt?: Date;
  processingStartedAt?: Date;
  originalAssetStorageKey?: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  processingError?: string;
  renditions: Array<VideoRendition & { storageKey: string; status: "ready" }>;
  manifests: WorkerManifestRecord[];
  streamingAssets: WorkerStreamingAsset[];
  transcription: { status: "unavailable" | "queued" | "processing" | "ready" | "failed"; provider?: string; model?: string; error?: string; retryCount: number; updatedAt?: Date };
  chapterExtraction: { status: "unavailable" | "queued" | "processing" | "ready" | "failed"; provider?: string; model?: string; error?: string; retryCount: number; updatedAt?: Date };
  subtitles: Array<{ language: string; storageKey: string; contentType: string; fileSizeBytes: number }>;
}

const renditionSchema = new Schema({
  name: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  codec: { type: String, required: true },
  fileSizeBytes: { type: Number, required: true },
  storageKey: { type: String, required: true, select: false },
  status: { type: String, enum: ["ready"], required: true }
}, { _id: false });

const workerVideoSchema = new Schema<WorkerVideoRecord>({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  uploadStatus: { type: String, required: true },
  processingStatus: { type: String, required: true },
  processingAttempt: { type: Number, required: true },
  streamingStatus: { type: String, enum: ["not_started", "packaging", "ready", "failed"], default: "not_started" },
  processingUpdatedAt: { type: Date },
  processingStartedAt: { type: Date },
  originalAssetStorageKey: { type: String, select: false },
  fileSizeBytes: { type: Number },
  durationSeconds: { type: Number },
  width: { type: Number },
  height: { type: Number },
  videoCodec: { type: String },
  processingError: { type: String },
  renditions: { type: [renditionSchema], default: [] },
  manifests: { type: [new Schema({
    protocol: { type: String, enum: ["hls", "dash"], required: true },
    relativePath: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    contentType: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true },
    status: { type: String, enum: ["ready"], required: true }
  }, { _id: false })], default: [] },
  streamingAssets: { type: [new Schema({
    relativePath: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    contentType: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true }
  }, { _id: false })], default: [] },
  transcription: { type: new Schema({
    status: { type: String, enum: ["unavailable", "queued", "processing", "ready", "failed"], default: "unavailable" },
    provider: { type: String },
    model: { type: String },
    error: { type: String },
    retryCount: { type: Number, default: 0 },
    updatedAt: { type: Date }
  }, { _id: false }), default: () => ({ status: "unavailable", retryCount: 0 }) },
  chapterExtraction: { type: new Schema({
    status: { type: String, enum: ["unavailable", "queued", "processing", "ready", "failed"], default: "unavailable" },
    provider: { type: String },
    model: { type: String },
    error: { type: String },
    retryCount: { type: Number, default: 0 },
    updatedAt: { type: Date }
  }, { _id: false }), default: () => ({ status: "unavailable", retryCount: 0 }) },
  subtitles: { type: [new Schema({
    language: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    contentType: { type: String, required: true },
    fileSizeBytes: { type: Number, required: true }
  }, { _id: false })], default: [] }
}, { collection: "videos", strict: false, versionKey: false });

workerVideoSchema.index({ processingStatus: 1, "transcription.status": 1, "transcription.updatedAt": 1 });

export const WorkerVideo = (mongoose.models.Video as Model<WorkerVideoRecord> | undefined)
  ?? model<WorkerVideoRecord>("Video", workerVideoSchema);
