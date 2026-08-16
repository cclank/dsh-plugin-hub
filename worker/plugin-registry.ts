import bundledRegistryJson from "../data/plugins.generated.json";
import type {
  CategoryId,
  PluginManifest,
  PluginRecord,
  PluginRegistryData,
  PluginScreening,
} from "../lib/plugin-data";
import { readResponseTextLimited } from "../lib/limited-response.mjs";
import { buildEvidenceSnapshot, PASSPORT_SCANNER_VERSION } from "../lib/plugin-evidence.mjs";
import { selectRotatingWindow } from "../lib/rotating-window.mjs";
import {
  categoryFromText,
  markInspectionUnavailable,
  manifestSummary,
  normalizeRepositoryPath,
  sanitizeRegistryInstallEvidence,
  screenRepository,
} from "../lib/plugin-screening.mjs";
import {
  markPluginScanFailed,
  markPluginScanPublishFailed,
  markPluginScanRejected,
  markPluginScanRunning,
  mergeLatestPluginEvidence,
  persistPluginEvidence,
  pluginScanJobId,
  readPluginScanPipelineStatus,
  reservePluginScanJobs,
  type PassportBindings,
  type PluginScanMessage,
} from "./plugin-passports";

const REGISTRY_KEY = "registry:v2";
const STATE_KEY = "sync-state:v1";
const MAX_FALLBACK_SCANS_PER_RUN = 12;
// D1 Free permits 50 queries per Worker invocation. Discovery also reads four
// pipeline counters and one registry overlay, so authenticated reservation
// writes stay below that ceiling. Anonymous GitHub API access is throttled more
// aggressively and therefore uses a smaller rotating window.
const MAX_AUTHENTICATED_QUEUE_SCANS_PER_RUN = 40;
const MAX_ANONYMOUS_QUEUE_SCANS_PER_RUN = 12;
const MAX_SEARCH_PAGE = 10;
const RESCAN_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_JSON_BYTES = 6_000_000;
const MAX_COMMIT_JSON_BYTES = 300_000;
const MAX_ROOT_JSON_BYTES = 800_000;
const MAX_TEXT_BYTES = 140_000;

export interface PluginRegistryEnv extends PassportBindings {
  PLUGIN_REGISTRY?: KVNamespace;
}

interface GithubRepository {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  default_branch: string;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  watchers_count: number;
  subscribers_count?: number;
  pushed_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  language: string | null;
  owner?: { login?: string };
  license?: { spdx_id?: string | null } | null;
}

interface GithubSearchResponse {
  total_count: number;
  items: GithubRepository[];
}

interface GithubCommitResponse {
  sha: string;
}

interface GithubContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
}

interface SeenCandidate {
  pushedAt: string | null;
  checkedAt: string;
  outcome: "listed" | "rejected" | "blocked" | "error";
}

interface SyncState {
  cursorPage: number;
  queueCursor?: number;
  seen: Record<string, SeenCandidate>;
}

function bundledRegistry(): PluginRegistryData {
  return sanitizeRegistryInstallEvidence(
    JSON.parse(JSON.stringify(bundledRegistryJson)),
  ) as PluginRegistryData;
}

function githubHeaders(env: PluginRegistryEnv) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "dsh-plugin-hub-cloudflare-sync",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(env.GITHUB_TOKEN?.trim() ? { Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}` } : {}),
  };
}

function validateRepoName(value: string) {
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(value)) {
    throw new Error(`Invalid GitHub repository name: ${value}`);
  }
  return value;
}

async function fetchLimited(url: string, init: RequestInit, maxBytes: number) {
  const response = await fetch(url, {
    ...init,
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const suffix = remaining === "0" ? " (GitHub rate limit reached)" : "";
    throw new Error(`${response.status} ${response.statusText}: ${url}${suffix}`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error(`Response too large (${length} bytes): ${url}`);
  try {
    return await readResponseTextLimited(response, maxBytes);
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`Response exceeded ${maxBytes} bytes: ${url}`);
    throw error;
  }
}

async function fetchJson<T>(url: string, env: PluginRegistryEnv, maxBytes = MAX_JSON_BYTES): Promise<T> {
  const text = await fetchLimited(url, { headers: githubHeaders(env) }, maxBytes);
  if (text === null) throw new Error(`404 Not Found: ${url}`);
  return JSON.parse(text) as T;
}

async function fetchRaw(repo: string, revision: string, filePath: string) {
  validateRepoName(repo);
  const safePath = normalizeRepositoryPath(filePath);
  if (!safePath) throw new Error(`Unsafe repository path: ${filePath}`);
  const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(revision)}/${encodedPath}`;
  return fetchLimited(url, { headers: { Accept: "text/plain" } }, MAX_TEXT_BYTES);
}

