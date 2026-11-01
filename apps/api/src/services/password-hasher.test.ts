import { describe, expect, it } from "vitest";
import { passwordHasher } from "./password-hasher.js";

describe("bcrypt password hashing", () => {
  it("stores a bcrypt hash and verifies only the matching password", async () => {
    const hash = await passwordHasher.hash("correct horse battery staple");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain("correct horse battery staple");
    await expect(passwordHasher.verify("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(passwordHasher.verify("wrong password", hash)).resolves.toBe(false);
  });
});
