export interface HealthResponse {
  status: "ok";
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  dependencies: {
    mongodb: boolean;
    redis: boolean;
  };
}
