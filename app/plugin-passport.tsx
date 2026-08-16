"use client";

import type {
  Language,
  PluginPassportData,
  PluginRecord,
} from "@/lib/plugin-data";
import { useEffect, useState } from "react";

export interface PluginPassportRoute {
  owner: string;
  repository: string;
  revision: string;
}

function text(lang: Language, zh: string, en: string) {
  return lang === "zh" ? zh : en;
}

const CAPABILITY_LABELS: Record<string, Record<Language, string>> = {
  "permission-bypass": { zh: "权限确认绕过", en: "Permission bypass" },
  "dynamic-code": { zh: "动态代码执行", en: "Dynamic code" },
  "destructive-filesystem": { zh: "破坏性文件操作", en: "Destructive filesystem" },
  "shell-execution": { zh: "Shell / 子进程", en: "Shell / subprocess" },
  "network-egress": { zh: "网络外发", en: "Network egress" },
  "filesystem-write": { zh: "文件写入", en: "Filesystem writes" },
  "credential-access": { zh: "凭据访问", en: "Credential access" },
  "public-listener": { zh: "网络监听", en: "Network listener" },
  "html-execution": { zh: "HTML / SVG 主动内容", en: "Active HTML / SVG" },
  telemetry: { zh: "遥测 / 分析", en: "Telemetry / analytics" },
};

function capabilityLabel(id: string, lang: Language) {
  return CAPABILITY_LABELS[id]?.[lang] || id;
}

function statusLabel(state: string, lang: Language) {
  if (state === "clear") return text(lang, "静态检查通过", "Static scan clear");
  if (state === "review") return text(lang, "需要人工复核", "Manual review needed");
  if (state === "blocked") return text(lang, "静态检查拦截", "Static scan blocked");
  return text(lang, "等待完整检查", "Awaiting full scan");
}

function formatTimestamp(value: string, lang: Language) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(time));
}

function diffCount(passport: PluginPassportData) {
  const diff = passport.current.diff;
  return [
    diff.dependencies,
    diff.peerDependencies,
    diff.lifecycleScripts,
    diff.capabilities,
    diff.externalDomains,
    diff.maintainers,
    diff.manifestKinds,
  ].reduce((sum, item) => sum + item.added.length + item.removed.length, 0);
}

function ChangeList({
  title,
  added,
  removed,
  lang,
}: {
  title: string;
  added: string[];
  removed: string[];
  lang: Language;
}) {
  if (!added.length && !removed.length) return null;
  return (
    <div className="passport-change-group">
      <strong>{title}</strong>
      <div>
        {added.map((item) => <span className="passport-change passport-change--added" key={`add-${item}`}>+ {item}</span>)}
        {removed.map((item) => <span className="passport-change passport-change--removed" key={`remove-${item}`}>− {item}</span>)}
      </div>
      {!added.length && !removed.length && <em>{text(lang, "无变化", "No changes")}</em>}
    </div>
  );
}

