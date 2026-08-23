"use client";
import { useEffect, useState } from "react";

export default function ShowroomClient() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/demo/stats?period=7d");
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setError("Failed to load stats");
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const t = stats?.totals;
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Showroom</h1>
      <p className="text-sm text-muted-foreground">Aggregate usage for the selected period.</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!stats && !error ? <p className="text-sm">Loading…</p> : null}
      {t ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>Requests: {t.requests}</div>
          <div>Prompt tokens: {t.promptTokens}</div>
          <div>Completion tokens: {t.completionTokens}</div>
          <div>Cached tokens: {t.cachedTokens}</div>
          <div>Cost: {t.cost}</div>
        </div>
      ) : null}
      {stats?.series?.length ? (
        <ul className="text-sm space-y-1">
          {stats.series.map((row) => (
            <li key={row.label}>{row.label}: {row.requests} req / {row.tokens} tok / {row.cost}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
