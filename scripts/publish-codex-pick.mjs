#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { normalizeCodexPicksFeed } from "../lib/codex-picks.mjs";

const HUB_REPOSITORY = "cclank/dsh-plugin-hub";
const PICKS_PATH = "data/codex-picks.json";

function usage() {
  return `Usage:
  npm run picks:publish -- \\
    --repo owner/repository \\
    --commit 40-character-sha \\
    --category tools \\
    --summary-zh "..." --summary-en "..." \\
    --reason-zh "..." --reason-en "..." \\
    --risk low --safety-zh "..." --safety-en "..." \\
    [--picked-at ISO] [--publish]

Without --publish the command validates and prints a dry-run summary. It never
writes the local checkout. --publish updates the single public JSON file through
the authenticated GitHub CLI using optimistic concurrency.`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    if (token === "--publish" || token === "--help") {
      flags.add(token.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${token}`);
    values.set(token.slice(2), value);
    index += 1;
  }
  return { values, flags };
}

function required(values, key) {
  const value = values.get(key)?.trim();
  if (!value) throw new TypeError(`Missing --${key}`);
  return value;
}

function ghJson(args) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

function buildPick(values) {
  return {
    repo: required(values, "repo"),
    pickedAt: values.get("picked-at") || new Date().toISOString(),
    reviewedCommit: required(values, "commit"),
    category: required(values, "category"),
    summary: {
      zh: required(values, "summary-zh"),
      en: required(values, "summary-en"),
    },
    reason: {
      zh: required(values, "reason-zh"),
      en: required(values, "reason-en"),
    },
    safety: {
      risk: required(values, "risk"),
      zh: required(values, "safety-zh"),
      en: required(values, "safety-en"),
    },
  };
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    console.log(usage());
    return;
  }

  const remote = ghJson([
    "api",
    `repos/${HUB_REPOSITORY}/contents/${PICKS_PATH}`,
  ]);
  if (typeof remote.content !== "string" || typeof remote.sha !== "string") {
    throw new Error("GitHub returned an invalid Codex picks document");
  }
  const current = normalizeCodexPicksFeed(JSON.parse(Buffer.from(remote.content, "base64").toString("utf8")));
  const candidate = buildPick(values);
  const normalizedCandidate = normalizeCodexPicksFeed({
    ...current,
    picks: [candidate],
  }).picks[0];
  if (current.picks.some((pick) => pick.repo === normalizedCandidate.repo)) {
    console.log(JSON.stringify({ status: "already-present", repo: normalizedCandidate.repo }));
    return;
  }

  const next = normalizeCodexPicksFeed({
    ...current,
    updatedAt: new Date().toISOString(),
    source: "codex-hourly-review",
    picks: [normalizedCandidate, ...current.picks],
  });
  if (!flags.has("publish")) {
    console.log(JSON.stringify({
      status: "dry-run",
      repo: normalizedCandidate.repo,
      count: next.picks.length,
      reviewedCommit: normalizedCandidate.reviewedCommit,
    }, null, 2));
    return;
  }

  const content = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8").toString("base64");
  const result = ghJson([
    "api",
    "-X", "PUT",
    `repos/${HUB_REPOSITORY}/contents/${PICKS_PATH}`,
    "-f", `message=curation: add Codex pick ${normalizedCandidate.repo}`,
    "-f", `content=${content}`,
    "-f", `sha=${remote.sha}`,
  ]);
  console.log(JSON.stringify({
    status: "published",
    repo: normalizedCandidate.repo,
    commit: result.commit?.sha || null,
    url: result.commit?.html_url || null,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
