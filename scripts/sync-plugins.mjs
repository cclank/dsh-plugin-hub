#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readResponseTextLimited } from "../lib/limited-response.mjs";
import { normalizeCodexPicksFeed } from "../lib/codex-picks.mjs";
import { baselineScreening, manifestSummary } from "../lib/plugin-screening.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = path.join(root, "data", "curated.snapshot.json");
const codexPicksPath = path.join(root, "data", "codex-picks.json");
const generatedPath = path.join(root, "data", "plugins.generated.json");
const publicPath = path.join(root, "public", "plugins.json");
const MAX_JSON_BYTES = 6_000_000;
const MAX_TEXT_BYTES = 140_000;
const MAX_OUTPUT_BYTES = 8_000_000;
const MAX_CURATED_PLUGINS = 2_000;
const MAX_BUNDLED_PLUGINS = 220;
const REGISTRY_CRON = "0 */12 * * *";
const publicCodexPicksUrl = "https://raw.githubusercontent.com/cclank/dsh-plugin-hub/main/data/codex-picks.json";

const curatedUrl =
  process.env.DSH_CURATED_REGISTRY_URL ||
  "https://awesome-dsh-plugin.com/plugins.json";
const publicCuratedUrl = (() => {
  try {
    const url = new URL(curatedUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://awesome-dsh-plugin.com/plugins.json";
  }
})();
const githubToken = process.env.GITHUB_TOKEN?.trim();
const skipManifests = process.env.DSH_SKIP_MANIFESTS === "1";

const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "dsh-plugin-hub-data-sync",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
};

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, options = {}, maxBytes = MAX_JSON_BYTES) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    error.reset = response.headers.get("x-ratelimit-reset");
    throw error;
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error(`Response too large (${length} bytes)`);
  return JSON.parse(await readResponseTextLimited(response, maxBytes));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "dsh-plugin-hub-data-sync" },
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_TEXT_BYTES) throw new Error(`Response too large (${length} bytes)`);
  return readResponseTextLimited(response, MAX_TEXT_BYTES);
}

function repoParts(url) {
  const parsed = new URL(url);
  const [owner, name] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !name || parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error(`Unsupported plugin repository URL: ${url}`);
  }
  if (!/^[a-z\d_.-]+$/iu.test(owner) || !/^[a-z\d_.-]+(?:\.git)?$/iu.test(name)) {
    throw new Error(`Unsupported plugin repository URL: ${url}`);
  }
  return { owner, name: name.replace(/\.git$/u, ""), fullName: `${owner}/${name.replace(/\.git$/u, "")}` };
}

function canonicalGithubRepositoryUrl(value) {
  try {
    return `https://github.com/${repoParts(value).fullName}`;
  } catch {
    return "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin";
  }
}

function isoAgeDays(value, now = Date.now()) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now - time) / 86_400_000));
}

function maintenanceState(meta) {
  if (meta?.archived) return "archived";
  const age = isoAgeDays(meta?.pushed_at);
  if (age === null) return "unknown";
  if (age <= 30) return "active";
  if (age <= 180) return "warm";
  return "quiet";
}

async function inspectManifest(plugin, topicMeta, previous) {
  const pushedAt = topicMeta?.pushed_at || null;
  if (
    previous?.manifest &&
    previous?.pushedAt === pushedAt &&
    previous.manifest.state !== "error"
  ) {
    return previous.manifest;
  }

  const branches = [...new Set([topicMeta?.default_branch, "main", "master"].filter(Boolean))];
  for (const branch of branches) {
    try {
      const raw = await fetchText(
        `https://raw.githubusercontent.com/${plugin.fullName}/${encodeURIComponent(branch)}/package.json`,
      );
      if (!raw) continue;
      return manifestSummary(JSON.parse(raw), branch);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ...manifestSummary(null, branch), state: "invalid" };
      }
    }
  }

  return manifestSummary(null, topicMeta?.default_branch || null);
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

async function loadCurated() {
  const fallback = await readJson(snapshotPath);
  try {
    const live = await fetchJson(curatedUrl, {
      headers: { Accept: "application/json", "User-Agent": "dsh-plugin-hub-data-sync" },
    });
    if (!Array.isArray(live.plugins) || !live.plugins.length || live.plugins.length > MAX_CURATED_PLUGINS) {
      throw new Error("Curated registry returned no plugins");
    }
    await writeFile(snapshotPath, `${JSON.stringify(live, null, 2)}\n`);
    return { registry: live, state: "live" };
  } catch (error) {
    if (!fallback?.plugins?.length) throw error;
    return { registry: fallback, state: "snapshot" };
  }
}

async function loadCodexPicks() {
  return normalizeCodexPicksFeed(await readJson(codexPicksPath));
}