function responseExceededInspectionLimit(error: unknown) {
  return error instanceof Error && /Response (?:too large|exceeded)/iu.test(error.message);
}

async function fetchRawForInspection(repo: string, revision: string, filePath: string) {
  try {
    return { text: await fetchRaw(repo, revision, filePath), exceeded: false };
  } catch (error) {
    if (responseExceededInspectionLimit(error)) return { text: null, exceeded: true };
    throw error;
  }
}

async function resolveCommitSha(repo: string, branch: string, env: PluginRegistryEnv) {
  validateRepoName(repo);
  const commit = await fetchJson<GithubCommitResponse>(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`,
    env,
    MAX_COMMIT_JSON_BYTES,
  );
  if (!/^[a-f\d]{40,64}$/iu.test(commit.sha)) {
    throw new Error(`GitHub returned an invalid commit id for ${repo}`);
  }
  return commit.sha.toLowerCase();
}

function metadataFromPlugin(plugin: PluginRecord): GithubRepository {
  return {
    full_name: plugin.repo,
    name: plugin.repo.split("/")[1] || plugin.name,
    description: plugin.description.en || plugin.description.zh || null,
    html_url: plugin.url,
    homepage: plugin.homepage,
    default_branch: plugin.defaultBranch || plugin.manifest.branch || "main",
    fork: false,
    archived: plugin.archived,
    stargazers_count: plugin.stars || 0,
    forks_count: plugin.forks || 0,
    open_issues_count: plugin.openIssues || 0,
    watchers_count: plugin.watchers || 0,
    pushed_at: plugin.pushedAt,
    updated_at: plugin.updatedAt,
    created_at: plugin.createdAt,
    language: plugin.language,
    owner: { login: plugin.owner },
    license: plugin.license ? { spdx_id: plugin.license } : null,
  };
}

function selectSourcePaths(manifest: PluginManifest) {
  const declared = manifest.declaredPaths
    .filter((item) => !/\.(?:d\.ts|map)$/iu.test(item))
    .sort((a, b) => {
      const aCode = /\.[cm]?[jt]sx?$/iu.test(a) ? 0 : 1;
      const bCode = /\.[cm]?[jt]sx?$/iu.test(b) ? 0 : 1;
      return aCode - bCode;
    });
  const fallbacks = ["src/index.ts", "dsh/index.js", "index.ts", "index.js", "lib/index.js"];
  return [...new Set([...declared, ...fallbacks])].slice(0, 3);
}

async function inspectRepository(meta: GithubRepository, env: PluginRegistryEnv) {
  const repo = validateRepoName(meta.full_name);
  const branch = meta.default_branch || "main";
  const commitSha = await resolveCommitSha(repo, branch, env);
  const [packageResult, rootContents] = await Promise.all([
    fetchRawForInspection(repo, commitSha, "package.json"),
    fetchJson<GithubContentItem[]>(
      `https://api.github.com/repos/${repo}/contents?ref=${encodeURIComponent(commitSha)}`,
      env,
      MAX_ROOT_JSON_BYTES,
    ),
  ]);
  const packageText = packageResult.text;
  if (packageResult.exceeded) return { outcome: "rejected" as const, reason: "package.json exceeds static inspection limit" };
  if (!packageText) return { outcome: "rejected" as const, reason: "package.json missing" };

  let pkg: unknown;
  try {
    pkg = JSON.parse(packageText);
  } catch {
    return { outcome: "rejected" as const, reason: "package.json invalid" };
  }
  const manifest = manifestSummary(pkg, branch) as PluginManifest;
  const rootFiles = rootContents
    .filter((item) => item.type === "file")
    .map((item) => item.path);
  const readmePath = rootFiles.find((item) => /^readme(?:\.[^/]+)?$/iu.test(item)) || "README.md";
  const securityPath = rootFiles.find((item) => /^security(?:\.[^/]+)?$/iu.test(item)) || null;
  const sourcePaths = selectSourcePaths(manifest);
  const [readmeResult, securityResult, ...sourceResults] = await Promise.all([
    fetchRawForInspection(repo, commitSha, readmePath),
    securityPath
      ? fetchRawForInspection(repo, commitSha, securityPath)
      : Promise.resolve({ text: null, exceeded: false }),
    ...sourcePaths.map((item) => fetchRawForInspection(repo, commitSha, item)),
  ]);
  const readme = readmeResult.text;
  const securityText = securityResult.text;
  const sourceFiles = sourcePaths.flatMap((filePath, index) => {
    const text = sourceResults[index].text;
    return typeof text === "string" ? [{ path: filePath, text }] : [];
  });
  const unavailableFiles = [
    ...(readmeResult.exceeded ? [readmePath] : []),
    ...(securityResult.exceeded && securityPath ? [securityPath] : []),
    ...sourcePaths.filter((_, index) => sourceResults[index].exceeded),
  ];
  const inspectedDocumentFiles = [
    "package.json",
    ...(readme ? [readmePath] : []),
    ...(securityText && securityPath ? [securityPath] : []),
  ];
  const screening = screenRepository({
    meta,
    manifest,
    files: rootFiles,
    sourceFiles,
    unavailableFiles,
    readme,
  }) as PluginScreening;
  const checkedAt = screening.checkedAt;
  const evidence = buildEvidenceSnapshot({
    repo,
    commitSha,
    checkedAt,
    meta,
    packageDocument: pkg,
    manifest,
    screening,
    rootFiles: inspectedDocumentFiles,
    sourceFiles,
    readme,
    securityText,
  });
  return {
    outcome: manifest.state !== "verified"
      ? "rejected" as const
      : screening.state === "blocked"
        ? "blocked" as const
        : "listed" as const,
    reason: manifest.state !== "verified" ? "dsh manifest missing" : null,
    commitSha,
    manifest,
    screening,
    evidence,
    readme,
  };
}

