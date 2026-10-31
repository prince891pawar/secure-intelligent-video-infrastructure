import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createApp } from "./app.js";

const servers: Array<ReturnType<ReturnType<typeof createApp>["listen"]>> = [];

async function startServer(mongodb: boolean, redis: boolean) {
  const app = createApp(
    { mongodb: () => mongodb, redis: () => redis },
    pino({ level: "silent" }),
    "http://localhost:5173"
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  ));
});

describe("health endpoints", () => {
  it("reports liveness and assigns a request ID", async () => {
    const baseUrl = await startServer(true, true);
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("reports readiness only when all dependencies are available", async () => {
    const baseUrl = await startServer(true, false);
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      dependencies: { mongodb: true, redis: false }
    });
  });

  it("returns ready when MongoDB and Redis probes succeed", async () => {
    const baseUrl = await startServer(true, true);
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      dependencies: { mongodb: true, redis: true }
    });
  });
});
