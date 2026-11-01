import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface PlaybackEventRecord {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  eventId: string;
  type: "start" | "progress" | "complete" | "error";
  currentTimeSeconds: number;
  durationSeconds?: number;
  errorCode?: string;
  occurredAt: Date;
  createdAt: Date;
}

const playbackEventSchema = new Schema<PlaybackEventRecord>({
  sessionId: { type: Schema.Types.ObjectId, ref: "PlaybackSession", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
  eventId: { type: String, required: true, maxlength: 64 },
  type: { type: String, enum: ["start", "progress", "complete", "error"], required: true },
  currentTimeSeconds: { type: Number, min: 0, required: true },
  durationSeconds: { type: Number, min: 0 },
  errorCode: { type: String, maxlength: 80 },
  occurredAt: { type: Date, required: true }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

playbackEventSchema.index({ sessionId: 1, eventId: 1 }, { unique: true });
playbackEventSchema.index({ videoId: 1, type: 1, occurredAt: -1 });
playbackEventSchema.index({ userId: 1, videoId: 1, occurredAt: -1 });

export const PlaybackEvent = (mongoose.models.PlaybackEvent as Model<PlaybackEventRecord> | undefined)
  ?? model<PlaybackEventRecord>("PlaybackEvent", playbackEventSchema);
