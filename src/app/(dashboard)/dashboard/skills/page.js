"use client";

import { Card, Badge } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useBlabsMode } from "@/lib/blabs/BlabsModeContext";
import {
  getSkillsCatalog,
  getSkillRawUrl,
  getSkillBlobUrl,
  getSkillsIndexUrl,
} from "@/shared/constants/skills";

function absoluteSkillUrl(path) {
  if (typeof window === "undefined") return path;
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

function CopyButton({ value, label = "Copy link" }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <button
      onClick={() => copy(value)}
      className="px-2 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1"
      title={value}
    >
      <span className="material-symbols-outlined text-[12px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? "Copied!" : label}
    </button>
  );
}

function SkillRow({ skill, rebrand }) {
  const path = getSkillRawUrl(skill.id, rebrand);
  const url = rebrand ? absoluteSkillUrl(path) : path;
  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-[14px] border shadow-[var(--shadow-soft)] transition-colors ${
        skill.isEntry
          ? "border-brand-500/40 bg-brand-500/5"
          : "border-border-subtle bg-surface hover:bg-surface-2"
      }`}
    >
      <div
        className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
          skill.isEntry ? "bg-primary text-white" : "bg-primary/10 text-primary"
        }`}
      >
        <span className="material-symbols-outlined text-[18px]">{skill.icon}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-sm text-text-main">{skill.name}</h3>
          {skill.isEntry && (
            <Badge variant="primary" size="sm">START HERE</Badge>
          )}
          {skill.endpoint && (
            <Badge variant="default" size="sm">
              <code className="text-[10px]">{skill.endpoint}</code>
            </Badge>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{skill.description}</p>
        <a
          href={getSkillBlobUrl(skill.id, rebrand)}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-text-muted hover:text-primary mt-1 inline-flex items-center gap-1 break-all"
          download={rebrand ? "SKILL.md" : undefined}
        >
          {url}
          <span className="material-symbols-outlined text-[12px]">
            {rebrand ? "download" : "open_in_new"}
          </span>
        </a>
      </div>

      <CopyButton value={url} />
    </div>
  );
}

export default function SkillsPage() {
  const { rebrand, brand } = useBlabsMode();
  const catalog = getSkillsCatalog(rebrand);
  const entryId = rebrand ? "blabs" : "9router";
  const entryPath = getSkillRawUrl(entryId, rebrand);
  const entryUrl = rebrand ? absoluteSkillUrl(entryPath) : entryPath;
  const indexUrl = getSkillsIndexUrl(rebrand);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card padding="md">
        <div className="text-xs text-text-muted mb-2">Paste this to your AI:</div>
        <div className="px-3 py-2 rounded bg-surface-2 font-mono text-[12px] text-text-main break-all">
          Read this skill and use it: {entryUrl}
        </div>
      </Card>

      <div className="space-y-2">
        {catalog.map((skill) => (
          <SkillRow key={skill.id} skill={skill} rebrand={rebrand} />
        ))}
      </div>

      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-text-main">
              {rebrand ? `${brand.shortName} skill pack` : "More on GitHub"}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {rebrand
                ? "Direct downloads from this showroom (same origin as the dashboard)."
                : "Browse source, README, and examples."}
            </p>
          </div>
          <a
            href={indexUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            download={rebrand ? "README.md" : undefined}
          >
            <span className="material-symbols-outlined text-[16px]">
              {rebrand ? "download" : "open_in_new"}
            </span>
            {rebrand ? "Download index" : "View on GitHub"}
          </a>
        </div>
      </Card>
    </div>
  );
}
