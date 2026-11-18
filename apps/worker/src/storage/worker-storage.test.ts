import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerStorage } from "./worker-storage.js";

describe("worker local storage", () => {
  it("downloads an uploaded object through paths containing spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "siv local storage with spaces-"));
    const storage = new WorkerStorage({
      provider: "local",
      localRoot: root,
      bucket: "",
      region: "us-east-1",
      forcePathStyle: false
    });
    const key = "videos/owner/video/original";
    const objectPath = join(root, "videos", "owner", "video", "original");
    const destination = join(root, "processing temp with spaces", "source.media");

    try {
      await mkdir(dirname(objectPath), { recursive: true });
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(objectPath, "verified upload");

      await storage.downloadObject(key, destination);

      await expect(readFile(destination, "utf8")).resolves.toBe("verified upload");
    } finally {
      storage.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
