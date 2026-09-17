/// <reference lib="deno.ns" />

import { getKv } from "./src/kv.ts";
import { config } from "./src/config.ts";
import { configureAdminAuthForListener, configureAdminAuthPeerForRequest, parseServeRuntimeOptions } from "./src/local_admin_auth.ts";
import { ensureLocalDevelopmentApiKey } from "./src/local_development_key.ts";
import { reconcileDuePaidFallbacksV3 } from "./src/paid_fallback_ledger.ts";
import { prunePromptCacheAnalytics } from "./src/prompt_cache_analytics.ts";
import { sampleProviderCapacityForCron } from "./src/provider_capacity.ts";
import { fetchOpenRouterModels } from "./src/openrouter_models.ts";
import { createServeHandler } from "./src/serve_handler.ts";
const isProductionRuntime = (): boolean => Deno.env.get("DENO_TIMELINE") === "production";

void Deno.cron("reconcile pending metered billing", "* * * * *", async () => {
  if (!isProductionRuntime()) return;
  try {
    // KV is optional at process boot. Resolve it only when the scheduled
    // reconciliation actually runs so a slow KV connection cannot prevent
    // a new Deploy revision from reaching the serving state.
    const kv = await getKv();
    if (!kv) return;
    await reconcileDuePaidFallbacksV3(Date.now(), kv);
  } catch (error) {
    console.error("[ai.ubq.fi] Scheduled paid fallback reconciliation failed:", error instanceof Error ? error.message : String(error));
  }
});

void Deno.cron("sample Codex provider capacity", "*/15 * * * *", async () => {
  if (!isProductionRuntime()) return;
  try {
    const kv = await getKv();
    if (!kv) return;
    await sampleProviderCapacityForCron({ kv });
  } catch (error) {
    console.error("[ai.ubq.fi] Provider capacity sampler failed:", error instanceof Error ? error.message : String(error));
  }
});

void Deno.cron("refresh model metadata enrichment", "*/5 * * * *", async () => {
  if (!isProductionRuntime()) return;
  try {
    // TTL-aware: a request that already refreshed the snapshot inside the window
    // makes this cheap, so the catalog stays warm without polling harder than the
    // cache needs. A failed refresh keeps the last good snapshot.
    await fetchOpenRouterModels();
  } catch (error) {
    console.error("[ai.ubq.fi] Model metadata refresh failed:", error instanceof Error ? error.message : String(error));
  }
});

void Deno.cron("prune prompt cache analytics", "7 * * * *", async () => {
  if (!isProductionRuntime()) return;
  try {
    const kv = await getKv();
    if (!kv) return;
    const result = await prunePromptCacheAnalytics({ kv });
    if (result.status === "unavailable") {
      console.warn("[ai.ubq.fi] prompt_cache_analytics", JSON.stringify({ status: "prune_unavailable" }));
    }
  } catch {
    console.warn("[ai.ubq.fi] prompt_cache_analytics", JSON.stringify({ status: "prune_failed" }));
  }
});

const serveHandler = createServeHandler();

const runtimeOptions = parseServeRuntimeOptions(Deno.args, { isDeploy: config.isDeploy });

// `--disable-admin-auth` is loopback-only (a non-loopback listener fails at
// startup), so provisioning here can never reach a hosted deployment. The local
// development key makes loopback requests a super-admin inference principal
// with unlimited paid-provider routing instead of a policy-free one.
if (runtimeOptions.disableAdminAuth) {
  try {
    const kv = await getKv();
    if (kv) {
      const status = await ensureLocalDevelopmentApiKey(kv);
      if (status === "created") console.log("[ai.ubq.fi] Provisioned the local development API key for loopback inference.");
      else if (status === "revoked") console.warn("[ai.ubq.fi] The local development API key is revoked; local paid-provider routing stays off.");
    }
  } catch (error) {
    console.warn("[ai.ubq.fi] Local development key provisioning failed:", error instanceof Error ? error.message : String(error));
  }
}

const server: Deno.ServeDefaultExport = runtimeOptions.disableAdminAuth
  ? {
      fetch(request, info) {
        configureAdminAuthPeerForRequest(info.remoteAddr);
        return serveHandler(request, info);
      },
      onListen(address) {
        configureAdminAuthForListener(runtimeOptions, address);
        const netAddress = address as Deno.NetAddr;
        const hostname = netAddress.hostname.includes(":") ? `[${netAddress.hostname}]` : netAddress.hostname;
        console.log(`Listening on http://${hostname}:${netAddress.port}/`);
        console.warn("[ai.ubq.fi] WARNING: admin authentication is disabled for this loopback development server.");
      },
    }
  : { fetch: serveHandler };

export default server;
