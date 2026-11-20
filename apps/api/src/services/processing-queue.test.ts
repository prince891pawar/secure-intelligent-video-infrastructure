import { describe, expect, it, vi } from "vitest";
import { BullMqProcessingQueue } from "./processing-queue.js";

describe("BullMqProcessingQueue", () => {
  it("removes retained terminal jobs before reusing their deterministic ID", async () => {
    const remove = vi.fn(async () => undefined);
    const add = vi.fn(async () => undefined);
    const queue = {
      getJob: vi.fn(async () => ({ getState: async () => "completed", remove })),
      add
    };

    await new BullMqProcessingQueue(queue as never).enqueue("video-id", 4);

    expect(remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("transcode-video", { videoId: "video-id", attempt: 4 }, expect.objectContaining({
      jobId: "video-id-4"
    }));
  });

  it("does not duplicate jobs that are already active or waiting", async () => {
    const remove = vi.fn(async () => undefined);
    const add = vi.fn(async () => undefined);
    const queue = {
      getJob: vi.fn(async () => ({ getState: async () => "active", remove })),
      add
    };

    await new BullMqProcessingQueue(queue as never).enqueue("video-id", 4);

    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