function attentionFromScreening(screening: PluginScreening) {
  return {
    level: screening.state === "blocked" ? "caution" as const : screening.state === "clear" ? "clear" as const : "review" as const,
    reasons: screening.findings.map((finding) => finding.label.zh),
  };
}

function maintenanceState(meta: GithubRepository) {
  if (meta.archived) return "archived" as const;
  const pushed = meta.pushed_at ? Date.parse(meta.pushed_at) : Number.NaN;
  if (!Number.isFinite(pushed)) return "unknown" as const;
  const days = Math.max(0, Math.floor((Date.now() - pushed) / 86_400_000));
  if (days <= 30) return "active" as const;
  if (days <= 180) return "warm" as const;
  return "quiet" as const;
}

function recordFromInspection(
  meta: GithubRepository,
  commitSha: string,
  manifest: PluginManifest,
  screening: PluginScreening,
  previous: PluginRecord | undefined,
  now: string,
) {
  const curated = previous?.curated === true;
  const [fallbackOwner, fallbackName] = meta.full_name.split("/");
  const description = meta.description?.trim() || manifest.packageName || meta.name;
  const installAllowed = curated ? screening.state !== "blocked" : screening.state === "clear";
  const firstSeenAt = previous?.discovery?.firstSeenAt || previous?.added || now.slice(0, 10);
  const category = previous?.category || categoryFromText(`${meta.name} ${description}`) as CategoryId;
  return {
    id: meta.full_name.toLowerCase(),
    order: previous?.order ?? Number.MAX_SAFE_INTEGER,
    name: previous?.name || manifest.packageName || fallbackName,
    owner: previous?.owner || meta.owner?.login || fallbackOwner,
    repo: meta.full_name,
    url: `https://github.com/${meta.full_name}`,
    category,
    description: previous?.description || { zh: description, en: description },
    added: previous?.added || now.slice(0, 10),
    curated,
    topic: true,
    stars: meta.stargazers_count ?? previous?.stars ?? null,
    forks: meta.forks_count ?? previous?.forks ?? null,
    openIssues: meta.open_issues_count ?? previous?.openIssues ?? null,
    watchers: meta.subscribers_count ?? meta.watchers_count ?? previous?.watchers ?? null,
    pushedAt: meta.pushed_at ?? previous?.pushedAt ?? null,
    updatedAt: meta.updated_at ?? previous?.updatedAt ?? null,
    createdAt: meta.created_at ?? previous?.createdAt ?? null,
    license: meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : null,
    language: meta.language ?? previous?.language ?? null,
    homepage: meta.homepage || previous?.homepage || null,
    archived: Boolean(meta.archived),
    defaultBranch: meta.default_branch || manifest.branch || null,
    maintenance: maintenanceState(meta),
    manifest,
    screenedCommit: commitSha,
    installCommand: installAllowed ? `dsh plugin --profile web add github:${meta.full_name}#${commitSha}` : null,
    discovery: {
      source: curated ? "curated" as const : "topic" as const,
      firstSeenAt,
      lastSeenAt: now,
    },
    screening,
    attention: attentionFromScreening(screening),
  } satisfies PluginRecord;
}

