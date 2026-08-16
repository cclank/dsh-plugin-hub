import rawData from "@/data/plugins.generated.json";
import { sanitizeRegistryInstallEvidence } from "@/lib/plugin-screening.mjs";
import type { PluginEvidenceDiff, PluginEvidenceSnapshot } from "@/lib/plugin-evidence.mjs";

export type Language = "zh" | "en";
export type CategoryId =
  | "ui"
  | "session"
  | "tools"
  | "workflow"
  | "notify"
  | "dev"
  | "fun";

export interface PluginManifest {
  state: "verified" | "package-only" | "missing" | "invalid" | "error";
  branch: string | null;
  kinds: string[];
  packageName: string | null;
  version: string | null;
  lifecycleScripts: string[];
  runtimeDependencies: number;
  declaredPaths: string[];
  invalidDeclaredPaths: string[];
}

export interface PluginScreening {
  version: number;
  scope: "manifest" | "source";
  state: "clear" | "review" | "blocked" | "pending";
  risk: "low" | "medium" | "high" | "unknown";
  checkedAt: string;
  findings: Array<{
    id: string;
    severity: "medium" | "high";
    label: Record<Language, string>;
    files: string[];
  }>;
  filesInspected: string[];
  checks: {
    manifest: boolean;
    license: boolean;
    readme: boolean;
    lockfile: boolean;
    source: boolean;
    securityDisclosure: boolean;
  };
}

export interface PluginRecord {
  id: string;
  order: number;
  name: string;
  owner: string;
  repo: string;
  url: string;
  category: CategoryId;
  description: Record<Language, string>;
  added: string | null;
  curated: boolean;
  topic: boolean;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  watchers: number | null;
  pushedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  license: string | null;
  language: string | null;
  homepage: string | null;
  archived: boolean;
  defaultBranch: string | null;
  maintenance: "active" | "warm" | "quiet" | "archived" | "unknown";
  manifest: PluginManifest;
  screenedCommit: string | null;
  installCommand: string | null;
  discovery: {
    source: "curated" | "topic";
    firstSeenAt: string;
    lastSeenAt: string;
  };
  screening: PluginScreening;
  attention: {
    level: "clear" | "review" | "caution";
    reasons: string[];
  };
  passport?: {
    evidenceId: string;
    versionCount: number;
    latestCommit: string;
    latestCheckedAt: string;
    diffSeverity: PluginEvidenceDiff["severity"];
    verificationScore: number;
    verificationPossible: number;
  };
  codexPick?: {
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
  };
}

export interface PluginPassportVersion {
  commitSha: string;
  scannerVersion: number;
  checkedAt: string;
  state: PluginScreening["state"];
  risk: PluginScreening["risk"];
  listed: boolean;
  packageVersion: string | null;
  diff: PluginEvidenceDiff;
}

export interface PluginPassportData {
  schemaVersion: number;
  source: "d1" | "registry-fallback";
  repo: string;
  requestedRevision: string;
  current: {
    record: PluginRecord | null;
    evidence: PluginEvidenceSnapshot;
    diff: PluginEvidenceDiff;
  };
  history: PluginPassportVersion[];
}

export interface PluginScanPipelineStatus {
  available: boolean;
  mode: "queue" | "inline";
  backlog: number;
  oldestQueuedAt: string | null;
  estimatedMinutes: number | null;
  evidencePlugins: number;
  evidenceVersions: number;
  remainingPlugins: number;
  coveragePercent: number;
  jobs: Record<"queued" | "running" | "succeeded" | "rejected" | "blocked" | "error", number>;
}

export interface PluginRegistryData {
  schemaVersion: number;
  generatedAt: string;
  automation: {
    enabled: boolean;
    schedule: string;
    state: "bundled" | "live" | "degraded";
    scanVersion: number;
    lastRunAt: string | null;
    lastSuccessfulRunAt: string | null;
    checkedThisRun: number;
    queuedThisRun?: number;
    discoveredThisRun: number;
    admittedThisRun: number;
    rejectedTotal: number;
    error: string | null;
    pipeline?: PluginScanPipelineStatus;
  };
  sources: {
    curated: {
      url: string;
      repository: string;
      state: "live" | "snapshot";
      updated: string;
      count: number;
    };
    topic: {
      url: string;
      query: string;
      state: "live" | "partial" | "snapshot";
      total: number;
      scanned: number;
      matched: number;
      error: string | null;
    };
    codex: {
      url: string;
      repository: string;
      state: "live" | "snapshot";
      updated: string;
      count: number;
      matched: number;
      error: string | null;
    };
  };
  summary: {
    curated: number;
    codexPicks: number;
    listed: number;
    autoDiscovered: number;
    topicTotal: number;
    metadataMatches: number;
    manifestMatches: number;
    screeningClear: number;
    screeningReview: number;
    screeningBlocked: number;
    owners: number;
    stars: number;
  };
  categories: Record<CategoryId, Record<Language, string>>;
  plugins: PluginRecord[];
}

export const pluginRegistry = sanitizeRegistryInstallEvidence(rawData) as unknown as PluginRegistryData;
