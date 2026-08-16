export const PASSPORT_SCHEMA_VERSION = 1;
export const PASSPORT_SCANNER_VERSION = 2;

const CAPABILITY_IDS = new Set([
  "permission-bypass",
  "dynamic-code",
  "destructive-filesystem",
  "shell-execution",
  "network-egress",
  "filesystem-write",
  "credential-access",
  "public-listener",
  "html-execution",
  "telemetry",
]);

const HIGH_CAPABILITIES = new Set([
  "permission-bypass",
  "dynamic-code",
  "destructive-filesystem",
]);

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sortedUnique(values, limit = 200) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

function dependencyEntries(value) {
  return sortedUnique(Object.entries(asObject(value)).map(([name, range]) => (
    `${name}@${typeof range === "string" ? range : String(range)}`
  )));
}

function lifecycleCommands(pkg) {
  const scripts = asObject(asObject(pkg).scripts);
  return Object.fromEntries(
    LIFECYCLE_SCRIPTS.flatMap((name) => (
      typeof scripts[name] === "string" && scripts[name].trim()
        ? [[name, scripts[name].trim().slice(0, 500)]]
        : []
    )),
  );
}

function maintainerName(value) {
  if (typeof value === "string") return value.replace(/\s*<[^>]+>\s*/gu, " ").trim();
  const record = asObject(value);
  return typeof record.name === "string" ? record.name.trim() : "";
}

function packageMaintainers(pkg, owner) {
  const record = asObject(pkg);
  const values = [record.author, ...(Array.isArray(record.maintainers) ? record.maintainers : []), ...(Array.isArray(record.contributors) ? record.contributors : [])];
  return sortedUnique([owner, ...values.map(maintainerName)], 40);
}

