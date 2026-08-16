import assert from "node:assert/strict";
import test from "node:test";

const commit = "d".repeat(40);
const evidence = {
  schemaVersion: 1,
  scannerVersion: 2,
  evidenceId: `owner/example@${commit}#scan-2`,
  repo: "owner/example",
  commitSha: commit,
  checkedAt: "2026-08-16T08:00:00.000Z",
  repository: { owner: "owner", defaultBranch: "main", archived: false, license: "MIT" },
  package: {
    name: "dsh-example",
    version: "1.0.0",
    dependencies: [],
    peerDependencies: [],
    optionalDependencies: [],
    devDependencies: [],
    lifecycleScripts: {},
    maintainers: ["owner"],
  },
  manifest: {
    state: "verified",
    branch: "main",
    kinds: ["plugin"],
    packageName: "dsh-example",
    version: "1.0.0",
    lifecycleScripts: [],
    runtimeDependencies: 0,
    declaredPaths: ["src/index.ts"],
    invalidDeclaredPaths: [],
  },
  capabilities: {},
  externalDomains: [],
  disclosure: { security: true, permissions: true, dataUse: true, telemetry: false, disableOrOptOut: false },
  verification: {
    immutableCommit: true,
    manifest: true,
    source: true,
    readme: true,
    lockfile: true,
    license: true,
    securityDisclosure: true,
    filesInspected: ["package.json", "src/index.ts"],
    score: 7,
    possibleScore: 7,
  },
  screening: {
    version: 1,
    scope: "source",
    state: "clear",
    risk: "low",
    checkedAt: "2026-08-16T08:00:00.000Z",
    findings: [],
    filesInspected: ["package.json", "src/index.ts"],
    checks: { manifest: true, license: true, readme: true, lockfile: true, source: true, securityDisclosure: true },
  },
};
const diff = {
  fromCommit: null,
  toCommit: commit,
  changedAt: evidence.checkedAt,
  changed: false,
  severity: "baseline",
  packageVersion: { from: null, to: "1.0.0" },
  risk: { from: null, to: "low" },
  state: { from: null, to: "clear" },
  dependencies: { added: [], removed: [] },
  peerDependencies: { added: [], removed: [] },
  lifecycleScripts: { added: [], removed: [] },
  capabilities: { added: [], removed: [] },
  externalDomains: { added: [], removed: [] },
  maintainers: { added: [], removed: [] },
  manifestKinds: { added: [], removed: [] },
};
const row = {
  repo: "owner/example",
  commit_sha: commit,
  scanner_version: 2,
  checked_at: evidence.checkedAt,
  state: "clear",
  risk: "low",
  listed: 1,
  package_version: "1.0.0",
  record_json: null,
  evidence_json: JSON.stringify(evidence),
  diff_json: JSON.stringify(diff),
};

function passportDatabase() {
  return {
    prepare(sql) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      const statement = {
        bindings: [],
        bind(...values) {
          this.bindings = values;
          return this;
        },
        async first() {
          if (/^SELECT \* FROM plugin_evidence/iu.test(normalized)) return row;
          if (/^SELECT \* FROM plugin_latest/iu.test(normalized)) return row;
          return null;
        },
        async all() {
          if (/^SELECT record_json, checked_at FROM plugin_latest/iu.test(normalized)) {
            return { success: true, results: [] };
          }
          if (/^SELECT repo, commit_sha/iu.test(normalized)) {
            return { success: true, results: [row] };
          }
          return { success: true, results: [] };
        },
      };
      return statement;
    },
  };
}

async function workerRequest(path, env = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      ...env,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("serves an immutable plugin passport as raw JSON", async () => {
  const response = await workerRequest(`/api/passports/owner/example/${commit}`, {
    VISIT_METRICS: passportDatabase(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-passport-source"), "d1");
  const body = await response.json();
  assert.equal(body.repo, "owner/example");
  assert.equal(body.current.evidence.commitSha, commit);
  assert.equal(body.current.diff.severity, "baseline");
  assert.equal(body.history.length, 1);
});

test("rewrites permanent passport pages to the application shell", async () => {
  const response = await workerRequest(`/p/owner/example/${commit}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/html/iu);
  const html = await response.text();
  assert.match(html, /DSH 插件资源站/);
});
