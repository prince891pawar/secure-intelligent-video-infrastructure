import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface TranscriptSegmentRecord {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
}

export interface TranscriptChunkRecord {
  startSeconds: number;
  endSeconds: number;
  text: string;
  embedding?: number[];
}

export interface TranscriptRecord {
  videoId: Types.ObjectId;
  language: string;
  provider: string;
  model: string;
  embeddingModel: string;
  segments: TranscriptSegmentRecord[];
  chunks: TranscriptChunkRecord[];
  chapters: Array<{ startSeconds: number; endSeconds: number; title: string; summary?: string }>;
  topics: Array<{ name: string; keywords: string[]; startSeconds: number; endSeconds: number }>;
  createdAt: Date;
  updatedAt: Date;
}

const transcriptSegmentSchema = new Schema<TranscriptSegmentRecord>({
  startSeconds: { type: Number, min: 0, required: true },
  endSeconds: { type: Number, min: 0, required: true },
  text: { type: String, trim: true, required: true, maxlength: 5000 },
  speaker: { type: String, trim: true, maxlength: 80 }
}, { _id: false });

const transcriptChunkSchema = new Schema<TranscriptChunkRecord>({
  startSeconds: { type: Number, min: 0, required: true },
  endSeconds: { type: Number, min: 0, required: true },
  text: { type: String, trim: true, required: true, maxlength: 8000 },
  embedding: { type: [Number], select: false }
}, { _id: false });

const chapterSchema = new Schema({
  startSeconds: { type: Number, min: 0, required: true },
  endSeconds: { type: Number, min: 0, required: true },
  title: { type: String, trim: true, required: true, maxlength: 120 },
  summary: { type: String, trim: true, maxlength: 500 }
}, { _id: false });

const topicSchema = new Schema({
  name: { type: String, trim: true, required: true, maxlength: 100 },
  keywords: { type: [String], default: [] },
  startSeconds: { type: Number, min: 0, required: true },
  endSeconds: { type: Number, min: 0, required: true }
}, { _id: false });

const transcriptSchema = new Schema<TranscriptRecord>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, unique: true },
  language: { type: String, required: true, maxlength: 16 },
  provider: { type: String, required: true, maxlength: 80 },
  model: { type: String, required: true, maxlength: 80 },
  embeddingModel: { type: String, required: true, maxlength: 80 },
  segments: { type: [transcriptSegmentSchema], default: [] },
  chunks: { type: [transcriptChunkSchema], default: [] },
  chapters: { type: [chapterSchema], default: [] },
  topics: { type: [topicSchema], default: [] }
}, { timestamps: true, versionKey: false });

transcriptSchema.index({ videoId: 1 }, { unique: true });

export const Transcript = (mongoose.models.Transcript as Model<TranscriptRecord> | undefined)
  ?? model<TranscriptRecord>("Transcript", transcriptSchema);