async function searchTopicPage(page: number, env: PluginRegistryEnv) {
  const query = new URLSearchParams({
    q: "topic:dsh-plugin",
    sort: "updated",
    order: "desc",
    per_page: "100",
    page: String(page),
  });
  return fetchJson<GithubSearchResponse>(`https://api.github.com/search/repositories?${query}`, env);
}

function shouldRescan(plugin: PluginRecord, state: SyncState) {
  if (plugin.screening?.scope !== "source") return true;
  const seen = state.seen[plugin.id];
  const checked = Date.parse(seen?.checkedAt || plugin.screening.checkedAt || "0");
  return !Number.isFinite(checked) || Date.now() - checked >= RESCAN_AFTER_MS;
}

function candidateWasRecentlyRejected(meta: GithubRepository, state: SyncState) {
  const seen = state.seen[meta.full_name.toLowerCase()];
  if (!seen || !["rejected", "blocked"].includes(seen.outcome)) return false;
  const checked = Date.parse(seen.checkedAt);
  return seen.pushedAt === meta.pushed_at && Number.isFinite(checked) && Date.now() - checked < RESCAN_AFTER_MS;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>) {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function compactState(state: SyncState) {
  const entries = Object.entries(state.seen)
    .sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt))
    .slice(0, 1_500);
  return { ...state, seen: Object.fromEntries(entries) };
}

function scanMessage(meta: GithubRepository, now: string): PluginScanMessage {
  const repo = validateRepoName(meta.full_name);
  return {
    schemaVersion: 1,
    scannerVersion: PASSPORT_SCANNER_VERSION,
    jobId: pluginScanJobId(repo, meta.pushed_at),
    repo,
    defaultBranch: meta.default_branch || "main",
    pushedAt: meta.pushed_at,
    queuedAt: now,
    metadata: meta,
  };
}

async function enqueueScanCandidates(
  env: PluginRegistryEnv,
  candidates: GithubRepository[],
  now: string,
) {
  if (!env.PLUGIN_SCAN_QUEUE || !env.VISIT_METRICS) return 0;
  const messages = candidates.map((meta) => scanMessage(meta, now));
  const reserved = await reservePluginScanJobs(env, messages);
  let sent = 0;
  for (let index = 0; index < reserved.length; index += 100) {
    const batch = reserved.slice(index, index + 100);
    try {
      await env.PLUGIN_SCAN_QUEUE.sendBatch(batch.map((body) => ({ body })));
      sent += batch.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markPluginScanPublishFailed(env, batch, `queue publish failed: ${message}`);
      throw error;
    }
  }
  return sent;
}

