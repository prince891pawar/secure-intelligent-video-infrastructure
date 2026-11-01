import mongoose, { Schema, model, type Model, type Types } from "mongoose";

export interface SecuritySignalRecord {
  videoId: Types.ObjectId;
  sessionId?: Types.ObjectId;
  type: "rapid_seek" | "concurrent_session_limit";
  severity: "low" | "medium" | "high";
  observedAt: Date;
  evidence: {
    count: number;
    windowSeconds: number;
    currentPositionSeconds?: number;
    previousPositionSeconds?: number;
  };
}

const securitySignalSchema = new Schema<SecuritySignalRecord>({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true },
  sessionId: { type: Schema.Types.ObjectId, ref: "PlaybackSession" },
  type: { type: String, enum: ["rapid_seek", "concurrent_session_limit"], required: true },
  severity: { type: String, enum: ["low", "medium", "high"], required: true },
  observedAt: { type: Date, required: true },
  evidence: {
    count: { type: Number, min: 1, required: true },
    windowSeconds: { type: Number, min: 1, required: true },
    currentPositionSeconds: { type: Number, min: 0 },
    previousPositionSeconds: { type: Number, min: 0 }
  }
}, { versionKey: false });

securitySignalSchema.index({ videoId:  1, observedAt: -1 });
securitySignalSchema.index({ sessionId: 1, type: 1, observedAt: -1 });

export const SecuritySignal = (mongoose.models.SecuritySignal as Model<SecuritySignalRecord> | undefined)
  ?? model<SecuritySignalRecord>("SecuritySignal", securitySignalSchema);
