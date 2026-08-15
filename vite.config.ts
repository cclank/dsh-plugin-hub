import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  // Keep this within the workerd version bundled by the pinned Cloudflare
  // Vite plugin; newer dates currently prevent local Workers startup.
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  kv_namespaces: [
    {
      binding: "PLUGIN_REGISTRY",
    },
  ],
  d1_databases: [
    {
      binding: "VISIT_METRICS",
      database_name: "dsh-plugin-hub-visits",
      database_id: "bfbef53b-3de8-41ee-987f-8e11bc71a08a",
      migrations_dir: "migrations",
    },
  ],
  vars: {
    VISIT_DISPLAY_MULTIPLIER: "3",
  },
  triggers: {
    crons: ["*/30 * * * *"],
  },
  routes: [
    {
      pattern: "dsh.lanshuagent.com",
      custom_domain: true,
    },
  ],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
