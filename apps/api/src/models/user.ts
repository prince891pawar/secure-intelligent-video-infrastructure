import mongoose, { Schema, model, type Model } from "mongoose";

interface UserRecord {
  email: string;
  passwordHash: string;
  displayName: string;
  role: "user" | "admin";
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserRecord>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      unique: true,
      index: true
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
      match: /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 80
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
      required: true
    }
  },
  { timestamps: true, versionKey: false }
);

userSchema.index({ createdAt: -1 });

export const User = (mongoose.models.User as Model<UserRecord> | undefined) ?? model<UserRecord>("User", userSchema);