async function loadTopic(previous) {
  const items = [];
  let total = previous?.sources?.topic?.total || null;
  let state = "live";
  let error = null;

  try {
    for (let page = 1; page <= 10; page += 1) {
      const query = new URLSearchParams({
        q: "topic:dsh-plugin",
        sort: "stars",
        order: "desc",
        per_page: "100",
        page: String(page),
      });
      const payload = await fetchJson(`https://api.github.com/search/repositories?${query}`, {
        headers: githubHeaders,
      });
      total = payload.total_count || total || 0;
      items.push(...(payload.items || []));
      if ((payload.items || []).length < 100 || items.length >= Math.min(total, 1000)) break;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    state = items.length ? "partial" : "snapshot";
  }

  const merged = new Map();
  for (const plugin of previous?.plugins || []) {
    if (plugin.topic) merged.set(plugin.id, plugin);
  }
  for (const item of items) merged.set(String(item.full_name).toLowerCase(), item);

  return {
    items: [...merged.values()],
    total: total || items.length,
    scanned: items.length,
    state,
    error,
  };
}

function metadataFromTopic(item) {
  if (!item || item.id?.includes?.("/")) return null;
  return item;
}

function attentionFor(meta, manifest) {
  const reasons = [];
  if (meta?.archived) reasons.push("仓库已归档");
  if (!meta?.license?.spdx_id || meta.license.spdx_id === "NOASSERTION") reasons.push("未声明许可证");
  if (manifest.state !== "verified") reasons.push("未核验到 dsh manifest");
  if (manifest.lifecycleScripts.length) reasons.push(`安装生命周期脚本：${manifest.lifecycleScripts.join(", ")}`);
  const age = isoAgeDays(meta?.pushed_at);
  if (age !== null && age > 180) reasons.push("超过 180 天未推送");

  return {
    level: meta?.archived || manifest.lifecycleScripts.length ? "caution" : reasons.length ? "review" : "clear",
    reasons,
  };
}

async function main() {
  await mkdir(path.dirname(generatedPath), { recursive: true });
  const previous = await readJson(generatedPath, {});
  const previousById = new Map((previous.plugins || []).map((plugin) => [plugin.id, plugin]));
  const [{ registry, state: curatedState }, topic, codexPicks] = await Promise.all([
    loadCurated(),
    loadTopic(previous),
    loadCodexPicks(),
  ]);

  const topicByName = new Map();
  for (const item of topic.items) {
    const fullName = item.full_name || item.repo;
    if (fullName) topicByName.set(String(fullName).toLowerCase(), item);
  }

  const missingPickMetadata = codexPicks.picks.filter((pick) => !topicByName.has(pick.repo));
  const fetchedPickMetadata = await mapLimit(missingPickMetadata, 5, async (pick) => {
    try {
      return await fetchJson(`https://api.github.com/repos/${pick.repo}`, { headers: githubHeaders });
    } catch {
      return null;
    }
  });
  for (const item of fetchedPickMetadata) {
    if (item?.full_name) topicByName.set(String(item.full_name).toLowerCase(), item);
  }

  const pickByRepo = new Map(codexPicks.picks.map((pick) => [pick.repo, pick]));

  const normalized = [];
  const seenRepositories = new Set();
  for (const entry of registry.plugins) {
    const parts = repoParts(entry.url);
    const id = parts.fullName.toLowerCase();
    if (seenRepositories.has(id)) continue;
    seenRepositories.add(id);
    normalized.push({
      ...entry,
      ...parts,
      id,
      order: normalized.length,
      communityCurated: true,
      codexPick: pickByRepo.get(id) || null,
    });
  }

  for (const pick of codexPicks.picks) {
    if (seenRepositories.has(pick.repo)) continue;
    const [owner, name] = pick.repo.split("/");
    seenRepositories.add(pick.repo);
    normalized.push({
      id: pick.repo,
      order: normalized.length,
      name,
      owner,
      fullName: pick.repo,
      url: `https://github.com/${pick.repo}`,
      category: pick.category,
      description: pick.summary,
      added: pick.pickedAt.slice(0, 10),
      communityCurated: false,
      codexPick: pick,
    });
  }

  const bundledPlugins = [
    ...normalized.filter((plugin) => plugin.codexPick),
    ...normalized.filter((plugin) => !plugin.codexPick),
  ].slice(0, MAX_BUNDLED_PLUGINS);
  bundledPlugins.forEach((plugin, index) => { plugin.order = index; });

  const manifests = skipManifests
    ? bundledPlugins.map((plugin) => previousById.get(plugin.id)?.manifest || manifestSummary(null, null))
    : await mapLimit(bundledPlugins, 10, (plugin) =>
        inspectManifest(plugin, metadataFromTopic(topicByName.get(plugin.id)), previousById.get(plugin.id)),
      );

  const generatedAt = new Date().toISOString();
  const plugins = bundledPlugins.map((plugin, index) => {
    const topicMeta = metadataFromTopic(topicByName.get(plugin.id));
    const manifest = manifests[index];
    const topicMatched = Boolean(topicMeta);
    // The bundled snapshot is manifest-only. A scheduled Worker inspection
    // resolves and scans one immutable commit before exposing an install command.
    const screenedCommit = null;
    const installCommand = null;
    const screening = baselineScreening(topicMeta, manifest, [], generatedAt);
    return {
      id: plugin.id,
      order: plugin.order,
      name: plugin.name,
      owner: plugin.owner,
      repo: plugin.fullName,
      url: plugin.url,
      category: plugin.category,
      description: plugin.description,
      added: plugin.added || null,
      curated: plugin.communityCurated,
      topic: topicMatched,
      stars: topicMeta?.stargazers_count ?? null,
      forks: topicMeta?.forks_count ?? null,
      openIssues: topicMeta?.open_issues_count ?? null,
      watchers: topicMeta?.subscribers_count ?? topicMeta?.watchers_count ?? null,
      pushedAt: topicMeta?.pushed_at ?? null,
      updatedAt: topicMeta?.updated_at ?? null,
      createdAt: topicMeta?.created_at ?? null,
      license: topicMeta?.license?.spdx_id && topicMeta.license.spdx_id !== "NOASSERTION"
        ? topicMeta.license.spdx_id
        : null,
      language: topicMeta?.language ?? null,
      homepage: topicMeta?.homepage || null,
      archived: Boolean(topicMeta?.archived),
      defaultBranch: topicMeta?.default_branch || manifest.branch || null,
      maintenance: maintenanceState(topicMeta),
      manifest,
      screenedCommit,
      installCommand,
      discovery: {
        source: plugin.communityCurated ? "curated" : "topic",
        firstSeenAt: plugin.added || generatedAt.slice(0, 10),
        lastSeenAt: generatedAt,
      },
      screening,
      attention: attentionFor(topicMeta, manifest),
      ...(plugin.codexPick ? { codexPick: plugin.codexPick } : {}),
    };
  });

  const metadataMatches = plugins.filter((plugin) => plugin.topic).length;
  const manifestMatches = plugins.filter((plugin) => plugin.manifest.state === "verified").length;
  const stars = plugins.reduce((sum, plugin) => sum + (plugin.stars || 0), 0);
  const screeningClear = plugins.filter((plugin) => plugin.screening.state === "clear").length;
  const screeningReview = plugins.filter((plugin) => ["review", "pending"].includes(plugin.screening.state)).length;
  const screeningBlocked = plugins.filter((plugin) => plugin.screening.state === "blocked").length;
  const output = {
    schemaVersion: 4,
    generatedAt,
    automation: {
      enabled: true,
      schedule: REGISTRY_CRON,
      state: "bundled",
      scanVersion: 2,
      lastRunAt: null,
      lastSuccessfulRunAt: null,
      checkedThisRun: 0,
      discoveredThisRun: 0,
      admittedThisRun: 0,
      rejectedTotal: 0,
      error: null,
    },
    sources: {
      curated: {
        url: publicCuratedUrl,
        repository: canonicalGithubRepositoryUrl(registry.source),
        state: curatedState,
        updated: registry.updated,
        count: registry.count,
      },
      topic: {
        url: "https://github.com/topics/dsh-plugin",
        query: "topic:dsh-plugin",
        state: topic.state,
        total: topic.total,
        scanned: topic.scanned,
        matched: metadataMatches,
        error: topic.error,
      },
      codex: {
        url: publicCodexPicksUrl,
        repository: codexPicks.repository,
        state: "live",
        updated: codexPicks.updatedAt,
        count: codexPicks.picks.length,
        matched: plugins.filter((plugin) => plugin.codexPick).length,
        error: null,
      },
    },
    summary: {
      curated: plugins.filter((plugin) => plugin.curated).length,
      codexPicks: plugins.filter((plugin) => plugin.codexPick).length,
      listed: plugins.length,
      autoDiscovered: plugins.filter((plugin) => !plugin.curated).length,
      topicTotal: topic.total,
      metadataMatches,
      manifestMatches,
      screeningClear,
      screeningReview,
      screeningBlocked,
      owners: new Set(plugins.map((plugin) => plugin.owner.toLowerCase())).size,
      stars,
    },
    categories: registry.categories,
    plugins,
  };

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES) {
    throw new Error(`Generated registry exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  await writeFile(generatedPath, serialized);
  await writeFile(publicPath, serialized);
  console.log(
    `synced ${plugins.length} bundled plugins from ${normalized.length} candidates (${codexPicks.picks.length} Codex picks); ${metadataMatches} topic matches; ${manifestMatches} manifests; topic total ${topic.total}`,
  );
  if (topic.error) console.warn(`GitHub topic sync: ${topic.state} (${topic.error})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
