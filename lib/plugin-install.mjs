const COMMIT_PATTERN = /^[a-f\d]{40,64}$/iu;
const REPOSITORY_PATTERN = /^[a-z\d_.-]+\/[a-z\d_.-]+$/iu;

function immutableCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function repositoryName(value) {
  return typeof value === "string" && REPOSITORY_PATTERN.test(value)
    ? value
    : null;
}

function commandFor(repo, commit) {
  return `dsh plugin --profile web add github:${repo}#${commit}`;
}

/**
 * Return a copy-ready install command only when it is backed by immutable
 * evidence: either the automated scanner's exact command or a Codex Pick's
 * manually reviewed commit. Free-form commands from registry data are never
 * forwarded to the browser.
 */
export function resolvePluginInstall(plugin) {
  if (!plugin || typeof plugin !== "object") return null;
  const repo = repositoryName(plugin.repo);
  if (!repo) return null;

  const screenedCommit = immutableCommit(plugin.screenedCommit);
  const screenedCommand = screenedCommit ? commandFor(repo, screenedCommit) : null;
  const screeningState = plugin.screening?.state;
  const scannerAllowsInstall = plugin.manifest?.state === "verified"
    && (plugin.curated ? screeningState !== "blocked" : screeningState === "clear");
  if (scannerAllowsInstall && screenedCommand && plugin.installCommand === screenedCommand) {
    return {
      command: screenedCommand,
      commit: screenedCommit,
      source: "screened",
    };
  }

  const pick = plugin.codexPick;
  const reviewedCommit = immutableCommit(pick?.reviewedCommit);
  const pickRepo = repositoryName(pick?.repo);
  if (
    reviewedCommit
    && pickRepo?.toLowerCase() === repo.toLowerCase()
    && pick?.safety?.risk !== "high"
  ) {
    return {
      command: commandFor(repo, reviewedCommit),
      commit: reviewedCommit,
      source: "codex",
    };
  }

  return null;
}
