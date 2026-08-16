"use client";

import type {
  CategoryId,
  Language,
  PluginRecord,
  PluginRegistryData,
} from "@/lib/plugin-data";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PluginPassportView,
  type PluginPassportRoute,
} from "./plugin-passport";

type PageId = "home" | "catalog" | "rank" | "submit" | "guide";
type SortId = "curated" | "stars" | "updated" | "added" | "name";
type EvidenceFilter = "all" | "auto" | "topic" | "manifest" | "clear" | "review" | "favorites";
type VisitStats = {
  available: boolean;
  displayCount: number | null;
  realCount: number | null;
  multiplier: number;
  historicalCount: number | null;
};
type GrowthPoint = {
  date: string;
  added: number;
  total: number;
};

const PAGES: Array<{ id: PageId; zh: string; en: string }> = [
  { id: "home", zh: "首页", en: "Home" },
  { id: "catalog", zh: "目录", en: "Catalog" },
  { id: "rank", zh: "排行榜", en: "Leaderboard" },
  { id: "submit", zh: "收录", en: "Get listed" },
  { id: "guide", zh: "开发指南", en: "Build one" },
];

const CATEGORY_ORDER: CategoryId[] = [
  "ui",
  "session",
  "tools",
  "workflow",
  "notify",
  "dev",
  "fun",
];

const CATEGORY_HINTS: Record<CategoryId, Record<Language, string>> = {
  ui: { zh: "侧栏、面板、交互体验", en: "Panels, navigation, interaction" },
  session: { zh: "记忆、回退、分享、导入", en: "Memory, rewind, sharing, import" },
  tools: { zh: "视觉、文档、数据库、工具箱", en: "Vision, docs, databases, toolkits" },
  workflow: { zh: "多代理、定时任务、监视", en: "Multi-agent, schedules, watches" },
  notify: { zh: "桌面通知、IM、编辑器桥接", en: "Desktop, IM, editor bridges" },
  dev: { zh: "沙箱、模型、运行时、体检", en: "Sandbox, models, runtime, audits" },
  fun: { zh: "桌宠、小游戏、贴纸", en: "Pets, minigames, stickers" },
};

const PREFS_KEY = "dsh-plugin-hub-prefs-v2";

function text(lang: Language, zh: string, en: string) {
  return lang === "zh" ? zh : en;
}

function formatNumber(value: number | null, lang: Language) {
  if (value === null) return "—";
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function dayDistance(value: string | null) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function relativeDate(value: string | null, lang: Language) {
  const days = dayDistance(value);
  if (days === null) return "—";
  if (days === 0) return text(lang, "今天", "today");
  if (days < 30) return text(lang, `${days} 天前`, `${days}d ago`);
  if (days < 365) return text(lang, `${Math.floor(days / 30)} 个月前`, `${Math.floor(days / 30)}mo ago`);
  return text(lang, `${Math.floor(days / 365)} 年前`, `${Math.floor(days / 365)}y ago`);
}

function isoDate(value: string | null | undefined) {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/u);
  if (!match) return null;
  return Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`)) ? match[1] : null;
}

function shiftIsoDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shortDate(value: string, lang: Language) {
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function buildGrowthSeries(plugins: PluginRecord[], generatedAt: string): GrowthPoint[] {
  const generatedDate = isoDate(generatedAt) || "1970-01-01";
  const dailyAdditions = new Map<string, number>();

  for (const plugin of plugins) {
    const date = isoDate(plugin.discovery.firstSeenAt) || isoDate(plugin.added) || generatedDate;
    dailyAdditions.set(date, (dailyAdditions.get(date) || 0) + 1);
  }

  const dates = [...dailyAdditions.keys()].sort();
  if (!dates.length) return [{ date: generatedDate, added: 0, total: 0 }];

  let total = 0;
  const series = dates.map((date) => {
    const added = dailyAdditions.get(date) || 0;
    total += added;
    return { date, added, total };
  });
  const lastDate = series.at(-1)?.date || generatedDate;
  const chartEnd = generatedDate > lastDate ? generatedDate : lastDate;

  if (chartEnd > lastDate) series.push({ date: chartEnd, added: 0, total });
  if (series.length === 1) {
    series.unshift({ date: shiftIsoDate(series[0].date, -1), added: 0, total: 0 });
  }
  return series;
}

function growthChartGeometry(series: GrowthPoint[]) {
  const width = 760;
  const height = 250;
  const top = 20;
  const bottom = 214;
  const left = 18;
  const right = 18;
  const firstTime = Date.parse(`${series[0].date}T00:00:00Z`);
  const lastTime = Date.parse(`${series.at(-1)?.date || series[0].date}T00:00:00Z`);
  const duration = Math.max(86_400_000, lastTime - firstTime);
  const maxTotal = Math.max(1, ...series.map((point) => point.total));
  const points = series.map((point) => ({
    ...point,
    x: left + ((Date.parse(`${point.date}T00:00:00Z`) - firstTime) / duration) * (width - left - right),
    y: bottom - (point.total / maxTotal) * (bottom - top),
  }));
  let line = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous.x + current.x) / 2;
    line += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`;
  }
  const first = points[0];
  const last = points.at(-1) || first;
  return {
    width,
    height,
    bottom,
    points,
    line,
    area: `${line} L ${last.x} ${bottom} L ${first.x} ${bottom} Z`,
  };
}

