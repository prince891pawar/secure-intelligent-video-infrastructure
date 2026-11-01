import { describe, expect, it } from "vitest";
import { AuthSession } from "./auth-session.js";
import { User } from "./user.js";
import { Video } from "./video.js";

describe("Mongoose metadata schemas", () => {
  it("normalizes email and defaults registered users to the least-privileged role", async () => {
    const user = new User({
      email: " OWNER@EXAMPLE.COM ",
      passwordHash: `$2b$12$${"a".repeat(53)}`,
      displayName: " Owner "
    });

    expect(user.email).toBe("owner@example.com");
    expect(user.displayName).toBe("Owner");
    expect(user.role).toBe("user");
    await expect(user.validate()).resolves.toBeUndefined();

    const plaintextPassword = new User({
      email: "other@example.com",
      passwordHash: "plaintext",
      displayName: "Other"
    });
    await expect(plaintextPassword.validate()).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("excludes password and session token hashes from default selection", () => {
    expect(User.schema.path("passwordHash").options.select).toBe(false);
    expect(AuthSession.schema.path("tokenHash").options.select).toBe(false);
    expect(AuthSession.schema.indexes()).toContainEqual([
      { expiresAt: 1 },
      { expireAfterSeconds: 0 }
    ]);
  });

  it("defaults new videos to unprocessed and private without fabricated assets", () => {
    const video = new Video({ owner: "507f1f77bcf86cd799439011", title: "Video" });

    expect(video.uploadStatus).toBe("awaiting_upload");
    expect(video.processingStatus).toBe("not_started");
    expect(video.visibility).toBe("private");
    expect(video.renditions).toHaveLength(0);
    expect(video.manifests).toHaveLength(0);
    expect(Video.schema.indexes()).toContainEqual([{ owner: 1, createdAt: -1 }, {}]);
  });
});
