import mongoose, { Schema, model, type Model, type Types } from "mongoose";

interface RenditionRecord {
  name: string;
  width: number;
  height: number;
  codec: string;
  fileSizeBytes: number;
  storageKey: string;
  status: "ready";
}

interface ManifestRecord {
  protocol: "hls" | "dash";
  relativePath: string;
  storageKey: string;
  contentType: string;
  status: "ready";
  fileSizeBytes: number;
}

interface StreamingAssetRecord {
  relativePath: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
}

interface SubtitleAssetRecord {
  language: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
}

interface IntelligenceJobRecord {
  status: "unavailable" | "queued" | "processing" | "ready" | "failed";
  provider?: string;
  model?: string;
  error?: string;
  retryCount: number;
  updatedAt?: Date;
}

interface VideoRecord {
  owner: Types.ObjectId;
  title: string;
  description?: string;
  uploadStatus: "awaiting_upload" | "uploading" | "uploaded" | "failed";
  processingStatus: "not_started" | "queued" | "probing" | "transcoding" | "packaging" | "completed" | "failed";
  streamingStatus: "not_started" | "packaging" | "ready" | "failed";
  processingError?: string;
  processingAttempt: number;
  processingUpdatedAt?: Date;
  processingStartedAt?: Date;
  originalAssetStorageKey?: string;
  renditions: RenditionRecord[];
  manifests: ManifestRecord[];
  streamingAssets: StreamingAssetRecord[];
  subtitles: SubtitleAssetRecord[];
  transcription: IntelligenceJobRecord;
  chapterExtraction: IntelligenceJobRecord;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  fileSizeBytes?: number;
  visibility: "private" | "unlisted" | "public";
  maxConcurrentPlaybackSessions?: number;
  createdAt: Date;
  updatedAt: Date;
}

const renditionSchema = new Schema<RenditionRecord>(
  {
    name: { type: String, required: true, trim: true, maxlength: 32 },
    width: { type: Number, min: 1, max: 16384 },
    height: { type: Number, min: 1, max: 16384 },
    codec: { type: String, required: true, maxlength: 32 },
    fileSizeBytes: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER },
    storageKey: { type: String, required: true, select: false },
    status: { type: String, enum: ["ready"], required: true }
  },
  { _id: false }
);

const manifestSchema = new Schema<ManifestRecord>(
  {
    protocol: { type: String, enum: ["hls", "dash"], required: true },
    relativePath: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    contentType: { type: String, required: true },
    status: { type: String, enum: ["ready"], required: true },
    fileSizeBytes: { type: Number, required: true, min: 1 }
  },
  { _id: false }
);

const streamingAssetSchema = new Schema<StreamingAssetRecord>({
  relativePath: { type: String, required: true },
  storageKey: { type: String, required: true, select: false },
  contentType: { type: String, required: true },
  fileSizeBytes: { type: Number, required: true, min: 1 }
}, { _id: false });

const subtitleAssetSchema = new Schema<SubtitleAssetRecord>({
  language: { type: String, required: true, maxlength: 16 },
  storageKey: { type: String, required: true, select: false },
  contentType: { type: String, enum: ["text/vtt"], required: true },
  fileSizeBytes: { type: Number, min: 1, required: true }
}, { _id: false });

const intelligenceJobSchema = new Schema<IntelligenceJobRecord>({
  status: { type: String, enum: ["unavailable", "queued", "processing", "ready", "failed"], required: true, default: "unavailable" },
  provider: { type: String, maxlength: 80 },
  model: { type: String, maxlength: 80 },
  error: { type: String, maxlength: 500 },
  retryCount: { type: Number, min: 0, default: 0, required: true },
  updatedAt: { type: Date }
}, { _id: false });

const videoSchema = new Schema<VideoRecord>(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000
    },
    uploadStatus: {
      type: String,
      enum: ["awaiting_upload", "uploading", "uploaded", "failed"],
      default: "awaiting_upload",
      required: true
    },
    processingStatus: {
      type: String,
      enum: ["not_started", "queued", "probing", "transcoding", "packaging", "completed", "failed"],
      default: "not_started",
      required: true
    },
    streamingStatus: {
      type: String,
      enum: ["not_started", "packaging", "ready", "failed"],
      default: "not_started",
      required: true
    },
    processingError: { type: String, maxlength: 1000 },
    processingAttempt: { type: Number, min: 0, default: 0, required: true },
    processingUpdatedAt: { type: Date },
    processingStartedAt: { type: Date },
    originalAssetStorageKey: {
      type: String,
      select: false
    },
    renditions: {
      type: [renditionSchema],
      default: []
    },
    manifests: {
      type: [manifestSchema],
      default: []
    },
    streamingAssets: { type: [streamingAssetSchema], default: [] },
    subtitles: { type: [subtitleAssetSchema], default: [] },
    transcription: { type: intelligenceJobSchema, default: () => ({ status: "unavailable", retryCount: 0 }) },
    chapterExtraction: { type: intelligenceJobSchema, default: () => ({ status: "unavailable", retryCount: 0 }) },
    durationSeconds: { type: Number, min: 0, max: 31_536_000 },
    width: { type: Number, min: 1, max: 16384 },
    height: { type: Number, min: 1, max: 16384 },
    videoCodec: { type: String, maxlength: 32 },
    fileSizeBytes: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER },
    visibility: {
      type: String,
      enum: ["private", "unlisted", "public"],
      default: "private",
      required: true
    },
    maxConcurrentPlaybackSessions: { type: Number, min: 1, max: 20, default: 2, required: true }
  },
  { timestamps: true, versionKey: false }
);

videoSchema.index({ owner: 1, createdAt: -1 });
videoSchema.index({ owner: 1, uploadStatus: 1, processingStatus: 1 });
videoSchema.index({ processingStatus: 1, processingUpdatedAt: 1 });
videoSchema.index({ processingStatus: 1, "transcription.status": 1, "transcription.updatedAt": 1 });

export const Video = (mongoose.models.Video as Model<VideoRecord> | undefined) ?? model<VideoRecord>("Video", videoSchema);
