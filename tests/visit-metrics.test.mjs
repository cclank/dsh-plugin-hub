import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVisitStats,
  parseDisplayMultiplier,
  unavailableVisitStats,
} from "../lib/visit-metrics.mjs";

test("keeps real visit totals separate from the display multiplier", () => {
  const stats = buildVisitStats([
    {
      name: "historical_root_views",
      value: 2_783,
      source: "cloudflare-http-requests",
      cutoff_at: "2026-08-15T00:00:00Z",
      updated_at: "2026-08-15T00:01:00Z",
    },
    {
      name: "tracked_root_views",
      value: 17,
      source: "worker-root-html",
      cutoff_at: null,
      updated_at: "2026-08-15T00:02:00Z",
    },
  ], "3");

  assert.equal(stats.realCount, 2_800);
  assert.equal(stats.displayCount, 8_400);
  assert.equal(stats.historicalCount, 2_783);
  assert.equal(stats.trackedCount, 17);
  assert.equal(stats.multiplier, 3);
  assert.equal(stats.historicalCutoff, "2026-08-15T00:00:00Z");
  assert.equal(stats.updatedAt, "2026-08-15T00:02:00Z");
});

test("bounds invalid display multipliers without changing stored counts", () => {
  assert.equal(parseDisplayMultiplier("1"), 1);
  assert.equal(parseDisplayMultiplier("20"), 20);
  assert.equal(parseDisplayMultiplier("0"), 3);
  assert.equal(parseDisplayMultiplier("999"), 3);
  assert.equal(parseDisplayMultiplier("not-a-number"), 3);

  const stats = unavailableVisitStats("999");
  assert.equal(stats.available, false);
  assert.equal(stats.displayCount, null);
  assert.equal(stats.realCount, null);
  assert.equal(stats.multiplier, 3);
});
