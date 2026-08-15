export const SCREENING_VERSION: number;

export interface ScreeningManifest {
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

export interface ScreeningResult {
  version: number;
  scope: "manifest" | "source";
  state: "clear" | "review" | "blocked" | "pending";
  risk: "low" | "medium" | "high" | "unknown";
  checkedAt: string;
  findings: Array<{
    id: string;
    severity: "medium" | "high";
    label: { zh: string; en: string };
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

export function normalizeRepositoryPath(value: unknown): string | null;
export function manifestSummary(pkg: unknown, branch: string | null): ScreeningManifest;
export function baselineScreening(meta: unknown, manifest: ScreeningManifest, files?: string[], checkedAt?: string): ScreeningResult;
export function screenRepository(input: {
  meta: unknown;
  manifest: ScreeningManifest;
  files: string[];
  sourceFiles: Array<{ path: string; text: string }>;
  readme: string | null;
  checkedAt?: string;
}): ScreeningResult;
export function markInspectionUnavailable<T extends object>(
  previous: T,
  input: {
    kind: "error" | "rejected";
    checkedAt: string;
    manifest?: ScreeningManifest | null;
  },
): T & {
  manifest: ScreeningManifest;
  screenedCommit: null;
  installCommand: null;
  screening: ScreeningResult;
};
export function sanitizeRegistryInstallEvidence<T>(registry: T): T;
export function categoryFromText(value: unknown): "ui" | "session" | "tools" | "workflow" | "notify" | "dev" | "fun";
