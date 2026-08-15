const TRACKED_COUNTER = "tracked_root_views";
const HISTORICAL_COUNTER = "historical_root_views";
const DEFAULT_DISPLAY_MULTIPLIER = 3;
const MAX_DISPLAY_MULTIPLIER = 20;

export function parseDisplayMultiplier(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DISPLAY_MULTIPLIER) {
    return DEFAULT_DISPLAY_MULTIPLIER;
  }
  return parsed;
}

function safeCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function buildVisitStats(rows, multiplierValue) {
  const multiplier = parseDisplayMultiplier(multiplierValue);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const tracked = byName.get(TRACKED_COUNTER);
  const historical = byName.get(HISTORICAL_COUNTER);
  const trackedCount = safeCount(tracked?.value);
  const historicalCount = safeCount(historical?.value);
  const realCount = trackedCount + historicalCount;
  const updatedAt = [tracked?.updated_at, historical?.updated_at]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1) ?? null;

  return {
    available: true,
    displayCount: realCount * multiplier,
    realCount,
    multiplier,
    trackedCount,
    historicalCount,
    historicalCutoff: typeof historical?.cutoff_at === "string" ? historical.cutoff_at : null,
    updatedAt,
    methodology: "root-document-requests",
  };
}

export function unavailableVisitStats(multiplierValue) {
  return {
    available: false,
    displayCount: null,
    realCount: null,
    multiplier: parseDisplayMultiplier(multiplierValue),
    trackedCount: null,
    historicalCount: null,
    historicalCutoff: null,
    updatedAt: null,
    methodology: "root-document-requests",
  };
}

export async function incrementVisit(env) {
  if (!env.VISIT_METRICS) return;
  const now = new Date().toISOString();
  await env.VISIT_METRICS
    .prepare(`
      INSERT INTO visit_counters (name, value, source, cutoff_at, updated_at)
      VALUES (?1, 1, 'worker-root-html', NULL, ?2)
      ON CONFLICT(name) DO UPDATE SET
        value = value + 1,
        updated_at = excluded.updated_at
    `)
    .bind(TRACKED_COUNTER, now)
    .run();
}

export async function readVisitStats(env) {
  if (!env.VISIT_METRICS) return unavailableVisitStats(env.VISIT_DISPLAY_MULTIPLIER);
  const result = await env.VISIT_METRICS
    .prepare(`
      SELECT name, value, source, cutoff_at, updated_at
      FROM visit_counters
      WHERE name IN (?1, ?2)
    `)
    .bind(TRACKED_COUNTER, HISTORICAL_COUNTER)
    .all();
  return buildVisitStats(result.results ?? [], env.VISIT_DISPLAY_MULTIPLIER);
}
