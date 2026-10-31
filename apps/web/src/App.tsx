import { useEffect, useState } from "react";

type Readiness = {
  status: "ready" | "not_ready";
  dependencies: { mongodb: boolean; redis: boolean };
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function App() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [apiUnavailable, setApiUnavailable] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkReadiness() {
      try {
        const response = await fetch(`${apiBaseUrl}/ready`);
        const result = await response.json() as Readiness;
        if (active) {
          setReadiness(result);
          setApiUnavailable(false);
        }
      } catch {
        if (active) {
          setReadiness(null);
          setApiUnavailable(true);
        }
      }
    }

    void checkReadiness();
    const interval = window.setInterval(() => void checkReadiness(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const apiReady = readiness?.status === "ready";

  return (
    <main className="min-h-screen bg-ink px-6 py-10 text-slate-100 sm:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-6 border-b border-line pb-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-accent">Infrastructure / 01</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Secure Video Platform</h1>
            <p className="mt-2 max-w-2xl text-slate-400">
              A secure foundation for ingest, processing, adaptive delivery and video intelligence.
            </p>
          </div>
          <span className="w-fit rounded-full border border-line bg-panel px-4 py-2 text-sm text-slate-300">
            Phase 1 · Foundation
          </span>
        </header>

        <section className="mt-9 grid gap-5 md:grid-cols-3">
          <article className="rounded-2xl border border-line bg-panel p-6">
            <p className="text-sm text-slate-400">API</p>
            <p className="mt-3 text-xl font-medium">{readiness ? "Reachable" : "Unavailable"}</p>
            <p className="mt-2 text-sm text-slate-400">
              {readiness
                ? `Readiness: ${readiness.status}`
                : apiUnavailable
                  ? "API request failed. Start the API and check its configured URL."
                  : "Checking API readiness…"}
            </p>
          </article>
          <DependencyCard name="MongoDB" ready={readiness?.dependencies.mongodb} />
          <DependencyCard name="Redis" ready={readiness?.dependencies.redis} />
        </section>

        <section className="mt-8 rounded-2xl border border-line bg-panel p-6 sm:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-accent">Platform status</p>
              <h2 className="mt-2 text-2xl font-semibold">Foundation is in place</h2>
            </div>
            <span className={`w-fit rounded-full px-3 py-1 text-sm ${apiReady ? "bg-emerald-400/10 text-accent" : "bg-amber-400/10 text-amber-300"}`}>
              {apiReady ? "Dependencies ready" : "Waiting for services"}
            </span>
          </div>
          <p className="mt-4 max-w-3xl leading-7 text-slate-400">
            Uploads, transcoding, playback authorization and AI workflows are intentionally not enabled in this phase.
            The worker connects to BullMQ infrastructure but has no media processors registered.
          </p>
        </section>

        <footer className="mt-8 text-sm text-slate-500">
          Private-by-default video infrastructure · No public media assets or sample metrics
        </footer>
      </div>
    </main>
  );
}

function DependencyCard({ name, ready }: { name: string; ready: boolean | undefined }) {
  const label = ready === undefined ? "Unknown" : ready ? "Connected" : "Unavailable";
  return (
    <article className="rounded-2xl border border-line bg-panel p-6">
      <p className="text-sm text-slate-400">{name}</p>
      <p className="mt-3 text-xl font-medium">{label}</p>
      <p className="mt-2 text-sm text-slate-400">
        {ready === undefined ? "Waiting for API readiness." : ready ? "Dependency check passed." : "Check local service status."}
      </p>
    </article>
  );
}

export default App;