export function PluginPassportView({
  route,
  lang,
  fallback,
  onBack,
}: {
  route: PluginPassportRoute;
  lang: Language;
  fallback: PluginRecord | null;
  onBack: () => void;
}) {
  const [result, setResult] = useState<{
    url: string;
    data: PluginPassportData | null;
    error: string | null;
  } | null>(null);
  const repo = `${route.owner}/${route.repository}`;
  const apiUrl = `/api/passports/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repository)}/${encodeURIComponent(route.revision)}`;

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Passport request failed: ${response.status}`);
        const data = await response.json() as PluginPassportData;
        if (!data.current?.evidence || data.repo.toLowerCase() !== repo.toLowerCase()) {
          throw new Error("Passport response has an invalid shape");
        }
        setResult({ url: apiUrl, data, error: null });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setResult({ url: apiUrl, data: null, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => controller.abort();
  }, [apiUrl, repo]);

  const passport = result?.url === apiUrl ? result.data : null;
  const error = result?.url === apiUrl ? result.error : null;
  const currentRecord = passport?.current.record || fallback;
  const title = currentRecord?.name || route.repository;
  const rawUrl = passport ? apiUrl : null;
  const capabilities = Object.entries(passport?.current.evidence.capabilities || {});

  return (
    <section className="shell page-section passport-page">
      <button className="passport-back" type="button" onClick={onBack}>← {text(lang, "返回目录", "Back to catalog")}</button>
      <div className="passport-heading">
        <div>
          <span className="section-kicker">PLUGIN PASSPORT · IMMUTABLE EVIDENCE</span>
          <h1>{title}</h1>
          <p>{repo} · {route.revision === "latest" ? "LATEST" : route.revision.slice(0, 12)}</p>
        </div>
        <div className="passport-heading__actions">
          {currentRecord?.url && <a className="secondary-button" href={currentRecord.url} target="_blank" rel="noreferrer">GitHub ↗</a>}
          {rawUrl && <a className="primary-button" href={rawUrl} target="_blank" rel="noreferrer">{text(lang, "原始 JSON", "Raw JSON")} ↗</a>}
        </div>
      </div>

      {!passport && !error && <div className="passport-loading">{text(lang, "正在读取不可变检查证据…", "Loading immutable scan evidence…")}</div>}
      {error && <div className="passport-error"><strong>{text(lang, "护照暂不可用", "Passport unavailable")}</strong><span>{error}</span></div>}

      {passport && (() => {
        const evidence = passport.current.evidence;
        const diff = passport.current.diff;
        const changedItems = diffCount(passport);
        const disclosure = evidence.disclosure;
        const verification = evidence.verification;
        return (
          <>
            <div className={`passport-verdict passport-verdict--${evidence.screening.state}`}>
              <div><span>{text(lang, "当前结论", "CURRENT VERDICT")}</span><strong>{statusLabel(evidence.screening.state, lang)}</strong></div>
              <div><span>{text(lang, "风险", "RISK")}</span><strong>{evidence.screening.risk.toUpperCase()}</strong></div>
              <div><span>{text(lang, "证据版本", "EVIDENCE VERSION")}</span><strong>SCAN {evidence.scannerVersion}</strong></div>
              <div><span>{text(lang, "检查时间", "CHECKED")}</span><strong>{formatTimestamp(evidence.checkedAt, lang)}</strong></div>
            </div>

            <div className="passport-layers">
              <article>
                <span>01 · CAPABILITY</span>
                <h2>{text(lang, "实际能力信号", "Capability signals")}</h2>
                <p>{text(lang, "源码中检测到的能力。具备能力不等于恶意，需结合披露和验证判断。", "Capabilities detected in source. A capability alone does not imply malicious intent.")}</p>
                <div className="passport-tags">
                  {capabilities.length
                    ? capabilities.map(([id, files]) => <span key={id} title={files.join(", ")}>{capabilityLabel(id, lang)}</span>)
                    : <span className="is-clear">{text(lang, "未发现高权限能力信号", "No privileged capability signal")}</span>}
                </div>
              </article>
              <article>
                <span>02 · DISCLOSURE</span>
                <h2>{text(lang, "作者披露", "Author disclosure")}</h2>
                <p>{text(lang, "README 与安全说明是否交代权限、数据去向、遥测和关闭方式。", "Whether docs explain permissions, data handling, telemetry, and opt-out.")}</p>
                <dl className="passport-checks">
                  <div><dt>{text(lang, "安全边界", "Security")}</dt><dd>{disclosure.security ? "✓" : "—"}</dd></div>
                  <div><dt>{text(lang, "权限说明", "Permissions")}</dt><dd>{disclosure.permissions ? "✓" : "—"}</dd></div>
                  <div><dt>{text(lang, "数据去向", "Data use")}</dt><dd>{disclosure.dataUse ? "✓" : "—"}</dd></div>
                  <div><dt>{text(lang, "关闭方式", "Opt-out")}</dt><dd>{disclosure.disableOrOptOut ? "✓" : "—"}</dd></div>
                </dl>
              </article>
              <article>
                <span>03 · VERIFICATION</span>
                <h2>{text(lang, "验证覆盖", "Verification coverage")}</h2>
                <p>{text(lang, "每项结论都绑定检查提交、扫描器版本和实际读取文件。", "Every result is bound to a commit, scanner version, and inspected files.")}</p>
                <strong className="passport-score">{verification.score}/{verification.possibleScore}</strong>
                <div className="passport-scorebar"><i style={{ width: `${(verification.score / Math.max(1, verification.possibleScore)) * 100}%` }} /></div>
                <small>{verification.filesInspected.length} {text(lang, "个文件证据", "evidence files")}</small>
              </article>
            </div>

            <section className={`passport-diff passport-diff--${diff.severity}`}>
              <div className="passport-section-heading">
                <div><span className="section-kicker">VERSION CHANGE RADAR</span><h2>{text(lang, "版本变更雷达", "Version change radar")}</h2></div>
                <p>{diff.fromCommit
                  ? text(lang, `相对上一个检查版本发现 ${changedItems} 项变化`, `${changedItems} changes since the previous inspected version`)
                  : text(lang, "这是该插件的首份检查基线", "This is the first inspected baseline")}</p>
              </div>
              {diff.fromCommit && <div className="passport-commit-flow"><code>{diff.fromCommit.slice(0, 12)}</code><span>→</span><code>{diff.toCommit.slice(0, 12)}</code><b>{diff.severity.toUpperCase()}</b></div>}
              <div className="passport-change-grid">
                <ChangeList title={text(lang, "运行依赖", "Dependencies")} {...diff.dependencies} lang={lang} />
                <ChangeList title={text(lang, "Peer 依赖", "Peer dependencies")} {...diff.peerDependencies} lang={lang} />
                <ChangeList title={text(lang, "生命周期脚本", "Lifecycle scripts")} {...diff.lifecycleScripts} lang={lang} />
                <ChangeList title={text(lang, "能力信号", "Capabilities")} added={diff.capabilities.added.map((id) => capabilityLabel(id, lang))} removed={diff.capabilities.removed.map((id) => capabilityLabel(id, lang))} lang={lang} />
                <ChangeList title={text(lang, "外联域名", "External domains")} {...diff.externalDomains} lang={lang} />
                <ChangeList title={text(lang, "维护者", "Maintainers")} {...diff.maintainers} lang={lang} />
              </div>
              {diff.fromCommit && changedItems === 0 && <p className="passport-no-change">{text(lang, "未发现权限、依赖或外联边界变化。", "No permission, dependency, or egress boundary change detected.")}</p>}
            </section>

            <div className="passport-details-grid">
              <section>
                <span className="section-kicker">MANIFEST & SUPPLY CHAIN</span>
                <h2>{text(lang, "包与供应链", "Package and supply chain")}</h2>
                <dl className="evidence-list">
                  <div><dt>{text(lang, "版本", "Version")}</dt><dd>{evidence.package.version || "—"}</dd></div>
                  <div><dt>{text(lang, "Manifest", "Manifest")}</dt><dd>{evidence.manifest.kinds.join(" · ") || evidence.manifest.state}</dd></div>
                  <div><dt>{text(lang, "生命周期脚本", "Lifecycle")}</dt><dd>{Object.keys(evidence.package.lifecycleScripts).join(" · ") || text(lang, "未发现", "None")}</dd></div>
                  <div><dt>{text(lang, "运行依赖", "Runtime dependencies")}</dt><dd>{evidence.package.dependencies.length}</dd></div>
                  <div><dt>{text(lang, "许可证", "License")}</dt><dd>{evidence.repository.license || "—"}</dd></div>
                  <div><dt>{text(lang, "维护者", "Maintainers")}</dt><dd>{evidence.package.maintainers.join(" · ") || "—"}</dd></div>
                </dl>
              </section>
              <section>
                <span className="section-kicker">EGRESS & FILE EVIDENCE</span>
                <h2>{text(lang, "数据边界证据", "Data-boundary evidence")}</h2>
                <div className="passport-list-block"><strong>{text(lang, "外联域名", "External domains")}</strong><p>{evidence.externalDomains.join(" · ") || text(lang, "在已读源码中未发现", "None in inspected source")}</p></div>
                <div className="passport-list-block"><strong>{text(lang, "已读文件", "Files inspected")}</strong><p>{verification.filesInspected.join(" · ") || "—"}</p></div>
              </section>
            </div>

            <section className="passport-history">
              <div className="passport-section-heading"><div><span className="section-kicker">IMMUTABLE HISTORY</span><h2>{text(lang, "检查历史", "Inspection history")}</h2></div><p>{passport.history.length} {text(lang, "个不可变版本", "immutable versions")}</p></div>
              <ol>
                {passport.history.map((version) => (
                  <li key={`${version.commitSha}-${version.scannerVersion}`}>
                    <a href={`/p/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repository)}/${version.commitSha}`}>
                      <code>{version.commitSha.slice(0, 12)}</code>
                      <span>{version.packageVersion || "—"}</span>
                      <span>{statusLabel(version.state, lang)}</span>
                      <span>{version.diff.severity.toUpperCase()}</span>
                      <time>{formatTimestamp(version.checkedAt, lang)}</time>
                    </a>
                  </li>
                ))}
              </ol>
            </section>
          </>
        );
      })()}
    </section>
  );
}
