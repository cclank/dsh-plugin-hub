import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryFromText,
  markInspectionUnavailable,
  manifestSummary,
  normalizeRepositoryPath,
  sanitizeRegistryInstallEvidence,
  screenRepository,
} from "../lib/plugin-screening.mjs";

const safeMeta = {
  archived: false,
  license: { spdx_id: "MIT" },
};

function manifest(pkg = {}) {
  return manifestSummary({
    name: "safe-plugin",
    version: "1.0.0",
    main: "./lib/index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    ...pkg,
  }, "main");
}

test("normalizes only repository-relative declared paths", () => {
  assert.equal(normalizeRepositoryPath("./src/index.ts"), "src/index.ts");
  assert.equal(normalizeRepositoryPath("../outside.ts"), null);
  assert.equal(normalizeRepositoryPath("/etc/passwd"), null);
  assert.equal(normalizeRepositoryPath("https://example.com/a.js"), null);
});

test("marks a fully inspectable local-only plugin as clear", () => {
  const result = screenRepository({
    meta: safeMeta,
    manifest: manifest(),
    files: ["README.md", "LICENSE", "pnpm-lock.yaml", "package.json"],
    sourceFiles: [{ path: "lib/index.js", text: "export function apply(ctx) { return ctx; }" }],
    readme: "## Security\nThis plugin has no network, shell, or file access.",
    checkedAt: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(result.state, "clear");
  assert.equal(result.risk, "low");
  assert.equal(result.checks.source, true);
  assert.equal(result.checks.securityDisclosure, true);
});

test("flags lifecycle, network, filesystem, and credential access for review", () => {
  const result = screenRepository({
    meta: safeMeta,
    manifest: manifest({ scripts: { prepare: "npm run build" } }),
    files: ["README.md", "package.json"],
    sourceFiles: [{
      path: "lib/index.js",
      text: "const key = process.env.API_KEY; await fetch(url); await writeFile(path, key);",
    }],
    readme: "Plugin docs",
  });
  assert.equal(result.state, "review");
  assert.equal(result.risk, "medium");
  assert.ok(result.findings.some((finding) => finding.id === "lifecycle-script"));
  assert.ok(result.findings.some((finding) => finding.id === "network-egress"));
  assert.ok(result.findings.some((finding) => finding.id === "filesystem-write"));
  assert.ok(result.findings.some((finding) => finding.id === "credential-access"));
});

test("keeps oversized public files in review without claiming they were inspected", () => {
  const result = screenRepository({
    meta: safeMeta,
    manifest: manifest(),
    files: ["README.md", "package-lock.json", "package.json"],
    sourceFiles: [{ path: "lib/index.js", text: "export const safe = true;" }],
    unavailableFiles: ["README.md", "lib/client.js"],
    readme: null,
  });
  assert.equal(result.state, "review");
  assert.equal(result.risk, "medium");
  assert.ok(result.findings.some((finding) => finding.id === "inspection-incomplete"));
  assert.deepEqual(result.filesInspected, ["package.json", "lib/index.js"]);
});

test("blocks permission bypass and dynamic code execution signals", () => {
  const result = screenRepository({
    meta: safeMeta,
    manifest: manifest(),
    files: ["README.md", "package-lock.json", "package.json"],
    sourceFiles: [{ path: "lib/index.js", text: "eval(code); run('--dangerously-skip-permissions');" }],
    readme: "Security boundary",
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.risk, "high");
  assert.ok(result.findings.some((finding) => finding.id === "permission-bypass"));
  assert.ok(result.findings.some((finding) => finding.id === "dynamic-code"));
});

test("extracts dsh manifest paths and classifies common plugin categories", () => {
  const summary = manifest({
    exports: { ".": { default: "./lib/index.js" }, "./client": "./lib/client.js" },
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web" },
    },
  });
  assert.equal(summary.state, "verified");
  assert.deepEqual(summary.kinds, ["bundle", "client"]);
  assert.ok(summary.declaredPaths.includes("lib/client.js"));
  assert.equal(categoryFromText("desktop notification bridge"), "notify");
  assert.equal(categoryFromText("OCR vision document tool"), "tools");
});

test("withdraws stale installation evidence when a rescan cannot complete", () => {
  const previous = {
    defaultBranch: "main",
    manifest: manifest(),
    screenedCommit: "a".repeat(40),
    installCommand: `dsh plugin --profile web add github:owner/plugin#${"a".repeat(40)}`,
    discovery: { source: "curated", firstSeenAt: "2026-08-01", lastSeenAt: "2026-08-10" },
    screening: screenRepository({
      meta: safeMeta,
      manifest: manifest(),
      files: ["README.md", "package-lock.json"],
      sourceFiles: [{ path: "lib/index.js", text: "export const safe = true;" }],
      readme: "Security",
    }),
  };

  const unavailable = markInspectionUnavailable(previous, {
    kind: "error",
    checkedAt: "2026-08-14T10:00:00.000Z",
  });
  assert.equal(unavailable.installCommand, null);
  assert.equal(unavailable.screenedCommit, null);
  assert.equal(unavailable.screening.state, "review");
  assert.equal(unavailable.discovery.lastSeenAt, "2026-08-14T10:00:00.000Z");

  const rejected = markInspectionUnavailable(previous, {
    kind: "rejected",
    checkedAt: "2026-08-14T10:05:00.000Z",
  });
  assert.equal(rejected.installCommand, null);
  assert.equal(rejected.screening.state, "blocked");
  assert.equal(rejected.screening.risk, "high");
});

test("removes unpinned or mismatched commands from stored registry data", () => {
  const commit = "b".repeat(40);
  const base = {
    repo: "owner/plugin",
    curated: true,
    manifest: { state: "verified" },
    screening: { state: "review" },
  };
  const registry = sanitizeRegistryInstallEvidence({
    plugins: [
      { ...base, screenedCommit: null, installCommand: "dsh plugin --profile web add github:owner/plugin" },
      { ...base, screenedCommit: commit, installCommand: "dsh plugin --profile web add github:owner/plugin#wrong" },
      { ...base, screenedCommit: commit, installCommand: `dsh plugin --profile web add github:owner/plugin#${commit}` },
    ],
  });
  assert.equal(registry.plugins[0].installCommand, null);
  assert.equal(registry.plugins[1].installCommand, null);
  assert.equal(registry.plugins[2].installCommand, `dsh plugin --profile web add github:owner/plugin#${commit}`);
});
