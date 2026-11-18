import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { UploadSession } from "../models/upload-session.js";
import { MongooseUploadSessionRepository } from "./mongoose-upload-repository.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MongooseUploadSessionRepository", () => {
  it("maps owner and video references to the required schema fields", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const videoId = new mongoose.Types.ObjectId().toString();
    const persistenceBoundary = new Error("stop after schema validation");
    const create = vi.spyOn(UploadSession, "create").mockImplementation(async (input) => {
      const session = new UploadSession(input);
      await session.validate();
      throw persistenceBoundary;
    });

    await expect(new MongooseUploadSessionRepository().create({
      ownerId,
      videoId,
      storageKey: `videos/${ownerId}/${videoId}/original`,
      storageUploadId: crypto.randomUUID(),
      title: "Test upload",
      fileName: "sample.mp4",
      contentType: "video/mp4",
      fileSizeBytes: 20_700_000,
      partSizeBytes: 16 * 1024 * 1024,
      expectedParts: 2,
      transferMode: "proxy",
      status: "uploading",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    })).rejects.toBe(persistenceBoundary);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      owner: ownerId,
      video: videoId,
      fileSizeBytes: 20_700_000,
      parts: [],
      status: "uploading"
    }));
  });
});
