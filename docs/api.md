# API contract

Base URL in local development: `http://localhost:4000`.

## Liveness and readiness

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| GET | `/health` | Process liveness; does not imply dependencies are ready. | `200 { "status": "ok" }` |
| GET | `/ready` | MongoDB and Redis readiness probes. | `200` when both are ready; otherwise `503` with dependency booleans. |

Every response includes an `x-request-id`. The API restricts browser CORS to the configured `WEB_ORIGIN`. Errors are handled centrally and do not expose internal exception messages.

## Implemented authentication and metadata

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| POST | `/api/auth/register` | Register a user; returns safe profile and sets an HttpOnly session cookie. | `201`; `400` invalid input; `409` duplicate email; `429` rate limit. |
| POST | `/api/auth/login` | Verify credentials and issue a new server-side session. | `200`; generic `401` invalid credentials; `400` invalid input; `429` rate limit. |
| GET | `/api/auth/me` | Return only the authenticated user's safe profile. | `200`; `401` absent, expired, or revoked session. |
| POST | `/api/auth/logout` | Revoke the current session and clear its cookie. | `204`; `401` unauthenticated. |
| GET | `/api/videos` | List the authenticated user's metadata only (maximum 50), including processing/streaming state and safe error text. | `200`; `401` unauthenticated. |
| GET | `/api/videos/:videoId/processing` | Return the authenticated owner's processing state, attempt, probe metadata and verified rendition metadata (no storage keys). | `200`; `404` not owned/not found. |
| POST | `/api/videos/:videoId/retry` | Retry a failed processing job or idempotently return the already queued attempt. Requires exact `Origin`. | `202`; `404` not owned/not found; `409` current state not retryable; `429` rate limit. |

Auth state-changing requests require an exact `Origin` match to `WEB_ORIGIN`. Browser clients must send credentials (`credentials: "include"`). Session cookies are HttpOnly, SameSite=Lax and Secure in production. The API stores only a SHA-256 hash of each random session token; expiration is checked on every authenticated request and revocation is immediate. Password hashes are never serialized.

The account and video routes are backed by Mongoose in the API process. Automated auth/API behavior tests currently use an in-memory repository because the local Docker MongoDB service is unavailable; they are not MongoDB integration tests.

## Resumable uploads

All routes below are mounted at `/api/uploads`, require an authenticated user and check session ownership. State-changing requests require the configured exact `Origin`; browser requests must use credentials. API CORS allows the configured web origin, credentials, `PUT`/`DELETE`, and the `X-Part-Sha256` request header.

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| POST | `/api/uploads` | Create a persisted session and pending Video using `fileName`, `contentType`, `fileSizeBytes`, `title`, optional `description`. | `201`; `400` invalid input; `413` over configured limit. |
| GET | `/api/uploads/:sessionId` | Fetch authoritative session status; refreshes part listing from storage. | `200`; `404` not owned/not found; `410` expired/unavailable. |
| GET | `/api/uploads/:sessionId/parts` | List server-confirmed uploaded parts. | `200`; `404` not owned/not found. |
| POST | `/api/uploads/:sessionId/parts/:partNumber/authorize` | For S3, request a short-lived URL bound to the server-calculated expected part length and SHA-256 checksum. | `200`; `400` invalid part/checksum; `404` not owned; `410` expired. |
| PUT | `/api/uploads/:sessionId/parts/:partNumber` | Stream one local/proxy part as `application/octet-stream`; requires `Content-Length`, optional `X-Part-Sha256`. | `200`; `400` invalid part/integrity; `411` missing length; `413` size limit; `415` wrong media type. |
| POST | `/api/uploads/:sessionId/parts/:partNumber/confirm` | Confirm an S3 part after browser PUT using `sizeBytes` and `checksumSha256`; server verifies the object-storage part listing. | `200`; `400` invalid confirmation; `404` not owned. |
| POST | `/api/uploads/:sessionId/complete` | Verify contiguous part numbers, per-part sizes, completed byte count and supported media signature; persist upload metadata. | `200`; `409` missing/invalid parts; `400` invalid media/size. |
| DELETE | `/api/uploads/:sessionId` | Abort multipart state and mark the pending Video upload failed. | `204`; `404` not owned; `409` already completed. |

