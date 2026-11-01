import mongoose, { Schema, model, type Model, type Types } from "mongoose";

interface UploadPartRecord {
  partNumber: number;
  sizeBytes: number;
  etag: string;
  checksumSha256: string;
}

interface UploadSessionRecord {
  owner: Types.ObjectId;
  video: Types.ObjectId;
  storageKey: string;
  storageUploadId: string;
  title: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  partSizeBytes: number;
  expectedParts: number;
  transferMode: "proxy" | "presigned";
  status: "initiating" | "uploading" | "completing" | "completed" | "aborted" | "expired" | "failed";
  parts: UploadPartRecord[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const partSchema = new Schema<UploadPartRecord>({
  partNumber: { type: Number, required: true, min: 1, max: 10_000 },
  sizeBytes: { type: Number, required: true, min: 1 },
  etag: { type: String, required: true },
  checksumSha256: { type: String, required: true }
}, { _id: false });

const uploadSessionSchema = new Schema<UploadSessionRecord>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    video: { type: Schema.Types.ObjectId, ref: "Video", required: true },
    storageKey: { type: String, required: true, select: false },
    storageUploadId: { type: String, required: true, select: false },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    fileName: { type: String, required: true, maxlength: 255 },
    contentType: { type: String, enum: ["video/mp4", "video/quicktime", "video/webm"], required: true },
    fileSizeBytes: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER },
    partSizeBytes: { type: Number, required: true, min: 5 * 1024 * 1024 },
    expectedParts: { type: Number, required: true, min: 1, max: 10_000 },
    transferMode: { type: String, enum: ["proxy", "presigned"], required: true },
    status: {
      type: String,
      enum: ["initiating", "uploading", "completing", "completed", "aborted", "expired", "failed"],
      default: "initiating",
      required: true
    },
    parts: { type: [partSchema], default: [] },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true, versionKey: false }
);

uploadSessionSchema.index({ owner: 1, createdAt: -1 });
uploadSessionSchema.index({ expiresAt: 1, status: 1 });

export const UploadSession = (mongoose.models.UploadSession as Model<UploadSessionRecord> | undefined)
  ?? model<UploadSessionRecord>("UploadSession", uploadSessionSchema);