function extractDomains(documents) {
  const domains = [];
  const pattern = /https?:\/\/[^\s"'`()<>\]]+/giu;
  for (const document of documents) {
    if (typeof document !== "string") continue;
    for (const match of document.slice(0, 180_000).matchAll(pattern)) {
      try {
        domains.push(new URL(match[0].replace(/[.,;:!?]+$/u, "")).hostname.toLowerCase());
      } catch {
        // Ignore malformed URL-shaped strings from source comments or tests.
      }
    }
  }
  return sortedUnique(domains, 80);
}

function disclosureSummary(readme, securityText) {
  const text = `${readme || ""}\n${securityText || ""}`.slice(0, 240_000);
  return {
    security: /security|安全|威胁|漏洞/iu.test(text),
    permissions: /permission|权限|sandbox|沙箱|shell|文件访问|网络访问/iu.test(text),
    dataUse: /privacy|隐私|data\s+(?:use|handling|collection)|数据处理|数据去向|外发/iu.test(text),
    telemetry: /telemetry|analytics|遥测|统计|埋点/iu.test(text),
    disableOrOptOut: /opt[- ]?out|disable|关闭|禁用|退出遥测/iu.test(text),
  };
}

function capabilitySummary(screening) {
  const capabilities = {};
  for (const finding of screening?.findings || []) {
    if (!CAPABILITY_IDS.has(finding.id)) continue;
    capabilities[finding.id] = sortedUnique(finding.files || [], 20);
  }
  return capabilities;
}

function verificationSummary({ manifest, screening, rootFiles, sourceFiles, securityText }) {
  const checks = screening?.checks || {};
  const items = {
    immutableCommit: true,
    manifest: manifest?.state === "verified",
    source: Boolean(checks.source),
    readme: Boolean(checks.readme),
    lockfile: Boolean(checks.lockfile),
    license: Boolean(checks.license),
    securityDisclosure: Boolean(securityText) || Boolean(checks.securityDisclosure),
  };
  return {
    ...items,
    filesInspected: sortedUnique([
      ...(rootFiles || []),
      ...(sourceFiles || []).map((file) => file.path),
    ], 40),
    score: Object.values(items).filter(Boolean).length,
    possibleScore: Object.keys(items).length,
  };
}

export function buildEvidenceSnapshot({
  repo,
  commitSha,
  checkedAt,
  meta,
  packageDocument,
  manifest,
  screening,
  rootFiles,
  sourceFiles,
  readme,
  securityText,
}) {
  const pkg = asObject(packageDocument);
  const owner = typeof meta?.owner?.login === "string" ? meta.owner.login : repo.split("/")[0];
  const lifecycle = lifecycleCommands(pkg);
  const sourceTexts = (sourceFiles || []).map((file) => file.text);
  return {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    scannerVersion: PASSPORT_SCANNER_VERSION,
    evidenceId: `${repo.toLowerCase()}@${commitSha.toLowerCase()}#scan-${PASSPORT_SCANNER_VERSION}`,
    repo,
    commitSha: commitSha.toLowerCase(),
    checkedAt,
    repository: {
      owner,
      defaultBranch: meta?.default_branch || manifest?.branch || null,
      archived: Boolean(meta?.archived),
      license: meta?.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? meta.license.spdx_id : null,
    },
    package: {
      name: typeof pkg.name === "string" ? pkg.name : null,
      version: typeof pkg.version === "string" ? pkg.version : null,
      dependencies: dependencyEntries(pkg.dependencies),
      peerDependencies: dependencyEntries(pkg.peerDependencies),
      optionalDependencies: dependencyEntries(pkg.optionalDependencies),
      devDependencies: dependencyEntries(pkg.devDependencies),
      lifecycleScripts: lifecycle,
      maintainers: packageMaintainers(pkg, owner),
    },
    manifest,
    capabilities: capabilitySummary(screening),
    externalDomains: extractDomains([readme, securityText, ...sourceTexts]),
    disclosure: disclosureSummary(readme, securityText),
    verification: verificationSummary({ manifest, screening, rootFiles, sourceFiles, securityText }),
    screening,
  };
}

function diffArrays(previous = [], current = []) {
  const before = new Set(previous);
  const after = new Set(current);
  return {
    added: [...after].filter((value) => !before.has(value)).sort((a, b) => a.localeCompare(b)),
    removed: [...before].filter((value) => !after.has(value)).sort((a, b) => a.localeCompare(b)),
  };
}

function capabilityNames(snapshot) {
  return Object.keys(snapshot?.capabilities || {}).sort((a, b) => a.localeCompare(b));
}

function lifecycleNames(snapshot) {
  return Object.keys(snapshot?.package?.lifecycleScripts || {}).sort((a, b) => a.localeCompare(b));
}

function severityRank(value) {
  return { unknown: 0, low: 1, medium: 2, high: 3 }[value] ?? 0;
}

export function computeEvidenceDiff(previous, current) {
  if (!previous) {
    return {
      fromCommit: null,
      toCommit: current.commitSha,
      changedAt: current.checkedAt,
      changed: false,
      severity: "baseline",
      packageVersion: { from: null, to: current.package.version },
      risk: { from: null, to: current.screening.risk },
      state: { from: null, to: current.screening.state },
      dependencies: { added: [], removed: [] },
      peerDependencies: { added: [], removed: [] },
      lifecycleScripts: { added: [], removed: [] },
      capabilities: { added: [], removed: [] },
      externalDomains: { added: [], removed: [] },
      maintainers: { added: [], removed: [] },
      manifestKinds: { added: [], removed: [] },
    };
  }

  const dependencies = diffArrays(previous.package.dependencies, current.package.dependencies);
  const peerDependencies = diffArrays(previous.package.peerDependencies, current.package.peerDependencies);
  const lifecycleScripts = diffArrays(lifecycleNames(previous), lifecycleNames(current));
  const capabilities = diffArrays(capabilityNames(previous), capabilityNames(current));
  const externalDomains = diffArrays(previous.externalDomains, current.externalDomains);
  const maintainers = diffArrays(previous.package.maintainers, current.package.maintainers);
  const manifestKinds = diffArrays(previous.manifest.kinds, current.manifest.kinds);
  const packageVersion = { from: previous.package.version, to: current.package.version };
  const risk = { from: previous.screening.risk, to: current.screening.risk };
  const state = { from: previous.screening.state, to: current.screening.state };
  const collections = [dependencies, peerDependencies, lifecycleScripts, capabilities, externalDomains, maintainers, manifestKinds];
  const changed = collections.some((item) => item.added.length || item.removed.length)
    || packageVersion.from !== packageVersion.to
    || risk.from !== risk.to
    || state.from !== state.to;
  const highSignal = capabilities.added.some((id) => HIGH_CAPABILITIES.has(id)) || state.to === "blocked";
  const mediumSignal = capabilities.added.length > 0
    || lifecycleScripts.added.length > 0
    || externalDomains.added.length > 0
    || severityRank(risk.to) > severityRank(risk.from);
  const lowSignal = changed;

  return {
    fromCommit: previous.commitSha,
    toCommit: current.commitSha,
    changedAt: current.checkedAt,
    changed,
    severity: highSignal ? "high" : mediumSignal ? "medium" : lowSignal ? "low" : "none",
    packageVersion,
    risk,
    state,
    dependencies,
    peerDependencies,
    lifecycleScripts,
    capabilities,
    externalDomains,
    maintainers,
    manifestKinds,
  };
}
