/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  pluginRegistryResponse,
  processPluginScanBatch,
  readPluginRegistry,
  syncPluginRegistry,
} from "./plugin-registry";
import {
  pluginPassportResponse,
  readPluginPassport,
  readPluginScanPipelineStatus,
  type PluginScanMessage,
} from "./plugin-passports";
import { incrementVisit, readVisitStats } from "../lib/visit-metrics.mjs";

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isRootDocumentRequest(request: Request, url: URL, response: Response) {
  return request.method === "GET"
    && url.pathname === "/"
    && response.ok
    && (request.headers.get("accept") || "").toLowerCase().includes("text/html");
}

function visitStatsResponse(stats: Awaited<ReturnType<typeof readVisitStats>>) {
  return Response.json(stats, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function parsePassportPath(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (parts.length < 2 || parts.length > 3) return null;
  return { repo: `${parts[0]}/${parts[1]}`, revision: parts[2] || "latest" };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/plugins") {
      const registry = await readPluginRegistry(env);
      registry.automation.pipeline = await readPluginScanPipelineStatus(env, registry.summary.listed);
      return withSecurityHeaders(pluginRegistryResponse(registry));
    }

    if (request.method === "GET" && url.pathname === "/api/registry/status") {
      const registry = await readPluginRegistry(env);
      const pipeline = await readPluginScanPipelineStatus(env, registry.summary.listed);
      return withSecurityHeaders(Response.json({
        generatedAt: registry.generatedAt,
        automation: { ...registry.automation, pipeline },
        summary: {
          listed: registry.summary.listed,
          autoDiscovered: registry.summary.autoDiscovered,
          screeningClear: registry.summary.screeningClear,
          screeningReview: registry.summary.screeningReview,
          screeningBlocked: registry.summary.screeningBlocked,
        },
      }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } }));
    }

    if (request.method === "GET") {
      const passportRoute = parsePassportPath(url.pathname, "/api/passports/");
      if (passportRoute) {
        const registry = await readPluginRegistry(env);
        const fallback = registry.plugins.find((plugin) => plugin.repo.toLowerCase() === passportRoute.repo.toLowerCase()) || null;
        const passport = await readPluginPassport(env, passportRoute.repo, passportRoute.revision, fallback);
        return withSecurityHeaders(passport
          ? pluginPassportResponse(passport)
          : Response.json({ error: "Plugin passport not found" }, {
              status: 404,
              headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            }));
      }
    }

    if (request.method === "GET" && url.pathname === "/api/visits") {
      try {
        return withSecurityHeaders(visitStatsResponse(await readVisitStats(env)));
      } catch (error) {
        console.error(JSON.stringify({
          event: "visits.read.error",
          error: error instanceof Error ? error.message : String(error),
        }));
        return withSecurityHeaders(Response.json({ error: "Visit metrics unavailable" }, {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        }));
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withSecurityHeaders(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    const passportPage = request.method === "GET" ? parsePassportPath(url.pathname, "/p/") : null;
    const appRequest = passportPage
      ? new Request(new URL("/", request.url), request)
      : request;
    const response = await handler.fetch(appRequest, env, ctx);
    if (env.VISIT_METRICS && isRootDocumentRequest(request, url, response)) {
      ctx.waitUntil(incrementVisit(env).catch((error) => {
        console.error(JSON.stringify({
          event: "visits.increment.error",
          error: error instanceof Error ? error.message : String(error),
        }));
      }));
    }
    return withSecurityHeaders(response);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await syncPluginRegistry(env);
  },

  async queue(batch: MessageBatch<PluginScanMessage>, env: Env): Promise<void> {
    await processPluginScanBatch(batch, env);
  },
} satisfies ExportedHandler<Env, PluginScanMessage>;

export default worker;
