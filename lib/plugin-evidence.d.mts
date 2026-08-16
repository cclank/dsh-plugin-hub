import type { PluginManifest, PluginScreening } from "./plugin-data";

export const PASSPORT_SCHEMA_VERSION: number;
export const PASSPORT_SCANNER_VERSION: number;

export interface PluginEvidenceSnapshot {
  schemaVersion: number;
  scannerVersion: number;
  evidenceId: string;
  repo: string;
  commitSha: string;
  checkedAt: string;
  repository: {
    owner: string;
    defaultBranch: string | null;
    archived: boolean;
    license: string | null;
  };
  package: {
    name: string | null;
    version: string | null;
    dependencies: string[];
    peerDependencies: string[];
    optionalDependencies: string[];
    devDependencies: string[];
    lifecycleScripts: Record<string, string>;
    maintainers: string[];
  };
  manifest: PluginManifest;
  capabilities: Record<string, string[]>;
  externalDomains: string[];
  disclosure: {
    security: boolean;
    permissions: boolean;
    dataUse: boolean;
    telemetry: boolean;
    disableOrOptOut: boolean;
  };
  verification: {
    immutableCommit: boolean;
    manifest: boolean;
    source: boolean;
    readme: boolean;
    lockfile: boolean;
    license: boolean;
    securityDisclosure: boolean;
    filesInspected: string[];
    score: number;
    possibleScore: number;
  };
  screening: PluginScreening;
}

export interface PluginEvidenceDiff {
  fromCommit: string | null;
  toCommit: string;
  changedAt: string;
  changed: boolean;
  severity: "baseline" | "none" | "low" | "medium" | "high";
  packageVersion: { from: string | null; to: string | null };
  risk: { from: PluginScreening["risk"] | null; to: PluginScreening["risk"] };
  state: { from: PluginScreening["state"] | null; to: PluginScreening["state"] };
  dependencies: { added: string[]; removed: string[] };
  peerDependencies: { added: string[]; removed: string[] };
  lifecycleScripts: { added: string[]; removed: string[] };
  capabilities: { added: string[]; removed: string[] };
  externalDomains: { added: string[]; removed: string[] };
  maintainers: { added: string[]; removed: string[] };
  manifestKinds: { added: string[]; removed: string[] };
}

export function buildEvidenceSnapshot(input: {
  repo: string;
  commitSha: string;
  checkedAt: string;
  meta: unknown;
  packageDocument: unknown;
  manifest: PluginManifest;
  screening: PluginScreening;
  rootFiles: string[];
  sourceFiles: Array<{ path: string; text: string }>;
  readme: string | null;
  securityText: string | null;
}): PluginEvidenceSnapshot;

export function computeEvidenceDiff(
  previous: PluginEvidenceSnapshot | null,
  current: PluginEvidenceSnapshot,
): PluginEvidenceDiff;
