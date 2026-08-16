import type { PluginRecord } from "./plugin-data";

export interface ResolvedPluginInstall {
  command: string;
  commit: string;
  source: "screened" | "codex";
}

export function resolvePluginInstall(
  plugin: PluginRecord | null | undefined,
): ResolvedPluginInstall | null;
