"use client";
import { useEffect, useState } from "react";
import {
  BLABS_SKILLS,
  getSkillRawUrl,
} from "@/shared/constants/skills";

function absoluteUrl(path) {
  if (typeof window === "undefined") return path;
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

export default function ShowroomClient() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [originReady, setOriginReady] = useState(false);

  useEffect(() => {
    setOriginReady(true);
  }, []);

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
  const entryPath = getSkillRawUrl("blabs", true);
  const entryUrl = originReady ? absoluteUrl(entryPath) : entryPath;

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-4">
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

      <section className="space-y-3 border-t border-border-subtle pt-6">
        <h2 className="text-lg font-semibold">Agent skills</h2>
        <p className="text-sm text-muted-foreground">
          Direct downloads from this showroom. Paste a link into your AI agent — no GitHub required.
        </p>
        <div className="rounded-md bg-surface-2 px-3 py-2 font-mono text-[12px] break-all">
          Read this skill and use it: {entryUrl}
        </div>
        <ul className="space-y-2 text-sm">
          {BLABS_SKILLS.map((skill) => {
            const path = getSkillRawUrl(skill.id, true);
            const href = originReady ? absoluteUrl(path) : path;
            return (
              <li key={skill.id} className="flex flex-wrap items-center gap-2 justify-between">
                <span>
                  <span className="font-medium">{skill.name}</span>
                  <span className="text-muted-foreground"> — {skill.description}</span>
                </span>
                <a
                  href={path}
                  download="SKILL.md"
                  className="text-primary hover:underline shrink-0"
                >
                  Download
                </a>
                <span className="basis-full font-mono text-[11px] text-muted-foreground break-all">
                  {href}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