function pageFromHash(): PageId {
  if (typeof window === "undefined") return "home";
  const value = window.location.hash.replace(/^#\/?/u, "").split(/[/?]/u)[0];
  return PAGES.some((page) => page.id === value) ? (value as PageId) : "home";
}

function passportRouteFromPath(): PluginPassportRoute | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/^\/p\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/u);
  if (!match) return null;
  try {
    const owner = decodeURIComponent(match[1]);
    const repository = decodeURIComponent(match[2]);
    const revision = match[3] ? decodeURIComponent(match[3]) : "latest";
    if (!/^[a-z\d_.-]+$/iu.test(owner) || !/^[a-z\d_.-]+$/iu.test(repository)) return null;
    if (revision !== "latest" && !/^[a-f\d]{40,64}$/iu.test(revision)) return null;
    return { owner, repository, revision };
  } catch {
    return null;
  }
}

function maintenanceLabel(plugin: PluginRecord, lang: Language) {
  const labels = {
    active: text(lang, "近 30 天活跃", "Active in 30d"),
    warm: text(lang, "近半年更新", "Updated in 6mo"),
    quiet: text(lang, "更新较少", "Quiet"),
    archived: text(lang, "已归档", "Archived"),
    unknown: text(lang, "活跃度未知", "Activity unknown"),
  };
  return labels[plugin.maintenance];
}

function signalLabel(plugin: PluginRecord, lang: Language) {
  if (plugin.screening.state === "blocked") return text(lang, "静态检查拦截", "Static scan blocked");
  if (plugin.screening.state === "review") return text(lang, "待人工复核", "Manual review");
  if (plugin.screening.state === "pending") return text(lang, "等待源码补扫", "Source scan pending");
  return text(lang, "静态检查通过", "Static scan clear");
}

function sourceLabel(plugin: PluginRecord) {
  if (!plugin.curated) return "AUTO";
  return plugin.topic ? "TOPIC + LIST" : "LIST";
}

function sourceClass(plugin: PluginRecord) {
  if (!plugin.curated) return "auto";
  return plugin.topic ? "topic" : "list";
}

function PluginCard({
  plugin,
  lang,
  favorite,
  onOpen,
  onFavorite,
  view,
}: {
  plugin: PluginRecord;
  lang: Language;
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
  view: "list" | "cards";
}) {
  return (
    <article className={`plugin-card plugin-card--${view}`}>
      <button className="plugin-card__main" type="button" onClick={onOpen}>
        <span className="plugin-card__number">№ {String(plugin.order + 1).padStart(3, "0")}</span>
        <span className="plugin-card__copy">
          <span className="plugin-card__title-row">
            <strong>{plugin.name}</strong>
            <span className={`evidence evidence--${sourceClass(plugin)}`}>
              {sourceLabel(plugin)}
            </span>
          </span>
          <span className="plugin-card__owner">{plugin.owner}</span>
          <span className="plugin-card__description">{plugin.description[lang]}</span>
          <span className="plugin-card__meta">
            <span>★ {formatNumber(plugin.stars, lang)}</span>
            <span>{relativeDate(plugin.pushedAt, lang)}</span>
            <span>{plugin.license || text(lang, "无许可证", "No license")}</span>
            <span className={`signal signal--${plugin.attention.level}`}>{signalLabel(plugin, lang)}</span>
          </span>
        </span>
      </button>
      <button
        className={`favorite-button ${favorite ? "is-active" : ""}`}
        type="button"
        onClick={onFavorite}
        aria-label={text(lang, favorite ? "取消收藏" : "收藏", favorite ? "Remove favorite" : "Save favorite")}
        title={text(lang, favorite ? "取消收藏" : "收藏", favorite ? "Remove favorite" : "Save favorite")}
      >
        ★
      </button>
    </article>
  );
}