function summarize(registry: PluginRegistryData) {
  const plugins = registry.plugins;
  registry.summary = {
    curated: plugins.filter((plugin) => plugin.curated).length,
    listed: plugins.length,
    autoDiscovered: plugins.filter((plugin) => !plugin.curated).length,
    topicTotal: registry.sources.topic.total,
    metadataMatches: plugins.filter((plugin) => plugin.topic).length,
    manifestMatches: plugins.filter((plugin) => plugin.manifest.state === "verified").length,
    screeningClear: plugins.filter((plugin) => plugin.screening.state === "clear").length,
    screeningReview: plugins.filter((plugin) => ["review", "pending"].includes(plugin.screening.state)).length,
    screeningBlocked: plugins.filter((plugin) => plugin.screening.state === "blocked").length,
    owners: new Set(plugins.map((plugin) => plugin.owner.toLowerCase())).size,
    stars: plugins.reduce((sum, plugin) => sum + (plugin.stars || 0), 0),
  };
  registry.sources.topic.matched = registry.summary.metadataMatches;
}

export async function readPluginRegistry(env: PluginRegistryEnv): Promise<PluginRegistryData> {
  let registry = bundledRegistry();
  if (!env.PLUGIN_REGISTRY) {
    registry = await mergeLatestPluginEvidence(env, registry);
    summarize(registry);
    return registry;
  }
  try {
    const stored = await env.PLUGIN_REGISTRY.get<PluginRegistryData>(REGISTRY_KEY, "json");
    registry = stored ? sanitizeRegistryInstallEvidence(stored) as PluginRegistryData : registry;
  } catch (error) {
    console.error(JSON.stringify({ event: "registry.read.error", error: error instanceof Error ? error.message : String(error) }));
  }
  registry = await mergeLatestPluginEvidence(env, registry);
  summarize(registry);
  return registry;
}

