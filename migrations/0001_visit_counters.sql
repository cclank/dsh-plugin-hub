CREATE TABLE IF NOT EXISTS visit_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  source TEXT NOT NULL,
  cutoff_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO visit_counters (name, value, source, cutoff_at)
VALUES ('tracked_root_views', 0, 'worker-root-html', NULL);

INSERT OR IGNORE INTO visit_counters (name, value, source, cutoff_at)
VALUES ('historical_root_views', 0, 'cloudflare-http-requests', NULL);
