import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type Hls from "hls.js";

type Readiness = {
  status: "ready" | "not_ready";
  dependencies: { mongodb: boolean; redis: boolean };
};
type User = { id: string; email: string; displayName: string; role: "user" | "admin"; createdAt: string };
type UploadedPart = { partNumber: number; sizeBytes: number; etag: string; checksumSha256: string };
type UploadSession = {
  id: string;
  videoId: string;
  title: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  partSizeBytes: number;
  expectedParts: number;
  status: string;
  transferMode: "proxy" | "presigned";
  parts: UploadedPart[];
  expiresAt: string;
};
type UploadHint = { id: string; name: string; size: number; type: string; title: string };

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";
const uploadHintKey = "siv-upload-recovery-hint";
const allowedTypes: Record<string, string> = {
  "video/mp4": "video/mp4",
  "video/quicktime": "video/quicktime",
  "video/webm": "video/webm"
};

function App() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [apiUnavailable, setApiUnavailable] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");

  const refreshReadiness = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/ready`);
      setReadiness(await response.json() as Readiness);
      setApiUnavailable(false);
    } catch {
      setReadiness(null);
      setApiUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refreshReadiness();
    const interval = window.setInterval(() => void refreshReadiness(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshReadiness]);

  useEffect(() => {
    let active = true;
    fetch(`${apiBaseUrl}/api/auth/me`, { credentials: "include" })
      .then(async (response) => response.ok ? response.json() as Promise<{ user: User }> : null)
      .then((result) => { if (active && result) setUser(result.user); })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  async function submitAuth(path: "register" | "login", input: Record<string, string>) {
    setAuthError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      const result = await response.json() as { user?: User; error?: string };
      if (!response.ok || !result.user) throw new Error(result.error ?? "Authentication failed");
      setUser(result.user);
      await refreshReadiness();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication request failed");
    }
  }

  async function logout() {
    try {
      await fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      setUser(null);
    } catch {
      setAuthError("Could not sign out. Please try again.");
    }
  }

  const apiReady = readiness?.status === "ready";

  return (
    <main className="min-h-screen bg-ink px-5 py-8 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 border-b border-line pb-7 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-accent">Secure Video Infrastructure</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Ingest workspace</h1>
            <p className="mt-2 text-sm text-slate-400">Resumable, private-by-default video upload foundation</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-3 py-1.5 text-xs ${apiReady ? "bg-emerald-400/10 text-accent" : "bg-amber-400/10 text-amber-300"}`}>
              {apiUnavailable ? "API offline" : apiReady ? "Services ready" : "Database services unavailable"}
            </span>
            {user && (
              <>
                <span className="hidden text-sm text-slate-300 sm:inline">{user.displayName}</span>
                <button onClick={() => void logout()} className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-panel">
                  Sign out
                </button>
              </>
            )}
          </div>
        </header>

        <div className="mt-8">
          {authLoading ? (
            <p className="text-sm text-slate-400">Checking your session…</p>
          ) : !user ? (
            <AuthPanel onSubmit={submitAuth} error={authError} />
          ) : (
            <>
              <UploadPanel />
              <ProcessingPanel />
              <VideoIntelligencePanel />
              <PlaybackPanel />
            </>
          )}
        </div>
        <footer className="mt-12 border-t border-line pt-5 text-xs text-slate-500">
          Streaming access is short-lived and revocable. Browser watermarks and session limits are deterrents, not DRM.
        </footer>
      </div>
    </main>
  );
}

type VideoSummary = {
  id: string;
  title: string;
  uploadStatus: string;
  processingStatus: "not_started" | "queued" | "probing" | "transcoding" | "packaging" | "completed" | "failed";
  streamingStatus: "not_started" | "packaging" | "ready" | "failed";
  maxConcurrentPlaybackSessions?: number;
  processingError?: string;
};

