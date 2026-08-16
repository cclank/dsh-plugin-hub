const VALID_CATEGORIES = new Set(["ui", "session", "tools", "workflow", "notify", "dev", "fun"]);
const VALID_RISKS = new Set(["low", "medium", "high"]);
const MAX_PICKS = 100;
const MAX_COPY_LENGTH = 800;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, label, maxLength = MAX_COPY_LENGTH) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${label} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function localizedCopy(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  return {
    zh: requiredString(value.zh, `${label}.zh`),
    en: requiredString(value.en, `${label}.en`),
  };
}

function isoTimestamp(value, label) {
  const normalized = requiredString(value, label, 80);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(normalized).toISOString();
}

function repositoryUrl(value) {
  const normalized = requiredString(value, "repository", 300);
  const url = new URL(normalized);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new TypeError("repository must be an HTTPS GitHub URL");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function normalizePick(value, index) {
  if (!isObject(value)) throw new TypeError(`picks[${index}] must be an object`);
  const repo = requiredString(value.repo, `picks[${index}].repo`, 160).toLowerCase();
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/u.test(repo)) {
    throw new TypeError(`picks[${index}].repo must be owner/repository`);
  }
  const reviewedCommit = requiredString(value.reviewedCommit, `picks[${index}].reviewedCommit`, 64).toLowerCase();
  if (!/^[a-f\d]{40,64}$/u.test(reviewedCommit)) {
    throw new TypeError(`picks[${index}].reviewedCommit must be an immutable commit`);
  }
  const category = requiredString(value.category, `picks[${index}].category`, 32);
  if (!VALID_CATEGORIES.has(category)) throw new TypeError(`picks[${index}].category is unsupported`);
  if (!isObject(value.safety)) throw new TypeError(`picks[${index}].safety must be an object`);
  const risk = requiredString(value.safety.risk, `picks[${index}].safety.risk`, 16);
  if (!VALID_RISKS.has(risk)) throw new TypeError(`picks[${index}].safety.risk is unsupported`);
  return {
    repo,
    pickedAt: isoTimestamp(value.pickedAt, `picks[${index}].pickedAt`),
    reviewedCommit,
    category,
    summary: localizedCopy(value.summary, `picks[${index}].summary`),
    reason: localizedCopy(value.reason, `picks[${index}].reason`),
    safety: {
      risk,
      ...localizedCopy(value.safety, `picks[${index}].safety`),
    },
  };
}

export function normalizeCodexPicksFeed(value) {
  if (!isObject(value)) throw new TypeError("Codex picks feed must be an object");
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported Codex picks schemaVersion");
  if (!Array.isArray(value.picks) || value.picks.length > MAX_PICKS) {
    throw new TypeError(`picks must be an array with at most ${MAX_PICKS} entries`);
  }
  const picks = value.picks.map(normalizePick);
  const seen = new Set();
  for (const pick of picks) {
    if (seen.has(pick.repo)) throw new TypeError(`Duplicate Codex pick: ${pick.repo}`);
    seen.add(pick.repo);
  }
  picks.sort((a, b) => b.pickedAt.localeCompare(a.pickedAt) || a.repo.localeCompare(b.repo));
  return {
    schemaVersion: 1,
    updatedAt: isoTimestamp(value.updatedAt, "updatedAt"),
    source: requiredString(value.source, "source", 80),
    repository: repositoryUrl(value.repository),
    picks,
  };
}

function placeholderRecord(pick, order) {
  const [owner, name] = pick.repo.split("/");
  return {
    id: pick.repo,
    order,
    name,
    owner,
    repo: pick.repo,
    url: `https://github.com/${pick.repo}`,
    category: pick.category,
    description: pick.summary,
    added: pick.pickedAt.slice(0, 10),
    curated: false,
    topic: false,
    stars: null,
    forks: null,
    openIssues: null,
    watchers: null,
    pushedAt: null,
    updatedAt: null,
    createdAt: null,
    license: null,
    language: null,
    homepage: null,
    archived: false,
    defaultBranch: null,
    maintenance: "unknown",
    manifest: {
      state: "missing",
      branch: null,
      kinds: [],
      packageName: null,
      version: null,
      lifecycleScripts: [],
      runtimeDependencies: 0,
      declaredPaths: [],
      invalidDeclaredPaths: [],
    },
    screenedCommit: null,
    installCommand: null,
    discovery: {
      source: "topic",
      firstSeenAt: pick.pickedAt,
      lastSeenAt: pick.pickedAt,
    },
    screening: {
      version: 1,
      scope: "manifest",
      state: "pending",
      risk: "unknown",
      checkedAt: pick.pickedAt,
      findings: [],
      filesInspected: [],
      checks: {
        manifest: false,
        license: false,
        readme: false,
        lockfile: false,
        source: false,
        securityDisclosure: false,
      },
    },
    attention: {
      level: "review",
      reasons: ["等待定时源码检查"],
    },
    codexPick: pick,
  };
}

export function applyCodexPicks(registry, feed, source = {}) {
  const normalized = normalizeCodexPicksFeed(feed);
  const byRepo = new Map(normalized.picks.map((pick) => [pick.repo, pick]));
  const matchedRepos = new Set();
  const plugins = registry.plugins.map((plugin) => {
    const pick = byRepo.get(String(plugin.repo || plugin.id).toLowerCase());
    if (!pick) {
      if (!("codexPick" in plugin)) return plugin;
      const next = { ...plugin };
      delete next.codexPick;
      return next;
    }
    matchedRepos.add(pick.repo);
    return { ...plugin, codexPick: pick };
  });
  for (const pick of normalized.picks) {
    if (matchedRepos.has(pick.repo)) continue;
    plugins.push(placeholderRecord(pick, plugins.length));
    matchedRepos.add(pick.repo);
  }
  const matched = matchedRepos.size;
  const sourceState = source.state === "live" ? "live" : "snapshot";
  return {
    ...registry,
    plugins,
    sources: {
      ...registry.sources,
      codex: {
        url: source.url || normalized.repository,
        repository: normalized.repository,
        state: sourceState,
        updated: normalized.updatedAt,
        count: normalized.picks.length,
        matched,
        error: typeof source.error === "string" && source.error ? source.error : null,
      },
    },
    summary: {
      ...registry.summary,
      codexPicks: matched,
    },
  };
}
