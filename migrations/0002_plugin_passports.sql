CREATE TABLE IF NOT EXISTS plugin_scan_jobs (
  job_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pushed_at TEXT,
  default_branch TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'rejected', 'blocked', 'error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_scan_jobs_status_queued
  ON plugin_scan_jobs(status, queued_at);

CREATE INDEX IF NOT EXISTS idx_plugin_scan_jobs_repo
  ON plugin_scan_jobs(repo, queued_at DESC);

CREATE TABLE IF NOT EXISTS plugin_evidence (
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  scanner_version INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
  package_version TEXT,
  record_json TEXT,
  evidence_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  PRIMARY KEY (repo, commit_sha, scanner_version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_evidence_repo_checked
  ON plugin_evidence(repo, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_plugin_evidence_state
  ON plugin_evidence(state, risk, checked_at DESC);

CREATE TABLE IF NOT EXISTS plugin_latest (
  repo TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  scanner_version INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
  record_json TEXT,
  evidence_json TEXT NOT NULL,
  diff_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_latest_listed
  ON plugin_latest(listed, checked_at DESC);
