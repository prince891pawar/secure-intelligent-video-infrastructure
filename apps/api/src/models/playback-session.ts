import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface PlaybackSessionRecord {
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  slot: number;
  status: "active" | "revoked" | "expired";
  expiresAt: Date;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const playbackSessionSchema = new Schema<PlaybackSessionRecord>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
  slot: { type: Number, min: 1, required: true },
  status: { type: String, enum: ["active", "revoked", "expired"], required: true, default: "active" },
  expiresAt: { type: Date, required: true },
  lastActivityAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });

playbackSessionSchema.index(
  { userId: 1, videoId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
playbackSessionSchema.index({ userId: 1, videoId: 1, createdAt: -1 });
playbackSessionSchema.index({ expiresAt: 1 });

export const PlaybackSession = (mongoose.models.PlaybackSession as Model<PlaybackSessionRecord> | undefined)
  ?? model<PlaybackSessionRecord>("PlaybackSession", playbackSessionSchema);