function ProcessingPanel() {
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const active = videos.some((video) => ["queued", "probing", "transcoding", "packaging"].includes(video.processingStatus));

  const refresh = useCallback(async () => {
    try {
      const result = await apiJson<{ videos: VideoSummary[] }>("/api/videos");
      setVideos(result.videos.filter((video) => video.uploadStatus === "uploaded"));
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUploaded = () => void refresh();
    window.addEventListener("siv-video-uploaded", onUploaded);
    return () => window.removeEventListener("siv-video-uploaded", onUploaded);
  }, [refresh]);

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [active, refresh]);

  async function retry(videoId: string) {
    setRetrying(videoId);
    setError("");
    try {
      await apiJson(`/api/videos/${videoId}/retry`, { method: "POST", body: "{}" });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRetrying(null);
    }
  }

  if (!videos.length && !error) return null;
  return (
    <section className="mt-6 rounded-2xl border border-line bg-panel p-6 sm:p-8">
      <div>
        <p className="text-sm font-medium text-accent">Media processing</p>
        <h2 className="mt-2 text-xl font-semibold">Your uploaded videos</h2>
        <p className="mt-2 text-sm text-slate-400">Status comes from the processing worker; upload completion does not mean transcoding is complete.</p>
      </div>
      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
      <ul className="mt-5 divide-y divide-line">
        {videos.map((video) => (
          <li key={video.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-medium">{video.title}</p>
              <p className="mt-1 text-sm capitalize text-slate-400">{video.processingStatus.replaceAll("_", " ")}</p>
              {video.processingError && <p className="mt-1 text-sm text-rose-300">{video.processingError}</p>}
            </div>
            {video.processingStatus === "failed" && (
              <button disabled={retrying === video.id} onClick={() => void retry(video.id)} className="shrink-0 rounded-lg border border-line px-4 py-2 text-sm hover:bg-ink disabled:opacity-50">
                {retrying === video.id ? "Retrying…" : "Retry processing"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type IntelligenceVideo = VideoSummary & { streamingStatus: string };
type IntelligenceState = {
  transcription: { status: "unavailable" | "queued" | "processing" | "ready" | "failed"; error?: string; retryCount: number };
  chapters: { status: "unavailable" | "queued" | "processing" | "ready" | "failed"; error?: string; retryCount: number };
  subtitles: Array<{ language: string; contentType: string; fileSizeBytes: number }>;
};
type TranscriptData = {
  segments: Array<{ startSeconds: number; endSeconds: number; text: string; speaker?: string }>;
  chapters: Array<{ startSeconds: number; endSeconds: number; title: string; summary?: string }>;
  topics: Array<{ name: string; keywords: string[]; startSeconds: number; endSeconds: number }>;
};
type SearchResponse = {
  mode: "vector" | "keyword";
  results: Array<{ videoId: string; startSeconds: number; endSeconds: number; excerpt: string; relevance: number }>;
};
type ReviewSignals = { label: string; windowStart: string; signals: Array<{ type: string; severity: string; observedAt: string; evidence: { count: number; windowSeconds: number } }> };

function VideoIntelligencePanel() {
  const [videos, setVideos] = useState<IntelligenceVideo[]>([]);
  const [videoId, setVideoId] = useState("");
  const [status, setStatus] = useState<IntelligenceState | null>(null);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [review, setReview] = useState<ReviewSignals | null>(null);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; insufficientEvidence: boolean; citations: Array<{ videoId: string; startSeconds: number; endSeconds: number; quote: string }> } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshVideos = useCallback(async () => {
    try {
      const result = await apiJson<{ videos: IntelligenceVideo[] }>("/api/videos");
      const completed = result.videos.filter((video) => video.processingStatus === "completed");
      setVideos(completed);
      setVideoId((current) => completed.some((video) => video.id === current) ? current : completed[0]?.id ?? "");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const refreshSelected = useCallback(async () => {
    if (!videoId) return;
    try {
      const [state, signals] = await Promise.all([
        apiJson<{ intelligence: IntelligenceState }>(`/api/intelligence/videos/${videoId}/status`),
        apiJson<{ review: ReviewSignals }>(`/api/intelligence/videos/${videoId}/review-signals`)
      ]);
      setStatus(state.intelligence);
      setReview(signals.review);
      if (state.intelligence.transcription.status === "ready") {
        const result = await apiJson<{ transcript: TranscriptData }>(`/api/intelligence/videos/${videoId}/transcript`);
        setTranscript(result.transcript);
      } else {
        setTranscript(null);
      }
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [videoId]);

  useEffect(() => { void refreshVideos(); }, [refreshVideos]);
  useEffect(() => {
    setStatus(null);
    setTranscript(null);
    setReview(null);
    setAnswer(null);
    void refreshSelected();
  }, [refreshSelected]);
  useEffect(() => {
    if (!status || !["queued", "processing"].includes(status.transcription.status)) return;
    const timer = window.setInterval(() => void refreshSelected(), 8000);
    return () => window.clearInterval(timer);
  }, [status, refreshSelected]);

  async function retryTranscription() {
    if (!videoId) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/intelligence/videos/${videoId}/retry`, { method: "POST", body: "{}" });
      await refreshSelected();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function searchTranscripts(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSearch(await apiJson<SearchResponse>(`/api/intelligence/search?q=${encodeURIComponent(searchText.trim())}`));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function askQuestion(event: FormEvent) {
    event.preventDefault();
    if (!videoId) return;
    setBusy(true);
    setError("");
    try {
      setAnswer(await apiJson(`/api/intelligence/videos/${videoId}/questions`, {
        method: "POST",
        body: JSON.stringify({ question: question.trim() })
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function seek(videoId: string, timestampSeconds: number) {
    window.dispatchEvent(new CustomEvent("siv-open-video", { detail: { videoId, timestampSeconds } }));
  }

  if (!videos.length && !error) return null;
  const selectedVideo = videos.find((video) => video.id === videoId);
  return (
    <section className="mt-6 rounded-2xl border border-line bg-panel p-6 sm:p-8">
      <p className="text-sm font-medium text-accent">AI video intelligence</p>
      <h2 className="mt-2 text-xl font-semibold">Transcript-grounded discovery</h2>
      <p className="mt-2 text-sm text-slate-400">Speech recognition, chapters and Q&amp;A use transcript text only; the system does not visually understand the video.</p>
      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
      {videos.length > 0 && (
        <label className="mt-5 block text-sm text-slate-300">
          Video
          <select className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2 text-slate-100 sm:max-w-xl" value={videoId} onChange={(event) => setVideoId(event.target.value)}>
            {videos.map((video) => <option key={video.id} value={video.id}>{video.title}</option>)}
          </select>
        </label>
      )}
      {status && selectedVideo && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <h3 className="font-medium">Transcription</h3>
            <p className="mt-2 text-sm capitalize text-slate-300">{status.transcription.status}</p>
            {status.transcription.error && <p className="mt-2 text-sm text-rose-300">{status.transcription.error}</p>}
            <p className="mt-2 text-sm text-slate-400">Chapters and topics: <span className="capitalize">{status.chapters.status}</span></p>
            {status.chapters.error && <p className="mt-1 text-sm text-rose-300">{status.chapters.error}</p>}
            {status.transcription.status === "failed" && (
              <button disabled={busy} onClick={() => void retryTranscription()} className="mt-3 rounded-lg border border-line px-3 py-2 text-sm hover:bg-ink disabled:opacity-50">
                Retry transcription
              </button>
            )}
            {status.transcription.status === "ready" && transcript && (
              <>
                <h4 className="mt-4 text-sm font-medium">Chapters</h4>
                {transcript.chapters.length ? <ul className="mt-2 space-y-2">
                  {transcript.chapters.map((chapter) => (
                    <li key={`${chapter.startSeconds}-${chapter.title}`}>
                      <button onClick={() => seek(videoId, chapter.startSeconds)} className="text-left text-sm text-accent hover:underline">
                        {formatTimestamp(chapter.startSeconds)} · {chapter.title}
                      </button>
                      {chapter.summary && <p className="text-xs text-slate-400">{chapter.summary}</p>}
                    </li>
                  ))}
                </ul> : <p className="mt-2 text-sm text-slate-400">No generated chapters were returned.</p>}
                <h4 className="mt-4 text-sm font-medium">Topics</h4>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {transcript.topics.map((topic) => <li key={`${topic.name}-${topic.startSeconds}`} className="rounded-full bg-ink px-3 py-1 text-xs text-slate-300">{topic.name}</li>)}
                </ul>
              </>
            )}
            {status.subtitles.length > 0 && <p className="mt-4 text-sm text-slate-300">Subtitles: {status.subtitles.map((item) => item.language).join(", ")}</p>}
          </div>
          <div className="rounded-xl border border-line p-4">
            <form onSubmit={(event) => void askQuestion(event)}>
              <label className="block text-sm font-medium">
                Ask this video
                <textarea required minLength={3} maxLength={1000} value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-2 min-h-20 w-full rounded-lg border border-line bg-ink p-3 text-sm outline-none focus:border-accent" placeholder="Ask a question grounded in the transcript…" />
              </label>
              <button disabled={busy || status.transcription.status !== "ready"} className="mt-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50">{busy ? "Working…" : "Ask"}</button>
            </form>
            {answer && <div className="mt-4 text-sm"><p>{answer.answer}</p>{answer.citations.map((citation, index) => <button key={`${citation.startSeconds}-${index}`} onClick={() => seek(citation.videoId, citation.startSeconds)} className="mt-2 block text-left text-xs text-accent hover:underline">[{formatTimestamp(citation.startSeconds)}–{formatTimestamp(citation.endSeconds)}] “{citation.quote}”</button>)}</div>}
            <h3 className="mt-5 font-medium">Playback review signals</h3>
            <p className="mt-1 text-xs text-slate-500">{review?.label}</p>
            {review?.signals.length ? <ul className="mt-2 space-y-1 text-xs text-slate-300">{review.signals.map((signal, index) => <li key={`${signal.type}-${index}`}>{signal.severity} · {signal.type.replaceAll("_", " ")} · {signal.evidence.count} in {signal.evidence.windowSeconds}s</li>)}</ul> : <p className="mt-2 text-sm text-slate-400">No review signals in the last 24 hours.</p>}
          </div>
        </div>
      )}
      {transcript && <details className="mt-5 rounded-xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-medium">Transcript ({transcript.segments.length} timed segments)</summary>
        <ol className="mt-3 max-h-80 space-y-2 overflow-auto text-sm">
          {transcript.segments.map((segment) => <li key={`${segment.startSeconds}-${segment.endSeconds}`}><button onClick={() => seek(videoId, segment.startSeconds)} className="mr-2 text-accent hover:underline">{formatTimestamp(segment.startSeconds)}</button>{segment.text}</li>)}
        </ol>
      </details>}
      <form className="mt-6 border-t border-line pt-5" onSubmit={(event) => void searchTranscripts(event)}>
        <label className="block text-sm font-medium">
          Search your transcripts
          <div className="mt-2 flex gap-2">
            <input required minLength={2} maxLength={200} value={searchText} onChange={(event) => setSearchText(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent" placeholder="Search words or concepts…" />
            <button disabled={busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-ink disabled:opacity-50">Search</button>
          </div>
        </label>
        {search && <div className="mt-3">
          <p className="text-xs text-slate-500">Search mode: {search.mode === "vector" ? "embedding similarity" : "keyword fallback"}</p>
          {search.results.length ? <ul className="mt-2 space-y-2">{search.results.map((result, index) => <li key={`${result.videoId}-${result.startSeconds}-${index}`}><button type="button" onClick={() => seek(result.videoId, result.startSeconds)} className="text-left text-sm hover:text-accent"><span className="text-accent">{videos.find((video) => video.id === result.videoId)?.title ?? "Video"} · {formatTimestamp(result.startSeconds)}</span><br />{result.excerpt}</button></li>)}</ul> : <p className="mt-2 text-sm text-slate-400">No matching transcript passages.</p>}
        </div>}
      </form>
    </section>
  );
}

type PlaybackVideo = VideoSummary & { streamingStatus: "not_started" | "packaging" | "ready" | "failed" };
type PlaybackGrant = {
  sessionId: string;
  credential: string;
  expiresAt: string;
  manifestUrl: string;
  watermarkId: string;
  progressSeconds: number;
  subtitleLanguages: string[];
  qualities: Array<{ name: string; width: number; height: number }>;
};

function PlaybackPanel() {
  const [videos, setVideos] = useState<PlaybackVideo[]>([]);
  const [selected, setSelected] = useState<PlaybackVideo | null>(null);
  const [grant, setGrant] = useState<PlaybackGrant | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState<Record<string, { views: number; completions: number; playbackErrors: number; averageSessionSeconds: number } | null>>({});
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const [startAtSeconds, setStartAtSeconds] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await apiJson<{ videos: PlaybackVideo[] }>("/api/videos");
      const ready = result.videos.filter((video) => video.processingStatus === "completed" && video.streamingStatus === "ready");
      setVideos(ready);
      setSessionLimits((current) => Object.fromEntries(ready.map((video) => [
        video.id,
        current[video.id] ?? video.maxConcurrentPlaybackSessions ?? 2
      ])));
      const summaries = await Promise.all(ready.map(async (video) => {
        try {
          const value = await apiJson<{ analytics: { views: number; completions: number; playbackErrors: number; averageSessionSeconds: number } }>(
            `/api/playback/videos/${video.id}/analytics`
          );
          return [video.id, value.analytics] as const;
        } catch {
          return [video.id, null] as const;
        }
      }));
      setAnalytics(Object.fromEntries(summaries));
      setSelected((current) => current ? ready.find((video) => video.id === current.id) ?? null : null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUploaded = () => void refresh();
    window.addEventListener("siv-video-uploaded", onUploaded);
    return () => window.removeEventListener("siv-video-uploaded", onUploaded);
  }, [refresh]);

  async function begin(video: PlaybackVideo, timestampSeconds?: number) {
    setLoading(true);
    setError("");
    setSelected(video);
    setStartAtSeconds(timestampSeconds ?? null);
    try {
      const result = await apiJson<{ playback: PlaybackGrant }>(`/api/playback/videos/${video.id}/sessions`, {
        method: "POST",
        body: "{}"
      });
      setGrant(result.playback);
    } catch (cause) {
      setGrant(null);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const onOpenVideo = (event: Event) => {
      const detail = (event as CustomEvent<{ videoId: string; timestampSeconds: number }>).detail;
      const video = videos.find((candidate) => candidate.id === detail?.videoId);
      if (video && Number.isFinite(detail.timestampSeconds) && detail.timestampSeconds >= 0) {
        void begin(video, detail.timestampSeconds);
      }
    };
    window.addEventListener("siv-open-video", onOpenVideo);
    return () => window.removeEventListener("siv-open-video", onOpenVideo);
  }, [videos]);

  function closePlayer() {
    if (grant) {
      void apiJson(`/api/playback/sessions/${grant.sessionId}`, { method: "DELETE", body: "{}" })
        .catch((cause) => setError(errorMessage(cause)));
    }
    setGrant(null);
    setSelected(null);
    setStartAtSeconds(null);
  }

  if (!videos.length && !error) return null;
  return (
    <section className="mt-6 rounded-2xl border border-line bg-panel p-6 sm:p-8">
      <p className="text-sm font-medium text-accent">Secure playback</p>
      <h2 className="mt-2 text-xl font-semibold">Ready to watch</h2>
      <p className="mt-2 text-sm text-slate-400">Playback grants expire and are checked for every private manifest and segment request.</p>
      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
      {!grant && (
        <ul className="mt-4 divide-y divide-line">
          {videos.map((video) => {
            const stats = analytics[video.id];
            return <li key={video.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">{video.title}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {stats
                    ? `${stats.views} views · ${stats.completions} completions · ${stats.playbackErrors} errors · ${stats.averageSessionSeconds}s avg.`
                    : "Analytics unavailable"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-400">
                  Sessions
                  <select
                    className="ml-2 rounded border border-line bg-ink px-2 py-2 text-slate-100"
                    value={sessionLimits[video.id] ?? 2}
                    onChange={(event) => {
                      const limit = Number(event.target.value);
                      setSessionLimits((current) => ({ ...current, [video.id]: limit }));
                      void apiJson(`/api/playback/videos/${video.id}/playback-settings`, {
                        method: "PUT",
                        body: JSON.stringify({ maxConcurrentSessions: limit })
                      }).catch((cause) => {
                        setSessionLimits((current) => ({ ...current, [video.id]: video.maxConcurrentPlaybackSessions ?? 2 }));
                        setError(errorMessage(cause));
                      });
                    }}
                  >
                    {[1, 2, 3, 4, 5].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                  </select>
                </label>
                <button onClick={() => void begin(video)} disabled={loading} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-ink disabled:opacity-50">
                  {loading && selected?.id === video.id ? "Authorizing…" : "Play"}
                </button>
              </div>
            </li>;
          })}
        </ul>
      )}
      {grant && selected && <SecurePlayer video={selected} grant={grant} startAtSeconds={startAtSeconds} onClose={closePlayer} />}
    </section>
  );
}

function SecurePlayer({ video, grant, startAtSeconds, onClose }: { video: PlaybackVideo; grant: PlaybackGrant; startAtSeconds: number | null; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const startedRef = useRef(false);
  const lastProgressRef = useRef(0);
  const [error, setError] = useState("");
  const [qualities, setQualities] = useState<Array<{ index: number; label: string }>>([]);
  const [watermarkTime, setWatermarkTime] = useState(() => new Date().toLocaleString());
  const source = `${apiBaseUrl}${grant.manifestUrl}`;

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;
    const seekToSavedPosition = () => {
      const position = startAtSeconds ?? grant.progressSeconds;
      if (position > 0 && position < videoElement.duration) videoElement.currentTime = position;
    };
    videoElement.addEventListener("loadedmetadata", seekToSavedPosition, { once: true });
    const report = (type: "start" | "progress" | "complete" | "error", errorCode?: string) => {
      void apiJson(`/api/playback/sessions/${grant.sessionId}/events?token=${encodeURIComponent(grant.credential)}`, {
        method: "POST",
        body: JSON.stringify({
          eventId: crypto.randomUUID(),
          type,
          currentTimeSeconds: videoElement.currentTime || 0,
          ...(Number.isFinite(videoElement.duration) ? { durationSeconds: videoElement.duration } : {}),
          ...(errorCode ? { errorCode } : {})
        })
      }).catch(() => setError("A playback analytics event could not be recorded."));
    };
    const onPlaying = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      report("start");
    };
    const onTimeUpdate = () => {
      if (videoElement.currentTime - lastProgressRef.current < 15) return;
      lastProgressRef.current = videoElement.currentTime;
      report("progress");
    };
    const onEnded = () => report("complete");
    const onError = () => {
      setError("Playback failed. Access may have expired or the media may not be supported.");
      report("error", "media_error");
    };
    videoElement.addEventListener("playing", onPlaying);
    videoElement.addEventListener("timeupdate", onTimeUpdate);
    videoElement.addEventListener("ended", onEnded);
    videoElement.addEventListener("error", onError);

    let active = true;
    void import("hls.js").then(({ default: HlsPlayer }) => {
      if (!active) return;
      if (HlsPlayer.isSupported()) {
        const hls = new HlsPlayer({ enableWorker: true });
        hlsRef.current = hls;
        hls.on(HlsPlayer.Events.MANIFEST_PARSED, (_event, data) => {
          setQualities(data.levels.map((level, index) => ({ index, label: `${level.height}p` })));
          if (grant.progressSeconds > 0 && grant.progressSeconds < videoElement.duration) {
            videoElement.currentTime = grant.progressSeconds;
          }
        });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) setError(data.response?.code === 403
            ? "Playback authorization expired or was revoked. Start a new playback session."
            : "The adaptive stream could not be played.");
        });
        hls.loadSource(source);
        hls.attachMedia(videoElement);
      } else if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        videoElement.src = source;
      } else {
        setError("This browser does not support HLS playback.");
      }
    }).catch(() => {
      if (active) setError("The HLS playback module could not be loaded.");
    });
    const clock = window.setInterval(() => setWatermarkTime(new Date().toLocaleString()), 30_000);
    return () => {
      active = false;
      window.clearInterval(clock);
      videoElement.removeEventListener("playing", onPlaying);
      videoElement.removeEventListener("timeupdate", onTimeUpdate);
      videoElement.removeEventListener("ended", onEnded);
      videoElement.removeEventListener("error", onError);
      videoElement.removeEventListener("loadedmetadata", seekToSavedPosition);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [grant, source, startAtSeconds]);

  return (
    <div className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">{video.title}</h3>
          <p className="text-xs text-slate-400">Session expires {new Date(grant.expiresAt).toLocaleTimeString()}</p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-ink">Stop playback</button>
      </div>
      <div className="relative overflow-hidden rounded-xl bg-black">
        <video ref={videoRef} className="aspect-video w-full" controls playsInline>
          {grant.subtitleLanguages.map((language, index) => (
            <track
              key={language}
              kind="subtitles"
              srcLang={language}
              label={language}
              src={`${apiBaseUrl}/api/intelligence/videos/${video.id}/subtitles/${language}`}
              default={index === 0}
            />
          ))}
        </video>
        <div aria-label="Viewer watermark" className="pointer-events-none absolute right-4 top-4 rounded bg-black/50 px-2 py-1 text-xs text-white/80">
          {grant.watermarkId} · {watermarkTime}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <label>
          Quality
          <select className="ml-2 rounded border border-line bg-ink px-2 py-1 text-slate-100" defaultValue="-1" onChange={(event) => {
            if (hlsRef.current) hlsRef.current.currentLevel = Number(event.target.value);
          }}>
            <option value="-1">Auto</option>
            {qualities.map((quality) => <option key={quality.index} value={quality.index}>{quality.label}</option>)}
          </select>
        </label>
        {grant.subtitleLanguages.length === 0 && <span>Subtitles unavailable for this video</span>}
        {grant.subtitleLanguages.length > 0 && <span>Subtitles: {grant.subtitleLanguages.join(", ")}</span>}
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
      <p className="mt-3 text-xs text-slate-500">Visible overlays and session limits are deterrents, not DRM or screen-capture protection.</p>
    </div>
  );
}

function AuthPanel({
  onSubmit,
  error
}: {
  onSubmit: (path: "register" | "login", input: Record<string, string>) => Promise<void>;
  error: string;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-line bg-panel p-7">
      <p className="text-sm font-medium text-accent">Authentication required</p>
      <h2 className="mt-2 text-2xl font-semibold">{mode === "login" ? "Welcome back" : "Create your account"}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">Uploads are private and attached to your account.</p>
      <form className="mt-6 space-y-4" onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(mode === "login" ? "login" : "register", {
          email,
          password,
          ...(mode === "register" ? { displayName } : {})
        });
      }}>
        {mode === "register" && (
          <label className="block text-sm text-slate-300">
            Display name
            <input required minLength={1} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 outline-none focus:border-accent" />
          </label>
        )}
        <label className="block text-sm text-slate-300">
          Email
          <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 outline-none focus:border-accent" />
        </label>
        <label className="block text-sm text-slate-300">
          Password
          <input required type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 12 : 1} maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 outline-none focus:border-accent" />
        </label>
        {error && <p role="alert" className="rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
        <button className="w-full rounded-lg bg-accent px-4 py-2.5 font-semibold text-ink hover:bg-emerald-200">
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button onClick={() => setMode(mode === "login" ? "register" : "login")} className="mt-4 text-sm text-slate-400 hover:text-accent">
        {mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}
      </button>
    </section>
  );
}

function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [session, setSession] = useState<UploadSession | null>(null);
  const [phase, setPhase] = useState<"idle" | "creating" | "uploading" | "paused" | "completing" | "completed" | "aborted">("idle");
  const [progressBytes, setProgressBytes] = useState(0);
  const [currentPartProgress, setCurrentPartProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const pausedRef = useRef(false);
  const cancelRef = useRef(false);

  const hydrateSession = useCallback(async () => {
    const stored = localStorage.getItem(uploadHintKey);
    if (!stored) return;
    try {
      const hint = JSON.parse(stored) as UploadHint;
      const response = await fetch(`${apiBaseUrl}/api/uploads/${encodeURIComponent(hint.id)}`, { credentials: "include" });
      if (!response.ok) {
        if (response.status === 401) return;
        localStorage.removeItem(uploadHintKey);
        return;
      }
      const result = await response.json() as { upload: UploadSession };
      setSession(result.upload);
      setTitle(result.upload.title);
      setFile(null);
      setProgressBytes(result.upload.parts.reduce((total, part) => total + part.sizeBytes, 0));
      setPhase(result.upload.status === "completed" ? "completed" : "paused");
    } catch {
      setError("Saved upload hint could not be restored.");
    }
  }, []);

  useEffect(() => { void hydrateSession(); }, [hydrateSession]);

  function chooseFile(candidate: File | undefined) {
    setError("");
    if (!candidate) return;
    const contentType = allowedTypes[candidate.type] ?? typeFromName(candidate.name);
    if (!contentType) {
      setError("Choose an MP4, MOV, or WebM video file.");
      return;
    }
    setFile(candidate);
    if (!title) setTitle(candidate.name.replace(/\.[^.]+$/, ""));
  }

  async function createSession() {
    if (!file) return;
    const contentType = allowedTypes[file.type] ?? typeFromName(file.name);
    if (!contentType) {
      setError("This video format is not supported.");
      return;
    }
    setError("");
    setPhase("creating");
    try {
      const result = await apiJson<{ upload: UploadSession }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          fileSizeBytes: file.size,
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {})
        })
      });
      setSession(result.upload);
      localStorage.setItem(uploadHintKey, JSON.stringify({
        id: result.upload.id,
        name: file.name,
        size: file.size,
        type: contentType,
        title: title.trim()
      } satisfies UploadHint));
      setProgressBytes(0);
      setPhase("paused");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("idle");
    }
  }

  async function runUpload() {
    if (!file || !session) return;
    setError("");
    setPhase("uploading");
    pausedRef.current = false;
    cancelRef.current = false;
    const completeParts = new Map(session.parts.map((part) => [part.partNumber, part]));
    let finishedBytes = [...completeParts.values()].reduce((sum, part) => sum + part.sizeBytes, 0);
    setProgressBytes(finishedBytes);

    try {
      for (let partNumber = 1; partNumber <= session.expectedParts; partNumber++) {
        if (cancelRef.current || pausedRef.current) return;
        if (completeParts.has(partNumber)) continue;
        const start = (partNumber - 1) * session.partSizeBytes;
        const end = Math.min(file.size, start + session.partSizeBytes);
        const chunk = file.slice(start, end);
        const checksumSha256 = await digestBase64(chunk);
        const authorization = await apiJson<{ transferMode: "proxy" | "presigned"; uploadUrl: string | null }>(
          `/api/uploads/${session.id}/parts/${partNumber}/authorize`,
          { method: "POST", body: JSON.stringify({ checksumSha256 }) }
        );
        await uploadChunk(
          authorization.transferMode === "proxy" ? `${apiBaseUrl}/api/uploads/${session.id}/parts/${partNumber}` : authorization.uploadUrl!,
          chunk,
          checksumSha256,
          authorization.transferMode === "proxy",
          (xhr) => { xhrRef.current = xhr; },
          (loaded) => setCurrentPartProgress(loaded)
        );

        if (authorization.transferMode === "presigned") {
          await apiJson(`/api/uploads/${session.id}/parts/${partNumber}/confirm`, {
            method: "POST",
            body: JSON.stringify({ sizeBytes: chunk.size, checksumSha256 })
          });
        }

        finishedBytes += chunk.size;
        setProgressBytes(finishedBytes);
        setCurrentPartProgress(0);
        const status = await apiJson<{ upload: UploadSession }>("/api/uploads/" + session.id);
        completeParts.clear();
        status.upload.parts.forEach((part) => completeParts.set(part.partNumber, part));
        setSession(status.upload);
      }

      if (cancelRef.current || pausedRef.current) return;
      setPhase("completing");
      const result = await apiJson<{ upload: UploadSession }>(`/api/uploads/${session.id}/complete`, { method: "POST", body: "{}" });
      setSession(result.upload);
      setPhase("completed");
      setProgressBytes(file.size);
      localStorage.removeItem(uploadHintKey);
      window.dispatchEvent(new Event("siv-video-uploaded"));
    } catch (cause) {
      if (pausedRef.current || cancelRef.current) return;
      setError(errorMessage(cause));
      setPhase("paused");
      await hydrateSession();
      window.dispatchEvent(new Event("siv-video-uploaded"));
    }
  }

  function pauseUpload() {
    pausedRef.current = true;
    xhrRef.current?.abort();
    setPhase("paused");
  }

  async function cancelUpload() {
    cancelRef.current = true;
    xhrRef.current?.abort();
    if (session) {
      try {
        await apiJson(`/api/uploads/${session.id}`, { method: "DELETE", body: "{}" });
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
    }
    localStorage.removeItem(uploadHintKey);
    setSession(null);
    setFile(null);
    setPhase("aborted");
    setProgressBytes(0);
  }

  function retryUpload() {
    if (!file && session) {
      setError(`Re-select the original file (${session.fileName}) to resume this session.`);
      return;
    }
    void runUpload();
  }

  function onResumeFile(candidate: File | undefined) {
    if (!candidate || !session) return;
    const hint = JSON.parse(localStorage.getItem(uploadHintKey) ?? "{}") as Partial<UploadHint>;
    if (candidate.size !== session.fileSizeBytes || candidate.name !== session.fileName || (hint.type && typeFromNameOrMime(candidate) !== hint.type)) {
      setError("Selected file does not match the saved upload session.");
      return;
    }
    setFile(candidate);
    setError("");
  }

  const percent = session ? Math.min(100, Math.round(((progressBytes + currentPartProgress) / session.fileSizeBytes) * 100)) : 0;
  const canResume = session && file && phase !== "uploading" && phase !== "creating" && phase !== "completing" && phase !== "completed";

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
      <div className="rounded-2xl border border-line bg-panel p-6 sm:p-8">
        <div>
          <p className="text-sm font-medium text-accent">Large-file ingest</p>
          <h2 className="mt-2 text-2xl font-semibold">Upload a video</h2>
          <p className="mt-2 text-sm text-slate-400">Chunked transfer with server-persisted resume state. Maximum size is configured by the server.</p>
        </div>

        {!session && (
          <>
            <label
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
              className={`mt-6 flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition ${dragging ? "border-accent bg-accent/5" : "border-slate-600 hover:border-slate-400"}`}
            >
              <span className="text-3xl text-accent">↑</span>
              <span className="mt-3 font-medium">{file ? file.name : "Drop a video here or choose a file"}</span>
              <span className="mt-1 text-sm text-slate-400">{file ? formatBytes(file.size) : "MP4, MOV or WebM"}</span>
              <input className="sr-only" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={(event) => chooseFile(event.target.files?.[0])} />
            </label>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-slate-300">
                Video title
                <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 outline-none focus:border-accent" />
              </label>
              <label className="text-sm text-slate-300">
                Description <span className="text-slate-500">(optional)</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} className="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-2.5 outline-none focus:border-accent" />
              </label>
            </div>
            <button disabled={!file || !title.trim() || phase === "creating"} onClick={() => void createSession()} className="mt-5 rounded-lg bg-accent px-5 py-2.5 font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40">
              {phase === "creating" ? "Preparing upload…" : "Create upload session"}
            </button>
          </>
        )}

        {session && (
          <div className="mt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-medium">{session.title}</h3>
                <p className="mt-1 text-sm text-slate-400">{session.fileName} · {formatBytes(session.fileSizeBytes)}</p>
              </div>
              <span className="rounded-full bg-slate-700/70 px-3 py-1 text-xs capitalize text-slate-200">{phase === "completed" ? "uploaded · awaiting processing" : session.status}</span>
            </div>
            <div className="mt-6">
              <div className="flex justify-between text-sm text-slate-400">
                <span>{formatBytes(Math.min(progressBytes + currentPartProgress, session.fileSizeBytes))} of {formatBytes(session.fileSizeBytes)}</span>
                <span>{percent}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {phase === "uploading" ? (
                <button onClick={pauseUpload} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-ink">Pause</button>
              ) : canResume ? (
                <button onClick={retryUpload} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink">{session.parts.length ? "Resume / retry" : "Start upload"}</button>
              ) : null}
              {phase !== "completed" && (
                <button onClick={() => void cancelUpload()} className="rounded-lg border border-rose-400/30 px-4 py-2 text-sm text-rose-300 hover:bg-rose-400/10">Cancel upload</button>
              )}
              {phase === "completed" && (
                <button onClick={() => {
                  setSession(null);
                  setFile(null);
                  setTitle("");
                  setDescription("");
                  setPhase("idle");
                  setProgressBytes(0);
                }} className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-ink">Upload another</button>
              )}
            </div>
            {!file && phase !== "completed" && (
              <label className="mt-5 block rounded-xl border border-line p-4 text-sm text-slate-300">
                Select the original file to resume
                <input type="file" className="mt-2 block w-full text-sm text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-2 file:text-slate-100" onChange={(event) => onResumeFile(event.target.files?.[0])} />
              </label>
            )}
            <div className="mt-5">
              <p className="text-xs uppercase tracking-wide text-slate-500">Parts on server · {session.parts.length} / {session.expectedParts}</p>
              <div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-auto">
                {Array.from({ length: Math.min(session.expectedParts, 120) }, (_, index) => {
                  const uploaded = session.parts.some((part) => part.partNumber === index + 1);
                  return <span key={index} aria-label={`Part ${index + 1} ${uploaded ? "uploaded" : "pending"}`} title={`Part ${index + 1}`} className={`h-2 w-2 rounded-full ${uploaded ? "bg-accent" : "bg-slate-700"}`} />;
                })}
              </div>
              {session.expectedParts > 120 && <p className="mt-1 text-xs text-slate-500">Showing first 120 parts. All parts remain resumable.</p>}
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-5 rounded-lg bg-rose-400/10 p-3 text-sm text-rose-300">{error}</p>}
        {phase === "completed" && <p role="status" className="mt-5 rounded-lg bg-emerald-400/10 p-3 text-sm text-accent">Upload verified and saved. Processing and streaming readiness will update separately.</p>}
      </div>

      <aside className="space-y-4">
        <article className="rounded-2xl border border-line bg-panel p-6">
          <p className="text-sm font-medium text-accent">How resume works</p>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-slate-400">
            <li><span className="mr-2 text-accent">01</span>Parts are sent independently and checksummed.</li>
            <li><span className="mr-2 text-accent">02</span>Refresh the page, sign in, and reselect the same file.</li>
            <li><span className="mr-2 text-accent">03</span>The server reports verified parts; only missing parts are retried.</li>
          </ol>
        </article>
        <article className="rounded-2xl border border-line bg-panel p-6">
          <p className="text-sm font-medium text-slate-200">Private storage</p>
          <p className="mt-2 text-sm leading-6 text-slate-400">Local development stores media outside the web root. S3-compatible uploads use short-lived, checksum-bound part URLs; credentials never reach the browser.</p>
        </article>
      </aside>
    </section>
  );
}

async function apiJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      message = `Request failed (${response.status})`;
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function uploadChunk(
  url: string,
  chunk: Blob,
  checksum: string,
  proxy: boolean,
  onXhr: (xhr: XMLHttpRequest | null) => void,
  onProgress: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhr(xhr);
    xhr.open("PUT", url);
    if (proxy) {
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("x-part-sha256", checksum);
    } else {
      xhr.setRequestHeader("x-amz-checksum-sha256", checksum);
    }
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      onXhr(null);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => { onXhr(null); reject(new Error("Network error while uploading a part")); };
    xhr.onabort = () => { onXhr(null); reject(new Error("Upload paused")); };
    xhr.send(chunk);
  });
}

async function digestBase64(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function typeFromName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "mp4") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  return undefined;
}

function typeFromNameOrMime(file: File): string | undefined {
  return allowedTypes[file.type] ?? typeFromName(file.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Upload failed. Please retry.";
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default App;
