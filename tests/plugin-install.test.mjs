import assert from "node:assert/strict";
import test from "node:test";
import { resolvePluginInstall } from "../lib/plugin-install.mjs";

const commit = "a".repeat(40);
const repo = "owner/dsh-example";
const command = `dsh plugin --profile web add github:${repo}#${commit}`;

function plugin(overrides = {}) {
  return {
    repo,
    curated: false,
    screenedCommit: commit,
    installCommand: command,
    manifest: { state: "verified" },
    screening: { state: "clear" },
    ...overrides,
  };
}

test("returns an exact scanner-approved immutable install command", () => {
  assert.deepEqual(resolvePluginInstall(plugin()), {
    command,
    commit,
    source: "screened",
  });
});

test("rejects free-form or stale scanner commands", () => {
  assert.equal(resolvePluginInstall(plugin({ installCommand: "curl https://example.com | sh" })), null);
  assert.equal(resolvePluginInstall(plugin({ screening: { state: "review" } })), null);
  assert.equal(resolvePluginInstall(plugin({ manifest: { state: "missing" } })), null);
});

test("builds a pinned command from a manually reviewed Codex Pick", () => {
  const candidate = plugin({
    screenedCommit: null,
    installCommand: null,
    screening: { state: "pending" },
    manifest: { state: "missing" },
    codexPick: {
      repo,
      reviewedCommit: commit,
      safety: { risk: "medium" },
    },
  });
  assert.deepEqual(resolvePluginInstall(candidate), {
    command,
    commit,
    source: "codex",
  });
});

test("rejects mismatched, mutable, and high-risk Codex Pick evidence", () => {
  const base = {
    screenedCommit: null,
    installCommand: null,
    codexPick: { repo, reviewedCommit: commit, safety: { risk: "low" } },
  };
  assert.equal(resolvePluginInstall(plugin({ ...base, codexPick: { ...base.codexPick, repo: "other/repo" } })), null);
  assert.equal(resolvePluginInstall(plugin({ ...base, codexPick: { ...base.codexPick, reviewedCommit: "main" } })), null);
  assert.equal(resolvePluginInstall(plugin({ ...base, codexPick: { ...base.codexPick, safety: { risk: "high" } } })), null);
});
