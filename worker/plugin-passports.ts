import type {
  PluginPassportData,
  PluginPassportVersion,
  PluginRecord,
  PluginRegistryData,
  PluginScanPipelineStatus,
} from "../lib/plugin-data";
import type { PluginEvidenceDiff, PluginEvidenceSnapshot } from "../lib/plugin-evidence.mjs";
import {
  PASSPORT_SCANNER_VERSION,
  PASSPORT_SCHEMA_VERSION,
  computeEvidenceDiff,
} from "../lib/plugin-evidence.mjs";

export interface PluginScanMessage {
  schemaVersion: 1;
  scannerVersion: number;
  jobId: string;
  repo: string;
  defaultBranch: string;
  pushedAt: string | null;
  queuedAt: string;
  metadata: {
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
  };
}

export interface PassportBindings {
  VISIT_METRICS?: D1Database;
  PLUGIN_SCAN_QUEUE?: Queue<PluginScanMessage>;
  GITHUB_TOKEN?: string;
}

interface LatestRecordRow {
  record_json: string | null;
  checked_at: string;
}

interface EvidenceRow {
  repo: string;
  commit_sha: string;
  scanner_version: number;
  checked_at: string;
  state: string;
  risk: string;
  listed: number;
  package_version: string | null;
  record_json: string | null;
  evidence_json: string;
  diff_json: string;
}

