import type { Queue } from "bullmq";
import type { VideoIntelligenceQueue } from "./video-intelligence-service.js";

export class BullMqVideoIntelligenceQueue implements VideoIntelligenceQueue {
  constructor(private readonly queue: Queue) {}

  async enqueue(videoId: string, retryCount: number): Promise<void> {
    await this.queue.add(
      "transcribe-video",
      { videoId, retryCount },
      {
        jobId: `${videoId}-intelligence-${retryCount}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 1000
      }
    );
  }
}
