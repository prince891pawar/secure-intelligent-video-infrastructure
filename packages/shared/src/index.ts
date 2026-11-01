import { z } from "zod";

export interface HealthResponse {
  status: "ok";
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  dependencies: {
    mongodb: boolean;
    redis: boolean;
  };
}

export interface MediaAssetStorage {
  downloadObject(key: string, destinationPath: string): Promise<void>;
  uploadFile(key: string, sourcePath: string, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export * from "./intelligence.js";

export const registerRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string()
    .min(12)
    .max(72)
    .refine((value) => new TextEncoder().encode(value).length <= 72, "Password must not exceed 72 UTF-8 bytes"),
  displayName: z.string().trim().min(1).max(80)
}).strict();

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string()
    .min(1)
    .max(72)
    .refine((value) => new TextEncoder().encode(value).length <= 72, "Password exceeds supported length")
}).strict();

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  role: z.enum(["user", "admin"]),
  createdAt: z.iso.datetime()
});

export const videoListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  uploadStatus: z.enum(["awaiting_upload", "uploading", "uploaded", "failed"]),
  processingStatus: z.enum(["not_started", "queued", "probing", "transcoding", "packaging", "completed", "failed"]),
  streamingStatus: z.enum(["not_started", "packaging", "ready", "failed"]),
  maxConcurrentPlaybackSessions: z.number().int().min(1).max(20).optional(),
  processingError: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fileSizeBytes: z.number().int().nonnegative().optional(),
  visibility: z.enum(["private", "unlisted", "public"]),
  createdAt: z.iso.datetime()
});

export const videoRenditionSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  codec: z.string(),
  fileSizeBytes: z.number().int().positive()
});

export const videoProcessingStatusSchema = z.object({
  videoId: z.string(),
  processingStatus: z.enum(["not_started", "queued", "probing", "transcoding", "packaging", "completed", "failed"]),
  streamingStatus: z.enum(["not_started", "packaging", "ready", "failed"]),
  processingError: z.string().optional(),
  processingAttempt: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().optional(),
  renditions: z.array(videoRenditionSchema)
});

export const createUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  fileSizeBytes: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional()
}).strict();

export const uploadPartNumberSchema = z.coerce.number().int().min(1).max(10_000);

export const uploadSessionStatusSchema = z.enum([
  "initiating",
  "uploading",
  "completing",
  "completed",
  "aborted",
  "expired",
  "failed"
]);

export const uploadedPartSchema = z.object({
  partNumber: uploadPartNumberSchema,
  sizeBytes: z.number().int().positive(),
  etag: z.string().min(1),
  checksumSha256: z.string().min(1)
});

export const uploadSessionResponseSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  title: z.string(),
  fileName: z.string(),
  contentType: z.enum(["video/mp4", "video/quicktime", "video/webm"]),
  fileSizeBytes: z.number().int().positive(),
  partSizeBytes: z.number().int().positive(),
  expectedParts: z.number().int().positive(),
  status: uploadSessionStatusSchema,
  transferMode: z.enum(["proxy", "presigned"]),
  parts: z.array(uploadedPartSchema),
  expiresAt: z.iso.datetime()
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type VideoListItem = z.infer<typeof videoListItemSchema>;
export type VideoProcessingStatus = z.infer<typeof videoProcessingStatusSchema>;
export type VideoRendition = z.infer<typeof videoRenditionSchema>;
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;
export type UploadSessionResponse = z.infer<typeof uploadSessionResponseSchema>;
export type UploadedPart = z.infer<typeof uploadedPartSchema>;