function database(env: PassportBindings) {
  return env.VISIT_METRICS || null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function validRepo(value: string) {
  return /^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(value);
}

function validRevision(value: string) {
  return value === "latest" || /^[a-f\d]{40,64}$/iu.test(value);
}

export function pluginScanJobId(repo: string, pushedAt: string | null) {
  return `${repo.toLowerCase()}@${pushedAt || "unknown"}@scan-${PASSPORT_SCANNER_VERSION}`;
}

export async function reservePluginScanJobs(
  env: PassportBindings,
  messages: PluginScanMessage[],
): Promise<PluginScanMessage[]> {
  const db = database(env);
  if (!db || !messages.length) return [];
  const statements = messages.map((message) => db.prepare(`
    INSERT INTO plugin_scan_jobs (
      job_id, repo, pushed_at, default_branch, metadata_json, status, queued_at, error
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL)
    ON CONFLICT(job_id) DO UPDATE SET
      metadata_json = excluded.metadata_json,
      default_branch = excluded.default_branch,
      status = 'queued',
      queued_at = excluded.queued_at,
      started_at = NULL,
      finished_at = NULL,
      error = NULL
    WHERE plugin_scan_jobs.status = 'error'
  `).bind(
    message.jobId,
    message.repo.toLowerCase(),
    message.pushedAt,
    message.defaultBranch,
    JSON.stringify(message.metadata),
    message.queuedAt,
  ));
  const results = await db.batch(statements);
  return messages.filter((_, index) => Number(results[index]?.meta?.changes || 0) > 0);
}

export async function markPluginScanRunning(env: PassportBindings, message: PluginScanMessage) {
  const db = database(env);
  if (!db) return;
  await db.prepare(`
    UPDATE plugin_scan_jobs
    SET status = 'running', started_at = ?, attempt_count = attempt_count + 1, error = NULL
    WHERE job_id = ?
  `).bind(new Date().toISOString(), message.jobId).run();
}

export async function markPluginScanFailed(
  env: PassportBindings,
  message: PluginScanMessage,
  error: string,
  retrying = false,
) {
  const db = database(env);
  if (!db) return;
  await db.prepare(`
    UPDATE plugin_scan_jobs
    SET status = ?, started_at = NULL, finished_at = ?, error = ?
    WHERE job_id = ?
  `).bind(
    retrying ? "queued" : "error",
    retrying ? null : new Date().toISOString(),
    error.slice(0, 2_000),
    message.jobId,
  ).run();
}

export async function markPluginScanPublishFailed(
  env: PassportBindings,
  messages: PluginScanMessage[],
  error: string,
) {
  const db = database(env);
  if (!db || !messages.length) return;
  const placeholders = messages.map(() => "?").join(", ");
  await db.prepare(`
    UPDATE plugin_scan_jobs
    SET status = 'error', started_at = NULL, finished_at = ?, error = ?
    WHERE job_id IN (${placeholders})
  `).bind(
    new Date().toISOString(),
    error.slice(0, 2_000),
    ...messages.map((message) => message.jobId),
  ).run();
}

export async function markPluginScanRejected(env: PassportBindings, message: PluginScanMessage, reason: string) {
  const db = database(env);
  if (!db) return;
  await db.prepare(`
    UPDATE plugin_scan_jobs
    SET status = 'rejected', finished_at = ?, error = ?
    WHERE job_id = ?
  `).bind(new Date().toISOString(), reason.slice(0, 2_000), message.jobId).run();
}

export async function persistPluginEvidence(
  env: PassportBindings,
  message: PluginScanMessage,
  record: PluginRecord | null,
  evidence: PluginEvidenceSnapshot,
  listed: boolean,
) {
  const db = database(env);
  if (!db) return { record, diff: computeEvidenceDiff(null, evidence), versionCount: 1 };

  const [previousRow, countRow, existingRow] = await Promise.all([
    db.prepare(`
      SELECT evidence_json
      FROM plugin_evidence
      WHERE repo = ? AND commit_sha <> ?
      ORDER BY checked_at DESC
      LIMIT 1
    `).bind(message.repo.toLowerCase(), evidence.commitSha).first<{ evidence_json: string }>(),
    db.prepare("SELECT COUNT(*) AS count FROM plugin_evidence WHERE repo = ?")
      .bind(message.repo.toLowerCase()).first<{ count: number }>(),
    db.prepare(`
      SELECT 1 AS present
      FROM plugin_evidence
      WHERE repo = ? AND commit_sha = ? AND scanner_version = ?
      LIMIT 1
    `).bind(message.repo.toLowerCase(), evidence.commitSha, evidence.scannerVersion).first<{ present: number }>(),
  ]);
  const previousEvidence = parseJson<PluginEvidenceSnapshot>(previousRow?.evidence_json || null);
  const diff = computeEvidenceDiff(previousEvidence, evidence);
  const versionCount = Number(countRow?.count || 0) + (existingRow?.present ? 0 : 1);
  const enrichedRecord = record ? {
    ...record,
    passport: {
      evidenceId: evidence.evidenceId,
      versionCount,
      latestCommit: evidence.commitSha,
      latestCheckedAt: evidence.checkedAt,
      diffSeverity: diff.severity,
      verificationScore: evidence.verification.score,
      verificationPossible: evidence.verification.possibleScore,
    },
  } satisfies PluginRecord : null;
  const recordJson = enrichedRecord ? JSON.stringify(enrichedRecord) : null;
  const evidenceJson = JSON.stringify(evidence);
  const diffJson = JSON.stringify(diff);
  const finalStatus = evidence.screening.state === "blocked"
    ? "blocked"
    : listed
      ? "succeeded"
      : "rejected";

  await db.batch([
    db.prepare(`
      INSERT INTO plugin_evidence (
        repo, commit_sha, scanner_version, checked_at, state, risk, listed,
        package_version, record_json, evidence_json, diff_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, commit_sha, scanner_version) DO UPDATE SET
        checked_at = excluded.checked_at,
        state = excluded.state,
        risk = excluded.risk,
        listed = excluded.listed,
        package_version = excluded.package_version,
        record_json = excluded.record_json,
        evidence_json = excluded.evidence_json,
        diff_json = excluded.diff_json
    `).bind(
      message.repo.toLowerCase(),
      evidence.commitSha,
      evidence.scannerVersion,
      evidence.checkedAt,
      evidence.screening.state,
      evidence.screening.risk,
      listed ? 1 : 0,
      evidence.package.version,
      recordJson,
      evidenceJson,
      diffJson,
    ),
    db.prepare(`
      INSERT INTO plugin_latest (
        repo, commit_sha, scanner_version, checked_at, state, risk, listed,
        record_json, evidence_json, diff_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo) DO UPDATE SET
        commit_sha = excluded.commit_sha,
        scanner_version = excluded.scanner_version,
        checked_at = excluded.checked_at,
        state = excluded.state,
        risk = excluded.risk,
        listed = excluded.listed,
        record_json = excluded.record_json,
        evidence_json = excluded.evidence_json,
        diff_json = excluded.diff_json
      WHERE excluded.checked_at >= plugin_latest.checked_at
    `).bind(
      message.repo.toLowerCase(),
      evidence.commitSha,
      evidence.scannerVersion,
      evidence.checkedAt,
      evidence.screening.state,
      evidence.screening.risk,
      listed ? 1 : 0,
      recordJson,
      evidenceJson,
      diffJson,
    ),
    db.prepare(`
      UPDATE plugin_scan_jobs
      SET status = ?, finished_at = ?, error = NULL
      WHERE job_id = ?
    `).bind(finalStatus, evidence.checkedAt, message.jobId),
  ]);
  return { record: enrichedRecord, diff, versionCount };
}

export async function mergeLatestPluginEvidence(
  env: PassportBindings,
  registry: PluginRegistryData,
): Promise<PluginRegistryData> {
  const db = database(env);
  if (!db) return registry;
  try {
    const result = await db.prepare(`
      SELECT record_json, checked_at
      FROM plugin_latest
      WHERE listed = 1 AND record_json IS NOT NULL
      ORDER BY checked_at DESC
    `).all<LatestRecordRow>();
    const merged = new Map(registry.plugins.map((plugin) => [plugin.id, plugin]));
    let latestCheckedAt = registry.generatedAt;
    for (const row of result.results || []) {
      const record = parseJson<PluginRecord>(row.record_json);
      if (!record?.id || !validRepo(record.repo)) continue;
      merged.set(record.id, record);
      if (row.checked_at > latestCheckedAt) latestCheckedAt = row.checked_at;
    }
    const plugins = [...merged.values()].sort((a, b) => {
      if (a.curated !== b.curated) return a.curated ? -1 : 1;
      if (a.curated) return a.order - b.order;
      return b.discovery.firstSeenAt.localeCompare(a.discovery.firstSeenAt) || a.name.localeCompare(b.name);
    });
    plugins.forEach((plugin, index) => { plugin.order = index; });
    return { ...registry, generatedAt: latestCheckedAt, plugins };
  } catch (error) {
    console.error(JSON.stringify({
      event: "passport.registry-overlay.error",
      error: error instanceof Error ? error.message : String(error),
    }));
    return registry;
  }
}

function fallbackEvidence(record: PluginRecord): PluginEvidenceSnapshot {
  return {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    scannerVersion: record.screening.version,
    evidenceId: `${record.repo.toLowerCase()}@pending#registry`,
    repo: record.repo,
    commitSha: record.screenedCommit || "pending",
    checkedAt: record.screening.checkedAt,
    repository: {
      owner: record.owner,
      defaultBranch: record.defaultBranch,
      archived: record.archived,
      license: record.license,
    },
    package: {
      name: record.manifest.packageName,
      version: record.manifest.version,
      dependencies: [],
      peerDependencies: [],
      optionalDependencies: [],
      devDependencies: [],
      lifecycleScripts: Object.fromEntries(record.manifest.lifecycleScripts.map((name) => [name, "declared"])),
      maintainers: [record.owner],
    },
    manifest: record.manifest,
    capabilities: Object.fromEntries(
      record.screening.findings
        .filter((finding) => [
          "permission-bypass", "dynamic-code", "destructive-filesystem", "shell-execution",
          "network-egress", "filesystem-write", "credential-access", "public-listener",
          "html-execution", "telemetry",
        ].includes(finding.id))
        .map((finding) => [finding.id, finding.files]),
    ),
    externalDomains: [],
    disclosure: {
      security: record.screening.checks.securityDisclosure,
      permissions: false,
      dataUse: false,
      telemetry: false,
      disableOrOptOut: false,
    },
    verification: {
      immutableCommit: Boolean(record.screenedCommit),
      manifest: record.screening.checks.manifest,
      source: record.screening.checks.source,
      readme: record.screening.checks.readme,
      lockfile: record.screening.checks.lockfile,
      license: record.screening.checks.license,
      securityDisclosure: record.screening.checks.securityDisclosure,
      filesInspected: record.screening.filesInspected,
      score: Object.values(record.screening.checks).filter(Boolean).length + (record.screenedCommit ? 1 : 0),
      possibleScore: Object.keys(record.screening.checks).length + 1,
    },
    screening: record.screening,
  };
}

function versionFromRow(row: EvidenceRow): PluginPassportVersion | null {
  const diff = parseJson<PluginEvidenceDiff>(row.diff_json);
  if (!diff) return null;
  return {
    commitSha: row.commit_sha,
    scannerVersion: row.scanner_version,
    checkedAt: row.checked_at,
    state: row.state as PluginPassportVersion["state"],
    risk: row.risk as PluginPassportVersion["risk"],
    listed: Boolean(row.listed),
    packageVersion: row.package_version,
    diff,
  };
}

export async function readPluginPassport(
  env: PassportBindings,
  repo: string,
  revision: string,
  fallbackRecord: PluginRecord | null,
): Promise<PluginPassportData | null> {
  if (!validRepo(repo) || !validRevision(revision)) return null;
  const db = database(env);
  if (db) {
    try {
      const currentSql = revision === "latest"
        ? "SELECT * FROM plugin_latest WHERE repo = ? LIMIT 1"
        : "SELECT * FROM plugin_evidence WHERE repo = ? AND commit_sha = ? ORDER BY scanner_version DESC LIMIT 1";
      const currentStatement = revision === "latest"
        ? db.prepare(currentSql).bind(repo.toLowerCase())
        : db.prepare(currentSql).bind(repo.toLowerCase(), revision.toLowerCase());
      const [currentRow, historyResult] = await Promise.all([
        currentStatement.first<EvidenceRow>(),
        db.prepare(`
          SELECT repo, commit_sha, scanner_version, checked_at, state, risk, listed,
                 package_version, record_json, evidence_json, diff_json
          FROM plugin_evidence
          WHERE repo = ?
          ORDER BY checked_at DESC
          LIMIT 40
        `).bind(repo.toLowerCase()).all<EvidenceRow>(),
      ]);
      if (currentRow) {
        const evidence = parseJson<PluginEvidenceSnapshot>(currentRow.evidence_json);
        const diff = parseJson<PluginEvidenceDiff>(currentRow.diff_json);
        if (evidence && diff) {
          return {
            schemaVersion: PASSPORT_SCHEMA_VERSION,
            source: "d1",
            repo,
            requestedRevision: revision,
            current: {
              record: parseJson<PluginRecord>(currentRow.record_json),
              evidence,
              diff,
            },
            history: (historyResult.results || []).flatMap((row) => {
              const version = versionFromRow(row);
              return version ? [version] : [];
            }),
          };
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "passport.read.error",
        repo,
        revision,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  if (!fallbackRecord || revision !== "latest") return null;
  const evidence = fallbackEvidence(fallbackRecord);
  const diff = computeEvidenceDiff(null, evidence);
  return {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    source: "registry-fallback",
    repo,
    requestedRevision: revision,
    current: { record: fallbackRecord, evidence, diff },
    history: [{
      commitSha: evidence.commitSha,
      scannerVersion: evidence.scannerVersion,
      checkedAt: evidence.checkedAt,
      state: evidence.screening.state,
      risk: evidence.screening.risk,
      listed: true,
      packageVersion: evidence.package.version,
      diff,
    }],
  };
}

export async function readPluginScanPipelineStatus(
  env: PassportBindings,
  listedPlugins: number,
): Promise<PluginScanPipelineStatus> {
  const emptyJobs = { queued: 0, running: 0, succeeded: 0, rejected: 0, blocked: 0, error: 0 };
  const db = database(env);
  if (!db) {
    return {
      available: false,
      mode: env.PLUGIN_SCAN_QUEUE ? "queue" : "inline",
      backlog: 0,
      oldestQueuedAt: null,
      estimatedMinutes: null,
      evidencePlugins: 0,
      evidenceVersions: 0,
      remainingPlugins: listedPlugins,
      coveragePercent: 0,
      jobs: emptyJobs,
    };
  }
  try {
    const [jobsResult, latestResult, versionsResult, oldestResult, queueMetrics] = await Promise.all([
      db.prepare("SELECT status, COUNT(*) AS count FROM plugin_scan_jobs GROUP BY status").all<{ status: keyof typeof emptyJobs; count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM plugin_latest WHERE listed = 1").first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM plugin_evidence").first<{ count: number }>(),
      db.prepare("SELECT MIN(queued_at) AS oldest FROM plugin_scan_jobs WHERE status IN ('queued', 'running')").first<{ oldest: string | null }>(),
      env.PLUGIN_SCAN_QUEUE?.metrics().catch(() => null) || Promise.resolve(null),
    ]);
    const jobs = { ...emptyJobs };
    for (const row of jobsResult.results || []) {
      if (row.status in jobs) jobs[row.status] = Number(row.count || 0);
    }
    const evidencePlugins = Number(latestResult?.count || 0);
    const backlog = Number(queueMetrics?.backlogCount ?? jobs.queued + jobs.running);
    const remainingPlugins = Math.max(0, listedPlugins - evidencePlugins);
    const discoveryBatch = env.GITHUB_TOKEN?.trim() ? 40 : 12;
    const discoveryMinutes = remainingPlugins ? Math.ceil(remainingPlugins / discoveryBatch) * (12 * 60) : 0;
    const drainMinutes = backlog ? Math.ceil(backlog / 10) : 0;
    return {
      available: true,
      mode: env.PLUGIN_SCAN_QUEUE ? "queue" : "inline",
      backlog,
      oldestQueuedAt: oldestResult?.oldest || null,
      estimatedMinutes: remainingPlugins || backlog ? Math.max(1, discoveryMinutes, drainMinutes) : 0,
      evidencePlugins,
      evidenceVersions: Number(versionsResult?.count || 0),
      remainingPlugins,
      coveragePercent: listedPlugins > 0 ? Math.min(100, Math.round((evidencePlugins / listedPlugins) * 1_000) / 10) : 0,
      jobs,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "passport.pipeline-status.error",
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      available: false,
      mode: env.PLUGIN_SCAN_QUEUE ? "queue" : "inline",
      backlog: 0,
      oldestQueuedAt: null,
      estimatedMinutes: null,
      evidencePlugins: 0,
      evidenceVersions: 0,
      remainingPlugins: listedPlugins,
      coveragePercent: 0,
      jobs: emptyJobs,
    };
  }
}

export function pluginPassportResponse(passport: PluginPassportData) {
  return Response.json(passport, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
      "X-Passport-Source": passport.source,
    },
  });
}
