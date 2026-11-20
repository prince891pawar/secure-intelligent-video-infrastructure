import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Video } from "../models/video.js";
import { MongooseVideoRepository } from "./mongoose-video-repository.js";

afterEach(() => vi.restoreAllMocks());

describe("MongooseVideoRepository", () => {
  it("atomically requeues a stale packaging attempt without changing its original upload", async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const videoId = new mongoose.Types.ObjectId().toString();
    const staleBefore = new Date("2026-11-18T14:00:00.000Z");
    let updateFilter: unknown;
    let updateChanges: unknown;
    const update = vi.spyOn(Video, "findOneAndUpdate").mockImplementation((filter, changes) => {
      updateFilter = filter;
      updateChanges = changes;
      return { exec: async () => ({ processingAttempt: 11 }) } as never;
    });

    await expect(new MongooseVideoRepository().retryProcessing(ownerId, videoId, staleBefore)).resolves.toBe(11);

    expect(update).toHaveBeenCalledOnce();
    expect(updateFilter).toMatchObject({
      _id: videoId,
      owner: ownerId,
      uploadStatus: "uploaded",
      $or: [
        { processingStatus: "failed" },
        {
          processingStatus: { $in: ["probing", "transcoding", "packaging"] },
          processingUpdatedAt: { $lte: staleBefore }
        }
      ]
    });
    expect(updateChanges).toMatchObject({
      $set: {
        processingStatus: "queued",
        streamingStatus: "not_started",
        renditions: [],
        manifests: [],
        streamingAssets: []
      },
      $unset: { processingError: 1, processingStartedAt: 1 },
      $inc: { processingAttempt: 1 }
    });
    const changes = updateChanges as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
    expect(changes.$unset).not.toHaveProperty("originalAssetStorageKey");
    expect(changes.$set).not.toHaveProperty("originalAssetStorageKey");
  });
});
