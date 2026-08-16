import type { CategoryId, Language, PluginRegistryData } from "./plugin-data";

export interface CodexPick {
  repo: string;
  pickedAt: string;
  reviewedCommit: string;
  category: CategoryId;
  summary: Record<Language, string>;
  reason: Record<Language, string>;
  safety: {
    risk: "low" | "medium" | "high";
    zh: string;
    en: string;
  };
}

export interface CodexPicksFeed {
  schemaVersion: 1;
  updatedAt: string;
  source: string;
  repository: string;
  picks: CodexPick[];
}

export function normalizeCodexPicksFeed(value: unknown): CodexPicksFeed;
export function applyCodexPicks(
  registry: PluginRegistryData,
  feed: unknown,
  source?: { state?: "live" | "snapshot"; url?: string; error?: string | null },
): PluginRegistryData;
