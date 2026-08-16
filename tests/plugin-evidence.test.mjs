import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidenceSnapshot,
  computeEvidenceDiff,
} from "../lib/plugin-evidence.mjs";

function screening({ risk = "low", state = "clear", findings = [] } = {}) {
  return {
    version: 1,
    scope: "source",
    state,
    risk,
    checkedAt: "2026-08-16T08:00:00.000Z",
    findings,
    filesInspected: ["package.json", "src/index.ts"],
    checks: {
      manifest: true,
      license: true,
      readme: true,
      lockfile: true,
      source: true,
      securityDisclosure: true,
    },
  };
}

function manifest(version) {
  return {
    state: "verified",
    branch: "main",
    kinds: ["plugin"],
    packageName: "dsh-example",
    version,
    lifecycleScripts: [],
    runtimeDependencies: 1,
    declaredPaths: ["src/index.ts"],
    invalidDeclaredPaths: [],
  };
}

function snapshot({
  commit,
  version,
  dependencies,
  scripts = {},
  maintainers = [],
  source = "export const plugin = true;",
  readme = "Security and permissions are documented. Disable telemetry with TELEMETRY=0.",
  scan = screening(),
}) {
  return buildEvidenceSnapshot({
    repo: "owner/example",
    commitSha: commit,
    checkedAt: scan.checkedAt,
    meta: {
      owner: { login: "owner" },
      default_branch: "main",
      archived: false,
      license: { spdx_id: "MIT" },
    },
    packageDocument: {
      name: "dsh-example",
      version,
      dependencies,
      scripts,
      maintainers,
      dsh: { plugin: {} },
    },
    manifest: manifest(version),
    screening: scan,
    rootFiles: ["package.json", "README.md", "SECURITY.md", "package-lock.json"],
    sourceFiles: [{ path: "src/index.ts", text: source }],
    readme,
    securityText: "Security policy and privacy data handling.",
  });
}

test("builds a three-layer immutable evidence snapshot", () => {
  const evidence = snapshot({
    commit: "a".repeat(40),
    version: "1.0.0",
    dependencies: { zod: "^4.0.0" },
    source: "await fetch('https://api.example.com/v1');",
    scan: screening({
      risk: "medium",
      state: "review",
      findings: [{
        id: "network-egress",
        severity: "medium",
        label: { zh: "网络", en: "Network" },
        files: ["src/index.ts"],
      }],
    }),
  });

  assert.equal(evidence.evidenceId, `owner/example@${"a".repeat(40)}#scan-2`);
  assert.deepEqual(evidence.package.dependencies, ["zod@^4.0.0"]);
  assert.deepEqual(evidence.capabilities, { "network-egress": ["src/index.ts"] });
  assert.deepEqual(evidence.externalDomains, ["api.example.com"]);
  assert.equal(evidence.disclosure.permissions, true);
  assert.equal(evidence.disclosure.disableOrOptOut, true);
  assert.equal(evidence.verification.score, evidence.verification.possibleScore);
});

test("classifies permission and supply-chain changes", () => {
  const previous = snapshot({
    commit: "a".repeat(40),
    version: "1.0.0",
    dependencies: { zod: "^4.0.0" },
  });
  const current = snapshot({
    commit: "b".repeat(40),
    version: "1.1.0",
    dependencies: { zod: "^4.0.0", axios: "^1.0.0" },
    scripts: { prepare: "tsdown" },
    maintainers: [{ name: "new-maintainer" }],
    source: "const flag = '--dangerously-skip-permissions'; await fetch('https://api.vendor.test/v1');",
    scan: screening({
      risk: "high",
      state: "blocked",
      findings: [
        { id: "permission-bypass", severity: "high", label: { zh: "绕过", en: "Bypass" }, files: ["src/index.ts"] },
        { id: "network-egress", severity: "medium", label: { zh: "网络", en: "Network" }, files: ["src/index.ts"] },
      ],
    }),
  });
  const diff = computeEvidenceDiff(previous, current);

  assert.equal(diff.changed, true);
  assert.equal(diff.severity, "high");
  assert.deepEqual(diff.dependencies.added, ["axios@^1.0.0"]);
  assert.deepEqual(diff.lifecycleScripts.added, ["prepare"]);
  assert.deepEqual(diff.capabilities.added, ["network-egress", "permission-bypass"]);
  assert.deepEqual(diff.externalDomains.added, ["api.vendor.test"]);
  assert.deepEqual(diff.maintainers.added, ["new-maintainer"]);
});

test("marks the first scan as a baseline", () => {
  const evidence = snapshot({
    commit: "c".repeat(40),
    version: "1.0.0",
    dependencies: {},
  });
  const diff = computeEvidenceDiff(null, evidence);
  assert.equal(diff.changed, false);
  assert.equal(diff.severity, "baseline");
  assert.equal(diff.fromCommit, null);
});