Part numbers are 1-based; the default part size is 16 MiB and the default configured maximum is 8 GiB. Upload session expiry defaults to 24 hours. API rate limiting applies to the upload routes. Object keys are generated server-side from owner/video identifiers and are never accepted from the browser. Local mode streams into private local storage; S3 mode uses short-lived presigned URLs and server-side credentials. A completed upload is distinct from processing completion. On successful upload validation, MongoDB stores `uploadStatus=uploaded`, `processingStatus=queued`, and an attempt number before the API enqueues a BullMQ job. Jobs use the video ID plus attempt as a deterministic BullMQ job ID. If Redis enqueue fails after the database write, the API reports an error while the durable queued state remains; the worker reconciles queued records on startup and periodically. Repeating upload completion retries queue publication only while the video is still queued.

For S3, configure bucket CORS for the exact frontend origin, `PUT`, and the checksum header required by the signed request. Configure lifecycle cleanup for incomplete multipart uploads. Credentials are resolved server-side by the AWS SDK provider chain and must not be sent to the browser.

Automated upload service tests use in-memory metadata repositories and temporary local filesystem storage. They do not prove MongoDB, real S3, or 8 GiB end-to-end operation. Those checks require live infrastructure and are not represented as passed here.

## Asynchronous processing

The worker persists `queued`, `probing`, `transcoding`, `packaging`, `completed` and `failed` states. Streaming status is separately `not_started`, `packaging`, `ready` or `failed`. FFprobe verifies duration, dimensions and codec before processing. FFmpeg creates MP4 renditions only at configured heights supported by the source (default 1080/720/480/360/240); it never upscales. Each output is probed and size-checked before being uploaded under an attempt-versioned private key. HLS playlists/segments and a static DASH MPD with fragmented MP4 segments are generated, checked for safe references and non-empty files, then persisted only after all objects upload. Failure text is bounded and excludes worker logs/secrets. Processing concurrency, threads, timeout, duration, output size and resolution ladder are environment-configurable.

The local storage and S3 worker adapters read/write private objects. The API status/retry endpoints are owner-scoped. The automated processor tests use mocked MongoDB/storage boundaries; live MongoDB/Redis/S3 end-to-end processing has not been verified unless separately reported. Real FFmpeg renditions and adaptive packaging tests run only when both FFmpeg and FFprobe are installed.

## Adaptive playback and authorization

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| POST | `/api/playback/videos/:videoId/sessions` | Owner (or authenticated viewer of a public video) requests a short-lived HMAC credential, HLS master URL, verified qualities and saved position. | `201`; `404` not accessible; `409` streaming unavailable/session limit; `429` rate limit. |
| PUT | `/api/playback/videos/:videoId/playback-settings` | Owner sets the maximum concurrent sessions for the video, 1–20. Requires exact Origin. | `200`; `400` invalid limit; `404` not owned. |
| GET | `/api/playback/sessions/:sessionId/assets?path=<base64url-relative-path>&token=<credential>` | Deliver an allowlisted manifest, playlist or segment; verifies signature, expiry, live session, video access and stored asset metadata on every request. Manifest references are rewritten to protected child URLs. | `200`; `403` invalid/expired/revoked/unknown asset; `502` invalid storage object. |
| DELETE | `/api/playback/sessions/:sessionId` | Revoke a session. Requires authenticated owner and exact Origin. | `204`; `404` absent/not owned. |
| POST | `/api/playback/sessions/:sessionId/events?token=<credential>` | Record a validated start/progress/complete/error event using UUID `eventId`; repeated IDs for a session are idempotent. Requires authenticated session owner and exact Origin. | `202`; `200` duplicate; `400` invalid payload; `403` invalid session. |
| GET | `/api/playback/videos/:videoId/progress` | Return the owner's saved playback position and completion flag. | `200`; `404` not owned/not found. |
| GET | `/api/playback/videos/:videoId/analytics` | Return owner-scoped starts, completions, errors, active sessions and average session activity duration. | `200`; `404` not owned/not found. |

