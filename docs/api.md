# API contract

Base URL in local development: `http://localhost:4000`.

## Implemented in Phase 1

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| GET | `/health` | Process liveness; does not imply dependencies are ready. | `200 { "status": "ok" }` |
| GET | `/ready` | MongoDB and Redis readiness probes. | `200` when both are ready; otherwise `503` with dependency booleans. |

Every response includes an `x-request-id`. The API restricts browser CORS to the configured `WEB_ORIGIN`. Errors are handled centrally and do not expose internal exception messages.

## Planned (not implemented)

Upload sessions/parts, video metadata, processing status, signed playback authorization, analytics, watch progress, transcripts, search and Q&A endpoints will be added only with authentication, ownership checks, request schemas and tests. No placeholder endpoint implies these capabilities are available.
