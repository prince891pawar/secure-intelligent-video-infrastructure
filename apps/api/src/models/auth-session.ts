import mongoose, { Schema, model, type Model, type Types } from "mongoose";

interface AuthSessionRecord {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

const authSessionSchema = new Schema<AuthSessionRecord>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false
    },
    expiresAt: {
      type: Date,
      required: true
    },
    revokedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authSessionSchema.index({ userId: 1, revokedAt: 1 });

export const AuthSession = (mongoose.models.AuthSession as Model<AuthSessionRecord> | undefined)
  ?? model<AuthSessionRecord>("AuthSession", authSessionSchema);