Credentials use HMAC-SHA256, expire quickly and are bound to a MongoDB session. The API performs a database check for each asset request, enforcing revocation immediately. Client paths are decoded and must match a persisted relative-path entry; storage keys are never accepted from clients. Local/API delivery streams private objects. S3 credentials and object URLs are never sent to the browser. CDN signed cookies/URLs, cache keys, range optimization and edge revocation are not configured or verified.

The player uses HLS.js where native HLS is unavailable, seeks to saved progress, reports events, displays real available HLS levels, and overlays a non-sensitive session label/time. DASH is generated and structurally validated, but DASH player compatibility has not been tested or certified. WebVTT tracks are attached only when a stored subtitle exists. Watermarks/session limits are not DRM and cannot prevent screen recording.

Playback service tests mock Mongoose. Storage delivery and browser playback require live MongoDB/storage and a compatible player. Real packaging tests are conditional on FFmpeg/FFprobe; do not treat manifest existence as end-to-end playback verification.

## Transcript intelligence (Phase 6)

All routes below require the authenticated video owner. Mutating requests also require exact Origin. AI work is asynchronous and does not block upload or playback. If `AI_OPENAI_API_KEY` is unset, transcription states are `unavailable`, Q&A returns `503 AI_PROVIDER_UNAVAILABLE`, and search truthfully reports keyword mode.

| Method | Path | Purpose | Success / failure |
|---|---|---|---|
| GET | `/api/intelligence/videos/:videoId/status` | Return owner-scoped transcription/chapter job state, safe error, retry count, and existing subtitle metadata. | `200`; `404` not owned/not found. |
| GET | `/api/intelligence/videos/:videoId/transcript` | Return validated timestamped segments, generated chapters, topics and provider/model identifiers. | `200`; `404` not owned; `409` transcript not ready. |
| GET | `/api/intelligence/videos/:videoId/subtitles/:language` | Stream the server-stored WebVTT asset after owner authorization. | `200`; `404` not owned/not found; `502` storage metadata mismatch. |
| POST | `/api/intelligence/videos/:videoId/retry` | Requeue a failed transcription/intelligence run; uses a durable retry count and deterministic BullMQ job ID. Requires exact Origin. | `202`; `404` not owned; `409` not retryable; `429` rate limit. |
| GET | `/api/intelligence/search?q=<query>` | Search the authenticated user's recent ready transcript chunks, returning excerpt, video ID, time range, relevance, and `mode` (`vector` or `keyword`). | `200`; `400` invalid query; `503` configured embedding provider unavailable. |
| POST | `/api/intelligence/videos/:videoId/questions` | Answer a bounded question using retrieved passages from that one accessible video's transcript; returns timestamp citations or explicit insufficient-evidence response. Requires exact Origin. | `200`; `400` invalid question; `404` not owned; `409` transcript not ready; `503` provider unavailable. |
| GET | `/api/intelligence/videos/:videoId/review-signals` | Return owner-scoped, last-24-hour playback review signals with severity, observed time and evidence counts. | `200`; `404` not owned/not found. |

`POST /api/playback/videos/:videoId/sessions` may additionally return available `subtitleLanguages`; the player adds a WebVTT track only for stored assets. Search exact-vector mode uses persisted embeddings and cosine similarity, not a MongoDB Atlas vector index; current MongoDB scans are capped to the 50 newest eligible owner videos and the first 200 chunks per video. Otherwise the response is clearly `keyword` mode. Review signals currently include rapid repeated seeks and denied concurrent-session attempts; they are heuristics, not evidence of piracy or malicious intent.

The worker calls OpenAI speech, chat and embeddings APIs when a server-side `AI_OPENAI_API_KEY` is configured. Audio is extracted and size-limited before upload; provider/model errors are bounded and credentials are not returned. Real provider calls, costs and provider data retention are not verified by mocked tests; review current provider terms and deployment privacy requirements.
