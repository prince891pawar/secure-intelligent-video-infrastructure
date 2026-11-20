import type { Queue } from "bullmq";

export interface ProcessingQueue {
  enqueue(videoId: string, attempt: number): Promise<void>;
}

export class BullMqProcessingQueue implements ProcessingQueue {
  constructor(private readonly queue: Queue) {}

  async enqueue(videoId: string, attempt: number): Promise<void> {
    const jobId = `${videoId}-${attempt}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      } else {
        return;
      }
    }
    await this.queue.add(
      "transcode-video",
      { videoId, attempt },
      {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail: 1_000
      }
    );
  }
}
