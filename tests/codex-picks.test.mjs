import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyCodexPicks, normalizeCodexPicksFeed } from "../lib/codex-picks.mjs";

const commit = "a".repeat(40);
const feed = {
  schemaVersion: 1,
  updatedAt: "2026-08-16T12:00:00Z",
  source: "test-review",
  repository: "https://github.com/cclank/dsh-plugin-hub",
  picks: [{
    repo: "Owner/Example",
    pickedAt: "2026-08-16T11:00:00Z",
    reviewedCommit: commit.toUpperCase(),
    category: "tools",
    summary: { zh: "工具摘要", en: "Tool summary" },
    reason: { zh: "有明确价值和证据。", en: "Clear value and evidence." },
    safety: { risk: "low", zh: "只读。", en: "Read only." },
  }],
};

test("normalizes a bounded Codex picks feed", () => {
  const normalized = normalizeCodexPicksFeed(feed);
  assert.equal(normalized.picks[0].repo, "owner/example");
  assert.equal(normalized.picks[0].reviewedCommit, commit);
  assert.equal(normalized.updatedAt, "2026-08-16T12:00:00.000Z");
});

test("rejects duplicate repositories and mutable revisions", () => {
  assert.throws(
    () => normalizeCodexPicksFeed({ ...feed, picks: [...feed.picks, feed.picks[0]] }),
    /Duplicate Codex pick/u,
  );
  assert.throws(
    () => normalizeCodexPicksFeed({
      ...feed,
      picks: [{ ...feed.picks[0], reviewedCommit: "main" }],
    }),
    /immutable commit/u,
  );
});

test("overlays picks without retaining removed editorial metadata", () => {
  const plugin = { id: "owner/example", repo: "owner/example", codexPick: { stale: true } };
  const other = { id: "owner/other", repo: "owner/other", codexPick: { stale: true } };
  const registry = {
    plugins: [plugin, other],
    sources: {},
    summary: { listed: 2 },
  };
  const next = applyCodexPicks(registry, feed, { state: "live", url: "https://example.test/picks.json" });
  assert.equal(next.plugins[0].codexPick.reviewedCommit, commit);
  assert.equal("codexPick" in next.plugins[1], false);
  assert.equal(next.summary.codexPicks, 1);
  assert.equal(next.sources.codex.matched, 1);
  assert.equal(next.sources.codex.state, "live");
});

test("ships only immutable, unique Codex picks", async () => {
  const raw = JSON.parse(await readFile(new URL("../data/codex-picks.json", import.meta.url), "utf8"));
  const normalized = normalizeCodexPicksFeed(raw);
  assert.ok(normalized.picks.length >= 4);
  assert.equal(new Set(normalized.picks.map((pick) => pick.repo)).size, normalized.picks.length);
  assert.ok(normalized.picks.every((pick) => /^[a-f\d]{40,64}$/u.test(pick.reviewedCommit)));
});