export function PluginHub({ data: initialData }: { data: PluginRegistryData }) {
  const [data, setData] = useState(initialData);
  const [registrySource, setRegistrySource] = useState<"bundled" | "live">("bundled");
  const [page, setPage] = useState<PageId>("home");
  const [lang, setLang] = useState<Language>("zh");
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | CategoryId>("all");
  const [sort, setSort] = useState<SortId>("curated");
  const [view, setView] = useState<"list" | "cards">("list");
  const [evidence, setEvidence] = useState<EvidenceFilter>("all");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selected, setSelected] = useState<PluginRecord | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [visitStats, setVisitStats] = useState<VisitStats | null>(null);
  const [passportRoute, setPassportRoute] = useState<PluginPassportRoute | null>(null);

  useEffect(() => {
    const syncRoute = () => {
      setPage(pageFromHash());
      setPassportRoute(passportRouteFromPath());
    };
    const onHash = () => syncRoute();
    const onPopState = () => syncRoute();
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onPopState);
    const restoreTimer = window.setTimeout(() => {
      syncRoute();
      try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
        if (saved.lang === "zh" || saved.lang === "en") setLang(saved.lang);
        if (saved.theme === "dark" || saved.theme === "light") setTheme(saved.theme);
        if (saved.view === "list" || saved.view === "cards") setView(saved.view);
        if (Array.isArray(saved.favorites)) setFavorites(saved.favorites);
      } catch {
        // Keep defaults when a browser contains malformed old preferences.
      } finally {
        setPreferencesReady(true);
      }
    }, 0);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    fetch("/api/plugins", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Registry request failed: ${response.status}`);
        const next = await response.json() as PluginRegistryData;
        if (!Array.isArray(next.plugins) || !next.summary || !next.automation) {
          throw new Error("Registry response has an invalid shape");
        }
        setData(next);
        setRegistrySource(response.headers.get("x-registry-source") === "cloudflare-kv" ? "live" : "bundled");
      })
      .catch(() => {
        // The server-rendered registry remains usable during network or KV outages.
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    fetch("/api/visits", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Visit metrics request failed: ${response.status}`);
        const next = await response.json() as VisitStats;
        if (typeof next.multiplier !== "number" || typeof next.available !== "boolean") {
          throw new Error("Visit metrics response has an invalid shape");
        }
        setVisitStats(next);
      })
      .catch(() => {
        // Traffic metrics are optional; the registry remains fully usable.
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    document.documentElement.dataset.theme = theme;
    if (!preferencesReady) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ lang, theme, view, favorites }));
    } catch {
      // Preferences are optional when storage is unavailable.
    }
  }, [favorites, lang, preferencesReady, theme, view]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [selected]);

  const go = useCallback((next: PageId) => {
    setPage(next);
    setSelected(null);
    setPassportRoute(null);
    window.history.pushState(null, "", `/#/${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const copy = useCallback(async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1500);
    } catch {
      setCopied(null);
    }
  }, []);

  const categoryCounts = useMemo(() => {
    const counts = Object.fromEntries(CATEGORY_ORDER.map((id) => [id, 0])) as Record<CategoryId, number>;
    for (const plugin of data.plugins) counts[plugin.category] += 1;
    return counts;
  }, [data.plugins]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const favoriteSet = new Set(favorites);
    const rows = data.plugins.filter((plugin) => {
      if (category !== "all" && plugin.category !== category) return false;
      if (evidence === "auto" && plugin.curated) return false;
      if (evidence === "topic" && !plugin.topic) return false;
      if (evidence === "manifest" && plugin.manifest.state !== "verified") return false;
      if (evidence === "clear" && plugin.screening.state !== "clear") return false;
      if (evidence === "review" && !["review", "pending", "blocked"].includes(plugin.screening.state)) return false;
      if (evidence === "favorites" && !favoriteSet.has(plugin.id)) return false;
      if (!normalized) return true;
      return [
        plugin.name,
        plugin.owner,
        plugin.repo,
        plugin.description.zh,
        plugin.description.en,
        data.categories[plugin.category].zh,
        plugin.manifest.packageName || "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });

    return rows.sort((a, b) => {
      if (sort === "stars") return (b.stars ?? -1) - (a.stars ?? -1) || a.order - b.order;
      if (sort === "updated") return Date.parse(b.pushedAt || "0") - Date.parse(a.pushedAt || "0");
      if (sort === "added") return (b.added || "").localeCompare(a.added || "") || a.order - b.order;
      if (sort === "name") return a.name.localeCompare(b.name);
      return a.order - b.order;
    });
  }, [category, data.categories, data.plugins, evidence, favorites, query, sort]);

  const topStars = useMemo(
    () => [...data.plugins].filter((plugin) => plugin.stars !== null).sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 20),
    [data.plugins],
  );
  const topFresh = useMemo(
    () => [...data.plugins].filter((plugin) => plugin.pushedAt).sort((a, b) => Date.parse(b.pushedAt || "0") - Date.parse(a.pushedAt || "0")).slice(0, 20),
    [data.plugins],
  );
  const featured = topStars.slice(0, 6);
  const growthSeries = useMemo(
    () => buildGrowthSeries(data.plugins, data.generatedAt),
    [data.generatedAt, data.plugins],
  );
  const growthChart = useMemo(() => growthChartGeometry(growthSeries), [growthSeries]);
  const currentGrowth = growthSeries.at(-1) || { date: data.generatedAt.slice(0, 10), added: 0, total: data.summary.listed };
  const latestGrowth = [...growthSeries].reverse().find((point) => point.added > 0) || currentGrowth;
  const firstGrowth = growthSeries.find((point) => point.total > 0) || currentGrowth;
  const generatedLabel = data.generatedAt.slice(0, 16).replace("T", " ") + " UTC";
  const passportFallback = passportRoute
    ? data.plugins.find((plugin) => plugin.repo.toLowerCase() === `${passportRoute.owner}/${passportRoute.repository}`.toLowerCase()) || null
    : null;
  const automationLabel = data.automation.state === "live"
    ? text(lang, "云端巡检正常", "Cloud scan healthy")
    : data.automation.state === "degraded"
      ? text(lang, "巡检部分降级", "Scan partially degraded")
      : text(lang, "等待首次云端巡检", "Awaiting first cloud scan");
  const channelLabel = registrySource === "live"
    ? text(lang, "KV 实时目录", "Live KV registry")
    : text(lang, "内置数据兜底", "Bundled fallback");
  const pipeline = data.automation.pipeline;
  const pipelineLabel = pipeline?.available
    ? text(
        lang,
        `证据覆盖 ${pipeline.coveragePercent}% · 待覆盖 ${pipeline.remainingPlugins} · 队列 ${pipeline.backlog}`,
        `${pipeline.coveragePercent}% evidence · ${pipeline.remainingPlugins} remaining · ${pipeline.backlog} queued`,
      )
    : text(lang, "证据流水线待初始化", "Evidence pipeline pending");
  const pipelineEta = pipeline?.available && pipeline.estimatedMinutes !== null
    ? pipeline.estimatedMinutes < 60
      ? text(lang, `${pipeline.estimatedMinutes} 分钟`, `${pipeline.estimatedMinutes} min`)
      : text(lang, `约 ${Math.ceil(pipeline.estimatedMinutes / 60)} 小时`, `~${Math.ceil(pipeline.estimatedMinutes / 60)} hr`)
    : "—";

  return (
    <div className="hub" data-theme={theme} data-lang={lang}>
      <header className="site-header">
        <div className="site-header__inner">
          <button className="brand" type="button" onClick={() => go("home")} aria-label={text(lang, "返回首页", "Back home")}>
            <span className="brand__mark">dsh</span>
            <span>{text(lang, "插件资源站", "Plugin Hub")}</span>
          </button>
          <nav className="main-nav" aria-label={text(lang, "主导航", "Main navigation")}>
            {PAGES.map((item) => (
              <button
                className={page === item.id ? "is-active" : ""}
                type="button"
                key={item.id}
                onClick={() => go(item.id)}
              >
                {item[lang]}
              </button>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className={`header-favorites${evidence === "favorites" ? " is-active" : ""}`}
              type="button"
              onClick={() => {
                setEvidence("favorites");
                go("catalog");
              }}
              title={text(lang, "查看收藏", "View favorites")}
            >
              ★ <span>{favorites.length}</span>
            </button>
            <button type="button" onClick={() => setLang((current) => (current === "zh" ? "en" : "zh"))}>
              {lang === "zh" ? "EN" : "中文"}
            </button>
            <button type="button" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))} aria-label={text(lang, "切换主题", "Toggle theme")}>
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <div
              className="header-visit-count"
              title={visitStats?.available
                ? text(lang, "网站访问量", "Site views")
                : text(lang, "访问数据加载中", "Loading visit metrics")}
              aria-label={text(
                lang,
                `访问量 ${formatNumber(visitStats?.displayCount ?? null, lang)}`,
                `${formatNumber(visitStats?.displayCount ?? null, lang)} views`,
              )}
            >
              <span>{text(lang, "访问量", "Views")}</span>
              <strong>{formatNumber(visitStats?.displayCount ?? null, lang)}</strong>
            </div>
            <a
              className="header-icon-link"
              href="https://github.com/cclank/dsh-plugin-hub"
              target="_blank"
              rel="noreferrer"
              aria-label={text(lang, "在 GitHub 查看开源代码", "View source on GitHub")}
              title={text(lang, "GitHub 开源仓库", "GitHub repository")}
            >
              <svg className="github-mark" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.093.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.343-3.369-1.343-.455-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.071 1.531 1.031 1.531 1.031.892 1.529 2.341 1.087 2.91.831.091-.647.349-1.087.635-1.337-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.269 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.295 2.747-1.026 2.747-1.026.546 1.378.203 2.398.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.847-2.337 4.695-4.566 4.943.359.31.678.921.678 1.856 0 1.34-.012 2.421-.012 2.75 0 .268.18.58.688.481A10.025 10.025 0 0 0 22 12.021C22 6.484 17.523 2 12 2Z" />
              </svg>
            </a>
          </div>
        </div>
      </header>

      <main>
        {passportRoute && (
          <PluginPassportView
            route={passportRoute}
            lang={lang}
            fallback={passportFallback}
            onBack={() => go("catalog")}
          />
        )}

        {!passportRoute && page === "home" && (
          <>
            <section className="hero">
              <div className="hero__grid" aria-hidden="true" />
              <div className="hero__glow" aria-hidden="true" />
              <div className="shell hero__content">
                <div className="eyebrow"><span className="live-dot" /> DeepSeek Harness <i>/</i> {automationLabel} <i>/</i> {channelLabel} <i>/</i> 30 MIN <i>/</i> {pipelineLabel}</div>
                <h1>{text(lang, "一切皆插件。\n先看证据，再决定装不装。", "Everything is a plugin.\nCheck the evidence before you install.")}</h1>
                <p>
                  {text(
                    lang,
                    `当前展示 ${data.summary.listed} 个插件。发现任务每 30 分钟运行，候选进入独立队列；每份检查证据绑定仓库、commit 和扫描器版本。`,
                    `${data.summary.listed} plugins are listed. Discovery runs every 30 minutes, candidates enter a separate queue, and each result is bound to a repository, commit, and scanner version.`,
                  )}
                </p>
                <div className="hero__actions">
                  <button className="primary-button" type="button" onClick={() => go("catalog")}>{text(lang, "浏览插件目录", "Browse catalog")} <span>→</span></button>
                  <a className="secondary-button" href={data.sources.curated.repository} target="_blank" rel="noreferrer">{text(lang, "查看数据源", "Open data source")} ↗</a>
                </div>
              </div>
            </section>

            <section className="metrics" aria-label={text(lang, "数据概览", "Registry metrics")}>
              <div className="shell metrics__grid">
                <div><strong>{data.summary.listed}</strong><span>{text(lang, "目录插件", "Listed plugins")}</span></div>
                <div><strong>{data.summary.autoDiscovered}</strong><span>{text(lang, "自动发现", "Auto-discovered")}</span></div>
                <div><strong>{formatNumber(data.summary.topicTotal, lang)}</strong><span>{text(lang, "GitHub 话题仓库", "Topic repositories")}</span></div>
                <div><strong>{data.summary.screeningClear}</strong><span>{text(lang, "静态检查通过", "Static scan clear")}</span></div>
                <div><strong>{data.summary.screeningReview + data.summary.screeningBlocked}</strong><span>{text(lang, "待复核或拦截", "Review or blocked")}</span></div>
                <div><strong>{pipeline?.available ? `${pipeline.coveragePercent}%` : "—"}</strong><span>{text(lang, "证据覆盖率", "Evidence coverage")}</span></div>
                <div><strong>{pipeline?.available ? pipeline.remainingPlugins : "—"}</strong><span>{text(lang, "待建立护照", "Passports remaining")}</span></div>
                <div><strong>{pipelineEta}</strong><span>{text(lang, "预计覆盖完成", "Estimated completion")}</span></div>
              </div>
            </section>

            <section className="section shell growth-section">
              <div className="section-heading growth-heading">
                <div>
                  <span className="section-kicker">REGISTRY GROWTH</span>
                  <h2>{text(lang, "插件收录增长", "Plugin growth")}</h2>
                </div>
                <p>{text(lang, "按插件首次进入本站目录的日期累计，随自动巡检持续更新。", "Cumulative first-listing dates, updated by the automated scan.")}</p>
              </div>
              <div className="growth-card">
                <div className="growth-card__summary">
                  <span>{text(lang, "当前目录", "CURRENT TOTAL")}</span>
                  <strong>{formatNumber(currentGrowth.total, lang)}</strong>
                  <p>{text(lang, `从 ${shortDate(firstGrowth.date, lang)} 开始记录`, `Tracked since ${shortDate(firstGrowth.date, lang)}`)}</p>
                  <div className="growth-card__delta">
                    <b>+{latestGrowth.added}</b>
                    <span>{text(lang, "最近一次新增", "Latest additions")} · {shortDate(latestGrowth.date, lang)}</span>
                  </div>
                </div>
                <figure className="growth-chart">
                  <figcaption>
                    <span><i aria-hidden="true" />{text(lang, "累计插件数", "Cumulative plugins")}</span>
                    <em>{text(lang, "真实收录数据", "Registry data")}</em>
                  </figcaption>
                  <svg
                    viewBox={`0 0 ${growthChart.width} ${growthChart.height}`}
                    role="img"
                    aria-label={text(lang, `插件数量从 ${firstGrowth.total} 增长到 ${currentGrowth.total}`, `Plugin count grew from ${firstGrowth.total} to ${currentGrowth.total}`)}
                  >
                    <defs>
                      <linearGradient id="growth-area" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    {[0.25, 0.5, 0.75, 1].map((ratio) => (
                      <line
                        className="growth-chart__grid"
                        key={ratio}
                        x1="0"
                        x2={growthChart.width}
                        y1={growthChart.bottom * ratio}
                        y2={growthChart.bottom * ratio}
                      />
                    ))}
                    <path className="growth-chart__area" d={growthChart.area} />
                    <path className="growth-chart__line" d={growthChart.line} />
                    {growthChart.points.map((point) => (
                      <circle
                        aria-label={`${shortDate(point.date, lang)} · ${point.total} · +${point.added}`}
                        className="growth-chart__point"
                        cx={point.x}
                        cy={point.y}
                        key={point.date}
                        r="4"
                      />
                    ))}
                  </svg>
                  <div className="growth-chart__axis" aria-hidden="true">
                    <span>{shortDate(growthSeries[0].date, lang)}</span>
                    <span>{shortDate(currentGrowth.date, lang)}</span>
                  </div>
                </figure>
              </div>
            </section>

            <section className="section shell">
              <div className="section-heading">
                <div><span className="section-kicker">COMMUNITY SIGNAL</span><h2>{text(lang, "社区热度", "Community signal")}</h2></div>
                <button className="text-button" type="button" onClick={() => go("rank")}>{text(lang, "完整排行榜", "Full leaderboard")} →</button>
              </div>
              <div className="featured-grid">
                {featured.map((plugin, index) => (
                  <button className="featured-card" type="button" key={plugin.id} onClick={() => setSelected(plugin)}>
                    <span className="featured-card__rank">0{index + 1}</span>
                    <span className="featured-card__head"><strong>{plugin.name}</strong><em>★ {formatNumber(plugin.stars, lang)}</em></span>
                    <span className="featured-card__owner">{plugin.owner}</span>
                    <span className="featured-card__desc">{plugin.description[lang]}</span>
                    <span className="featured-card__foot">{data.categories[plugin.category][lang]} <i>→</i></span>
                  </button>
                ))}
              </div>
            </section>

            <section className="section shell">
              <div className="section-heading"><div><span className="section-kicker">BROWSE</span><h2>{text(lang, "按分类逛", "Browse by category")}</h2></div></div>
              <div className="category-grid">
                {CATEGORY_ORDER.map((id) => (
                  <button
                    className="category-card"
                    type="button"
                    key={id}
                    onClick={() => {
                      setCategory(id);
                      go("catalog");
                    }}
                  >
                    <strong>{categoryCounts[id]}</strong>
                    <span>{data.categories[id][lang]}</span>
                    <small>{CATEGORY_HINTS[id][lang]}</small>
                  </button>
                ))}
              </div>
            </section>

            <section className="section shell source-panel">
              <div>
                <span className="section-kicker">EVIDENCE, NOT ENDORSEMENT</span>
                <h2>{text(lang, "每张卡片都说明证据到哪一步", "Every card shows how far the evidence goes")}</h2>
                <p>{text(lang, "网站只读取公开元数据、manifest、README 与少量声明入口源码。扫描过程不安装依赖、不运行 lifecycle，也不执行插件代码；结果属于轻量静态检查。", "The hub reads public metadata, manifests, READMEs, and a small set of declared source entrypoints. It installs no dependencies, runs no lifecycle scripts, and executes no plugin code. Results are lightweight static checks.")}</p>
              </div>
              <div className="source-steps">
                <div><b>01</b><strong>LIST</strong><span>{text(lang, "社区精选名单", "Community curation")}</span></div>
                <div><b>02</b><strong>TOPIC</strong><span>{text(lang, "GitHub 实时元数据", "Live GitHub metadata")}</span></div>
                <div><b>03</b><strong>MANIFEST</strong><span>{text(lang, "仓库清单静态检查", "Static package check")}</span></div>
                <div><b>04</b><strong>SOURCE</strong><span>{text(lang, "入口源码风险信号", "Entrypoint risk signals")}</span></div>
              </div>
            </section>
          </>
        )}

        {!passportRoute && page === "catalog" && (
          <section className="catalog shell page-section">
            <div className="page-heading">
              <div><span className="section-kicker">CATALOG</span><h1>{text(lang, "插件目录", "Plugin catalog")}</h1><p>{text(lang, `${filtered.length} 个结果 · 数据生成于 ${generatedLabel}`, `${filtered.length} results · generated ${generatedLabel}`)}</p></div>
            </div>
            <div className="catalog-toolbar">
              <label className="search-field">
                <span>/</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text(lang, "搜索名称、作者、能力或包名", "Search name, author, capability, package")} />
                {query && <button type="button" onClick={() => setQuery("")} aria-label={text(lang, "清空搜索", "Clear search")}>×</button>}
              </label>
              <select value={evidence} onChange={(event) => setEvidence(event.target.value as EvidenceFilter)} aria-label={text(lang, "证据筛选", "Evidence filter")}>
                <option value="all">{text(lang, "全部证据状态", "All evidence")}</option>
                <option value="auto">{text(lang, "网站自动发现", "Auto-discovered")}</option>
                <option value="topic">{text(lang, "已匹配 GitHub 话题", "Matched GitHub topic")}</option>
                <option value="manifest">{text(lang, "已识别 manifest", "Manifest found")}</option>
                <option value="clear">{text(lang, "静态检查通过", "Static scan clear")}</option>
                <option value="review">{text(lang, "待复核或已拦截", "Review or blocked")}</option>
                <option value="favorites">{text(lang, "只看收藏", "Favorites only")}</option>
              </select>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortId)} aria-label={text(lang, "排序", "Sort") }>
                <option value="curated">{text(lang, "精选顺序", "Curated order")}</option>
                <option value="stars">{text(lang, "按星标", "By stars")}</option>
                <option value="updated">{text(lang, "最近更新", "Recently pushed")}</option>
                <option value="added">{text(lang, "最近收录", "Recently added")}</option>
                <option value="name">{text(lang, "名称 A→Z", "Name A→Z")}</option>
              </select>
              <div className="view-switch" aria-label={text(lang, "视图", "View") }>
                <button className={view === "list" ? "is-active" : ""} type="button" onClick={() => setView("list")} title={text(lang, "列表", "List")}>☰</button>
                <button className={view === "cards" ? "is-active" : ""} type="button" onClick={() => setView("cards")} title={text(lang, "卡片", "Cards")}>▦</button>
              </div>
            </div>
            <div className="category-chips">
              <button className={category === "all" ? "is-active" : ""} type="button" onClick={() => setCategory("all")}>{text(lang, "全部", "All")} <small>{data.plugins.length}</small></button>
              {CATEGORY_ORDER.map((id) => (
                <button className={category === id ? "is-active" : ""} type="button" key={id} onClick={() => setCategory(id)}>{data.categories[id][lang]} <small>{categoryCounts[id]}</small></button>
              ))}
            </div>
            {filtered.length ? (
              <div className={`plugin-results plugin-results--${view}`}>
                {filtered.map((plugin) => (
                  <PluginCard
                    key={plugin.id}
                    plugin={plugin}
                    lang={lang}
                    favorite={favorites.includes(plugin.id)}
                    onOpen={() => setSelected(plugin)}
                    onFavorite={() => toggleFavorite(plugin.id)}
                    view={view}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state"><strong>{text(lang, "没有匹配的插件", "No matching plugins")}</strong><p>{text(lang, "换个关键词或清空筛选条件。", "Try another keyword or reset the filters.")}</p><button type="button" onClick={() => { setQuery(""); setCategory("all"); setEvidence("all"); }}>{text(lang, "清空筛选", "Reset filters")}</button></div>
            )}
          </section>
        )}

        {!passportRoute && page === "rank" && (
          <section className="shell page-section">
            <div className="page-heading"><div><span className="section-kicker">PUBLIC SIGNALS</span><h1>{text(lang, "排行榜", "Leaderboard")}</h1><p>{text(lang, "星标与推送时间来自 GitHub。它们代表关注度和活跃度，不代表安全或质量。", "Stars and push times come from GitHub. They signal attention and activity, not safety or quality.")}</p></div></div>
            <div className="rank-grid">
              <div className="rank-panel">
                <div className="rank-panel__heading"><span>★</span><div><h2>{text(lang, "按星标", "By stars")}</h2><p>{text(lang, "社区关注度", "Community attention")}</p></div></div>
                <ol>{topStars.map((plugin, index) => <li key={plugin.id}><button type="button" onClick={() => setSelected(plugin)}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{plugin.name}</strong><small>{plugin.owner}</small></span><em>★ {formatNumber(plugin.stars, lang)}</em></button></li>)}</ol>
              </div>
              <div className="rank-panel">
                <div className="rank-panel__heading"><span>↻</span><div><h2>{text(lang, "最近更新", "Recently pushed")}</h2><p>{text(lang, "维护活跃度", "Maintenance activity")}</p></div></div>
                <ol>{topFresh.map((plugin, index) => <li key={plugin.id}><button type="button" onClick={() => setSelected(plugin)}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{plugin.name}</strong><small>{plugin.owner}</small></span><em>{relativeDate(plugin.pushedAt, lang)}</em></button></li>)}</ol>
              </div>
            </div>
          </section>
        )}

        {!passportRoute && page === "submit" && (
          <section className="shell page-section prose-page">
            <div className="page-heading"><div><span className="section-kicker">OPEN REGISTRY</span><h1>{text(lang, "让你的插件被看见", "Get your plugin listed")}</h1><p>{text(lang, "收录走公开仓库链路，站点不接收代码上传。", "Listing follows public repository workflows; this site accepts no code uploads.")}</p></div></div>
            <div className="process-grid">
              {[
                ["01", "dsh-plugin", "给 GitHub 仓库添加 dsh-plugin topic。", "Add the dsh-plugin topic to your GitHub repository."],
                ["02", "README + LICENSE", "写清功能、权限、关闭方式和许可证。", "Document behavior, permissions, removal, and license."],
                ["03", "dsh manifest", "在 package.json 声明 dsh.bundle / plugin / profile。", "Declare dsh.bundle / plugin / profile in package.json."],
                ["04", "AUTO SCAN", "网站每 30 分钟发现一次，并按 manifest、安装脚本和入口源码信号分级。", "The site discovers repositories every 30 minutes and grades manifest, install-script, and entrypoint signals."],
              ].map(([no, title, zh, en]) => <div className="process-card" key={no}><b>{no}</b><strong>{title}</strong><p>{text(lang, zh, en)}</p></div>)}
            </div>
            <div className="callout"><div><span className="section-kicker">SUBMIT</span><h2>{text(lang, "公开链路", "Public paths")}</h2></div><div className="callout__links"><a href="https://github.com/topics/dsh-plugin" target="_blank" rel="noreferrer">GitHub topic ↗</a><a href={data.sources.curated.repository} target="_blank" rel="noreferrer">awesome-dsh-plugin ↗</a></div></div>
          </section>
        )}

        {!passportRoute && page === "guide" && (
          <section className="shell page-section prose-page">
            <div className="page-heading"><div><span className="section-kicker">BUILD WITH EVIDENCE</span><h1>{text(lang, "从一个可检查的插件开始", "Start with an inspectable plugin")}</h1><p>{text(lang, "最短路径：模板、manifest、公开扩展点、静态体检、独立 profile 验证。", "The shortest path: template, manifest, public seams, static checks, isolated-profile verification.")}</p></div></div>
            <div className="guide-grid">
              {[
                ["01", "模板", "Template", "克隆最小骨架，先跑通加载与卸载。", "Clone a minimal skeleton and verify load/unload first."],
                ["02", "清单", "Manifest", "声明 bundle、入口、配置和客户端模块。", "Declare bundle, entrypoint, config, and client modules."],
                ["03", "边界", "Boundaries", "写清文件、网络、Shell、密钥和遥测。", "Document files, network, shell, secrets, and telemetry."],
                ["04", "验证", "Verification", "固定 dsh 版本，在独立 profile 和临时工作区测试。", "Pin dsh, then test in an isolated profile and disposable workspace."],
                ["05", "发布", "Publish", "提交许可证、锁文件、构建产物和可复现安装说明。", "Ship license, lockfile, build artifacts, and reproducible install steps."],
              ].map(([no, zhTitle, enTitle, zhBody, enBody]) => <article key={no}><b>{no}</b><h2>{lang === "zh" ? zhTitle : enTitle}</h2><p>{text(lang, zhBody, enBody)}</p></article>)}
            </div>
            <div className="code-panel"><span>$</span><code>npx @deepseek-ai/dsh plugin --profile web add github:owner/repository</code><button type="button" onClick={() => copy("npx @deepseek-ai/dsh plugin --profile web add github:owner/repository", "guide")}>{copied === "guide" ? text(lang, "已复制", "Copied") : text(lang, "复制", "Copy")}</button></div>
            <p className="fine-print">{text(lang, "命令只是格式示例。发布前请确认包内已有可加载产物，Git 安装所需的 prepare 脚本也应明确披露。", "The command is a format example. Before publishing, confirm the package contains loadable artifacts and disclose any prepare script needed by Git installs.")}</p>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="shell"><span>DSH PLUGIN HUB · {data.summary.listed} LISTED · {data.summary.autoDiscovered} AUTO · {visitStats?.displayCount === null || visitStats?.displayCount === undefined ? "—" : formatNumber(visitStats.displayCount, lang)} HEAT</span><span>{text(lang, "社区索引 · 作者：岚叔 · 与 DeepSeek AI 无隶属关系", "Community index · Author: 岚叔 · not affiliated with DeepSeek AI")}</span><span className="site-footer__links"><a href="/api/plugins">JSON API</a><a href="/api/visits">VISIT API</a></span></div>
      </footer>

      {selected && (
        <div className="drawer-layer" role="presentation">
          <button className="drawer-backdrop" type="button" onClick={() => setSelected(null)} aria-label={text(lang, "关闭详情", "Close details")} />
          <aside className="plugin-drawer" role="dialog" aria-modal="true" aria-labelledby="plugin-title">
            <div className="plugin-drawer__top"><span>PLUGIN {String(selected.order + 1).padStart(3, "0")}</span><button type="button" onClick={() => setSelected(null)} aria-label={text(lang, "关闭", "Close")}>×</button></div>
            <div className="plugin-drawer__body">
              <div className="plugin-drawer__badges"><span className={`evidence evidence--${sourceClass(selected)}`}>{sourceLabel(selected)}</span><span className={`signal signal--${selected.attention.level}`}>{signalLabel(selected, lang)}</span></div>
              <h2 id="plugin-title">{selected.name}</h2>
              <p className="drawer-owner">{selected.owner} · {data.categories[selected.category][lang]}</p>
              <div className="stat-chips"><span>★ {formatNumber(selected.stars, lang)}</span><span>{relativeDate(selected.pushedAt, lang)}</span><span>{selected.license || text(lang, "许可证未声明", "License missing")}</span><span>{selected.language || text(lang, "语言未知", "Language unknown")}</span></div>
              <p className="drawer-description">{selected.description[lang]}</p>

              <div className="drawer-section"><span className="drawer-label">{text(lang, "安装证据", "INSTALL EVIDENCE")}</span>
                {selected.installCommand ? <><p>{text(lang, "命令已锁定到完成检查的 Git commit；执行前仍建议阅读完整源码。", "The command is pinned to the inspected Git commit. Review the complete source before running it.")}</p><div className="code-panel code-panel--drawer"><code>{selected.installCommand}</code><button type="button" onClick={() => copy(selected.installCommand || "", selected.id)}>{copied === selected.id ? text(lang, "已复制", "Copied") : text(lang, "复制", "Copy")}</button></div></> : <p className="warning-copy">{text(lang, "当前证据不足或风险信号需要人工复核，网站暂不提供安装命令。请先查看检查项与完整源码。", "Evidence is currently insufficient or risk signals need manual review, so no install command is shown. Review the findings and complete source first.")}</p>}
              </div>

              <div className="drawer-section"><span className="drawer-label">{text(lang, "自动检查结果", "AUTOMATED SCREENING")}</span>
                <dl className="evidence-list">
                  <div><dt>{text(lang, "检查结论", "Screening")}</dt><dd>{signalLabel(selected, lang)} · {selected.screening.risk.toUpperCase()}</dd></div>
                  <div><dt>{text(lang, "检查范围", "Coverage")}</dt><dd>{selected.screening.scope === "source" ? text(lang, "manifest + 声明入口源码", "manifest + declared source") : text(lang, "仅 manifest，等待补扫", "manifest only; source pending")}</dd></div>
                  <div><dt>Manifest</dt><dd>{selected.manifest.state === "verified" ? `${selected.manifest.kinds.join(" · ")} · ${selected.manifest.packageName || "package"}` : selected.manifest.state}</dd></div>
                  <div><dt>{text(lang, "版本", "Version")}</dt><dd>{selected.manifest.version || "—"}</dd></div>
                  <div><dt>{text(lang, "已检查提交", "Screened commit")}</dt><dd>{selected.screenedCommit?.slice(0, 12) || "—"}</dd></div>
                  <div><dt>{text(lang, "运行依赖", "Runtime deps")}</dt><dd>{selected.manifest.runtimeDependencies}</dd></div>
                  <div><dt>{text(lang, "生命周期脚本", "Lifecycle scripts")}</dt><dd>{selected.manifest.lifecycleScripts.length ? selected.manifest.lifecycleScripts.join(", ") : text(lang, "未发现", "None found")}</dd></div>
                  <div><dt>{text(lang, "维护状态", "Maintenance")}</dt><dd>{maintenanceLabel(selected, lang)}</dd></div>
                  <div><dt>{text(lang, "默认分支", "Default branch")}</dt><dd>{selected.defaultBranch || "—"}</dd></div>
                  <div><dt>{text(lang, "已读文件", "Files inspected")}</dt><dd>{selected.screening.filesInspected.length ? selected.screening.filesInspected.join(" · ") : "—"}</dd></div>
                  <div><dt>{text(lang, "检查时间", "Checked at")}</dt><dd>{selected.screening.checkedAt.slice(0, 16).replace("T", " ")} UTC</dd></div>
                </dl>
                {selected.screening.findings.length > 0 && <ul className="reason-list">{selected.screening.findings.map((finding) => <li key={finding.id}>{finding.label[lang]}{finding.files.length ? ` · ${finding.files.join(", ")}` : ""}</li>)}</ul>}
              </div>

              <div className="drawer-actions">
                <a
                  className="primary-button"
                  href={`/p/${encodeURIComponent(selected.owner)}/${encodeURIComponent(selected.repo.split("/")[1] || selected.name)}/${selected.screenedCommit || "latest"}`}
                >{text(lang, "查看插件护照", "Open passport")} →</a>
                <a className="secondary-button" href={selected.url} target="_blank" rel="noreferrer">GitHub ↗</a>
                <button className={`secondary-button ${favorites.includes(selected.id) ? "is-active" : ""}`} type="button" onClick={() => toggleFavorite(selected.id)}>★ {text(lang, favorites.includes(selected.id) ? "已收藏" : "收藏", favorites.includes(selected.id) ? "Saved" : "Save")}</button>
              </div>
              <p className="drawer-disclaimer">{text(lang, "自动检查覆盖有限文件和规则，可能漏报，也可能误报。安装插件仍会在你的机器上执行第三方代码；高权限项目请放进独立 profile 与临时工作区验证。", "Automated screening covers a limited set of files and rules, so false negatives and false positives remain possible. Plugins still execute third-party code on your machine; test high-authority projects in an isolated profile and disposable workspace.")}</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
