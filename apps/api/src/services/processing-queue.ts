import type { Queue } from "bullmq";

export interface ProcessingQueue {
  enqueue(videoId: string, attempt: number): Promise<void>;
}

export class BullMqProcessingQueue implements ProcessingQueue {
  constructor(private readonly queue: Queue) {}

  async enqueue(videoId: string, attempt: number): Promise<void> {
    await this.queue.add(
      "transcode-video",
      { videoId, attempt },
      {
        jobId: `${videoId}-${attempt}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail: 1_000
      }
    );
  }
}
