import mongoose, { Schema, model, type Model } from "mongoose";

export interface WorkerTranscriptRecord {
  videoId: mongoose.Types.ObjectId;
  language: string;
  provider: string;
  model: string;
  embeddingModel: string;
  segments: Array<{ startSeconds: number; endSeconds: number; text: string; speaker?: string }>;
  chunks: Array<{ startSeconds: number; endSeconds: number; text: string; embedding?: number[] }>;
  chapters: Array<{ startSeconds: number; endSeconds: number; title: string; summary?: string }>;
  topics: Array<{ name: string; keywords: string[]; startSeconds: number; endSeconds: number }>;
}

const transcriptSchema = new Schema<WorkerTranscriptRecord>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
  language: { type: String, required: true, maxlength: 16 },
  provider: { type: String, required: true, maxlength: 80 },
  model: { type: String, required: true, maxlength: 80 },
  embeddingModel: { type: String, required: true, maxlength: 80 },
  segments: { type: [new Schema({
    startSeconds: { type: Number, min: 0, required: true },
    endSeconds: { type: Number, min: 0, required: true },
    text: { type: String, trim: true, required: true, maxlength: 5000 },
    speaker: { type: String, trim: true, maxlength: 80 }
  }, { _id: false })], default: [] },
  chunks: { type: [new Schema({
    startSeconds: { type: Number, min: 0, required: true },
    endSeconds: { type: Number, min: 0, required: true },
    text: { type: String, trim: true, required: true, maxlength: 8000 },
    embedding: { type: [Number], select: false }
  }, { _id: false })], default: [] },
  chapters: { type: [new Schema({
    startSeconds: { type: Number, min: 0, required: true },
    endSeconds: { type: Number, min: 0, required: true },
    title: { type: String, trim: true, required: true, maxlength: 120 },
    summary: { type: String, trim: true, maxlength: 500 }
  }, { _id: false })], default: [] },
  topics: { type: [new Schema({
    name: { type: String, trim: true, required: true, maxlength: 100 },
    keywords: { type: [String], default: [] },
    startSeconds: { type: Number, min: 0, required: true },
    endSeconds: { type: Number, min: 0, required: true }
  }, { _id: false })], default: [] }
}, { collection: "transcripts", timestamps: true, versionKey: false });

transcriptSchema.index({ videoId: 1 }, { unique: true });

export const WorkerTranscript = (mongoose.models.Transcript as Model<WorkerTranscriptRecord> | undefined)
  ?? model<WorkerTranscriptRecord>("Transcript", transcriptSchema);
