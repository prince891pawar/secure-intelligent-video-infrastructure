import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface WatchProgressRecord {
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  positionSeconds: number;
  completed: boolean;
  updatedAt: Date;
}

const watchProgressSchema = new Schema<WatchProgressRecord>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
  positionSeconds: { type: Number, min: 0, required: true },
  completed: { type: Boolean, required: true, default: false }
}, { timestamps: true, versionKey: false });

watchProgressSchema.index({ userId: 1, videoId: 1 }, { unique: true });

export const WatchProgress = (mongoose.models.WatchProgress as Model<WatchProgressRecord> | undefined)
  ?? model<WatchProgressRecord>("WatchProgress", watchProgressSchema);