export async function processPluginScanBatch(
  batch: MessageBatch<PluginScanMessage>,
  env: PluginRegistryEnv,
) {
  const registry = await readPluginRegistry(env);
  const previousById = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
  await mapLimit(batch.messages, 2, async (message) => {
    const body = message.body;
    if (
      body?.schemaVersion !== 1
      || body.scannerVersion !== PASSPORT_SCANNER_VERSION
      || !body.repo
      || body.repo.toLowerCase() !== body.metadata?.full_name?.toLowerCase()
    ) {
      message.ack();
      console.error(JSON.stringify({ event: "registry.scan.invalid-message", messageId: message.id }));
      return;
    }
    try {
      await markPluginScanRunning(env, body);
      const inspection = await inspectRepository(body.metadata, env);
      if (!("evidence" in inspection)) {
        const reason = inspection.reason || "inspection produced no evidence";
        await markPluginScanRejected(env, body, reason);
        message.ack();
        console.log(JSON.stringify({ event: "registry.scan.rejected", repo: body.repo, reason }));
        return;
      }
      const evidence = inspection.evidence;
      if (!evidence) throw new Error("inspection produced no evidence");
      const id = body.repo.toLowerCase();
      const previous = previousById.get(id);
      const shouldList = inspection.outcome === "listed" || (inspection.outcome === "blocked" && previous?.curated === true);
      const record = inspection.outcome === "listed" || inspection.outcome === "blocked"
        ? recordFromInspection(
            body.metadata,
            inspection.commitSha,
            inspection.manifest,
            inspection.screening,
            previous,
            evidence.checkedAt,
          )
        : null;
      const persisted = await persistPluginEvidence(env, body, record, evidence, shouldList);
      if (persisted.record && shouldList) previousById.set(id, persisted.record);
      message.ack();
      console.log(JSON.stringify({
        event: "registry.scan.complete",
        repo: body.repo,
        commit: inspection.commitSha,
        outcome: inspection.outcome,
        diff: persisted.diff.severity,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await markPluginScanFailed(env, body, errorMessage, message.attempts <= 3);
      message.retry({ delaySeconds: Math.min(900, 30 * (2 ** Math.max(0, message.attempts - 1))) });
      console.error(JSON.stringify({
        event: "registry.scan.error",
        repo: body.repo,
        attempt: message.attempts,
        error: errorMessage,
      }));
    }
  });
}

export async function syncPluginRegistry(env: PluginRegistryEnv) {
  if (!env.PLUGIN_REGISTRY) {
    console.warn(JSON.stringify({ event: "registry.sync.skipped", reason: "PLUGIN_REGISTRY binding missing" }));
    return null;
  }

  const now = new Date().toISOString();
  const registry = await readPluginRegistry(env);
  const state: SyncState = await env.PLUGIN_REGISTRY.get<SyncState>(STATE_KEY, "json") || { cursorPage: 2, seen: {} };
  const errors: string[] = [];
  let pageOne: GithubSearchResponse;
  try {
    pageOne = await searchTopicPage(1, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.automation = { ...registry.automation, state: "degraded", lastRunAt: now, error: message };
    await env.PLUGIN_REGISTRY.put(REGISTRY_KEY, JSON.stringify(registry));
    console.error(JSON.stringify({ event: "registry.sync.error", stage: "discovery", error: message }));
    return registry;
  }

  let rotatingItems: GithubRepository[] = [];
  const rotatingPage = Math.max(2, Math.min(MAX_SEARCH_PAGE, state.cursorPage || 2));
  try {
    const rotating = await searchTopicPage(rotatingPage, env);
    rotatingItems = rotating.items || [];
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  state.cursorPage = rotatingPage >= MAX_SEARCH_PAGE ? 2 : rotatingPage + 1;

  const discovered = new Map<string, GithubRepository>();
  for (const item of [...(pageOne.items || []), ...rotatingItems]) {
    if (!item?.full_name) continue;
    try {
      discovered.set(validateRepoName(item.full_name).toLowerCase(), item);
    } catch {
      // GitHub-owned metadata that does not fit an owner/repository pair is ignored.
    }
  }

  const previousById = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
  const newOrChanged = [...discovered.entries()]
    .filter(([id, meta]) => {
      const previous = previousById.get(id);
      if (candidateWasRecentlyRejected(meta, state)) return false;
      return !previous || previous.pushedAt !== meta.pushed_at || shouldRescan(previous, state);
    })
    .map(([, meta]) => meta);
  const staleExisting = registry.plugins
    .filter((plugin) => shouldRescan(plugin, state) && !discovered.has(plugin.id))
    .map(metadataFromPlugin);
  const allCandidates = [...new Map(
    [...newOrChanged, ...staleExisting].map((meta) => [meta.full_name.toLowerCase(), meta]),
  ).values()];
  const discoveredThisRun = [...discovered.keys()].filter((id) => !previousById.has(id)).length;

  if (env.PLUGIN_SCAN_QUEUE && env.VISIT_METRICS) {
    let queuedThisRun = 0;
    const scanLimit = env.GITHUB_TOKEN?.trim()
      ? MAX_AUTHENTICATED_QUEUE_SCANS_PER_RUN
      : MAX_ANONYMOUS_QUEUE_SCANS_PER_RUN;
    const queueWindow = selectRotatingWindow(allCandidates, state.queueCursor || 0, scanLimit);
    state.queueCursor = queueWindow.nextCursor;
    try {
      queuedThisRun = await enqueueScanCandidates(env, queueWindow.selected, now);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    registry.schemaVersion = 3;
    registry.generatedAt = now;
    registry.sources.topic = {
      ...registry.sources.topic,
      state: errors.length ? "partial" : "live",
      total: pageOne.total_count || registry.sources.topic.total,
      scanned: registry.sources.topic.scanned,
      error: errors.length ? errors.slice(0, 3).join(" | ") : null,
    };
    summarize(registry);
    const pipeline = await readPluginScanPipelineStatus(env, registry.summary.listed);
    registry.automation = {
      enabled: true,
      schedule: "*/30 * * * *",
      state: errors.length ? "degraded" : "live",
      scanVersion: PASSPORT_SCANNER_VERSION,
      lastRunAt: now,
      lastSuccessfulRunAt: errors.length ? registry.automation?.lastSuccessfulRunAt || null : now,
      checkedThisRun: 0,
      queuedThisRun,
      discoveredThisRun,
      admittedThisRun: 0,
      rejectedTotal: pipeline.jobs.rejected + pipeline.jobs.blocked,
      error: errors.length ? errors.slice(0, 3).join(" | ") : null,
      pipeline,
    };
    await env.PLUGIN_REGISTRY.put(REGISTRY_KEY, JSON.stringify(registry));
    await env.PLUGIN_REGISTRY.put(STATE_KEY, JSON.stringify(compactState(state)));
    console.log(JSON.stringify({
      event: "registry.discovery.complete",
      candidates: allCandidates.length,
      queued: queuedThisRun,
      backlog: pipeline.backlog,
      coverage: pipeline.coveragePercent,
      errors: errors.length,
    }));
    return registry;
  }

  const candidates = allCandidates.slice(0, MAX_FALLBACK_SCANS_PER_RUN);

  const results = await mapLimit(candidates, 2, async (meta) => {
    try {
      return { meta, inspection: await inspectRepository(meta, env) };
    } catch (error) {
      return { meta, error: error instanceof Error ? error.message : String(error) };
    }
  });

  let admittedThisRun = 0;
  for (const result of results) {
    const id = result.meta.full_name.toLowerCase();
    const previous = previousById.get(id);
    if ("error" in result) {
      state.seen[id] = { pushedAt: result.meta.pushed_at, checkedAt: now, outcome: "error" };
      errors.push(`${result.meta.full_name}: ${result.error}`);
      if (previous) {
        previousById.set(id, markInspectionUnavailable(previous, { kind: "error", checkedAt: now }) as PluginRecord);
      }
      continue;
    }
    const inspection = result.inspection;
    state.seen[id] = { pushedAt: result.meta.pushed_at, checkedAt: now, outcome: inspection.outcome };
    if (inspection.outcome === "listed") {
      const record = recordFromInspection(result.meta, inspection.commitSha, inspection.manifest, inspection.screening, previous, now);
      previousById.set(id, record);
      if (!previous) admittedThisRun += 1;
      continue;
    }
    if (inspection.outcome === "blocked") {
      if (previous?.curated) {
        previousById.set(id, recordFromInspection(result.meta, inspection.commitSha, inspection.manifest, inspection.screening, previous, now));
      } else {
        previousById.delete(id);
      }
      continue;
    }
    if (previous) {
      previousById.set(id, markInspectionUnavailable(previous, {
        kind: "rejected",
        checkedAt: now,
        manifest: "manifest" in inspection ? inspection.manifest : null,
      }) as PluginRecord);
    }
  }

  const plugins = [...previousById.values()].sort((a, b) => {
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    if (a.curated) return a.order - b.order;
    return b.discovery.firstSeenAt.localeCompare(a.discovery.firstSeenAt) || a.name.localeCompare(b.name);
  });
  plugins.forEach((plugin, index) => { plugin.order = index; });
  registry.plugins = plugins;
  registry.schemaVersion = 2;
  registry.generatedAt = now;
  registry.sources.topic = {
    ...registry.sources.topic,
    state: errors.length ? "partial" : "live",
    total: pageOne.total_count || registry.sources.topic.total,
    scanned: Object.keys(state.seen).length,
    error: errors.length ? errors.slice(0, 3).join(" | ") : null,
  };
  registry.automation = {
    enabled: true,
    schedule: "*/30 * * * *",
    state: errors.length ? "degraded" : "live",
    scanVersion: 1,
    lastRunAt: now,
    lastSuccessfulRunAt: errors.length ? registry.automation?.lastSuccessfulRunAt || null : now,
    checkedThisRun: candidates.length,
    queuedThisRun: 0,
    discoveredThisRun,
    admittedThisRun,
    rejectedTotal: Object.values(state.seen).filter((item) => ["rejected", "blocked"].includes(item.outcome)).length,
    error: errors.length ? errors.slice(0, 3).join(" | ") : null,
  };
  summarize(registry);

  await env.PLUGIN_REGISTRY.put(REGISTRY_KEY, JSON.stringify(registry));
  await env.PLUGIN_REGISTRY.put(STATE_KEY, JSON.stringify(compactState(state)));
  console.log(JSON.stringify({
    event: "registry.sync.complete",
    checked: candidates.length,
    discovered: discoveredThisRun,
    admitted: admittedThisRun,
    listed: registry.summary.listed,
    errors: errors.length,
  }));
  return registry;
}

export function pluginRegistryResponse(registry: PluginRegistryData) {
  return Response.json(registry, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      "X-Registry-Source": registry.automation?.state === "live" ? "cloudflare-kv" : "bundled-fallback",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
