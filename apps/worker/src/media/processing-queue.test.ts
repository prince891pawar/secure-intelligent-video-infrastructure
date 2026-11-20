import { describe, expect, it } from "vitest";
import { enqueueProcessingJob } from "./video-processor.js";

describe("worker processing queue reconciliation", () => {
  it("replaces a retained terminal job but leaves an active job alone", async () => {
    const events: string[] = [];
    const queue = {
      async getJob() {
        return {
          async getState() { return "completed"; },
          async remove() { events.push("remove"); }
        };
      },
      async add(_name: string, _data: unknown, options: { jobId: string }) {
        events.push(`add:${options.jobId}`);
      }
    };

    await enqueueProcessingJob(queue, "video-id", 8);

    expect(events).toEqual(["remove", "add:video-id-8"]);
  });
});
