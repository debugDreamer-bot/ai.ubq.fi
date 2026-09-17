import assert from "node:assert/strict";

import adminHtml from "../static/admin.html" with { type: "text" };
import adminScript from "../static/admin.js" with { type: "text" };
import adminSource from "../src/admin.ts" with { type: "text" };
import { handleAdminCodexModelsWhitelistGet, handleAdminCodexModelsWhitelistSet, handleAdminModelsCatalogGet } from "../src/admin.ts";
import {
  CODEX_MODELS_WHITELIST_KV_KEY,
  filterWhitelistedCatalogModels,
  filterWhitelistedModelList,
  filterWhitelistedModelMap,
  normalizeWhitelistModelIds,
  type CodexModelsWhitelist,
} from "../src/codex_models_whitelist.ts";
import handler from "../src/handler.ts";
import { setKvForTest } from "../src/kv.ts";
import openaiSource from "../src/openai.ts" with { type: "text" };

const WHITELIST_URL = "https://ai.ubq.fi/admin/models/whitelist";

const keyOf = (key: Deno.KvKey): string => JSON.stringify(key);

/** Minimal Deno.Kv stand-in: the whitelist paths only read and write one key. */
class WhitelistKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: Deno.KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<Deno.KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000002" });
  }

  storedWhitelist(): CodexModelsWhitelist | null {
    return (this.values.get(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY])) ?? null) as CodexModelsWhitelist | null;
  }
}

const catalogFixture = () => ({
  models: [
    { id: "gpt-5.6-sol", providers: [{ id: "codex" as const, owned_by: "openai", supported_endpoints: ["/v1/responses"] }], created: 1_800_000_000 },
    { id: "gpt-5.6-terra", providers: [{ id: "codex" as const, owned_by: "openai", supported_endpoints: ["/v1/responses"] }], created: 1_700_000_000 },
    {
      id: "kimi-k2",
      providers: [{ id: "surplus" as const, owned_by: "moonshot", supported_endpoints: ["/v1/chat/completions"] }],
    },
  ],
  sources: {
    codex: { status: "available" as const, count: 2, updated_at_ms: 1 },
    openlux: { status: "unavailable" as const, count: 0, updated_at_ms: null },
    surplus: { status: "available" as const, count: 1, updated_at_ms: 2 },
  },
});

const withKv = async (kv: WhitelistKv | null, run: () => Promise<void>): Promise<void> => {
  setKvForTest(kv as unknown as Deno.Kv | null);
  try {
    await run();
  } finally {
    setKvForTest(null);
  }
};

Deno.test("admin model picker lists every discovered model alongside the saved selection", async () => {
  const kv = new WhitelistKv();
  kv.values.set(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY]), { model_ids: ["gpt-5.6-sol"], updated_at_ms: 1_700_000_000_000 });
  await withKv(kv, async () => {
    let builds = 0;
    const response = await handleAdminModelsCatalogGet({
      buildCatalog: () => {
        builds += 1;
        return Promise.resolve(catalogFixture());
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(builds, 1);
    const body = await response.json();
    assert.deepEqual(
      body.data.models.map((model: { id: string }) => model.id),
      ["gpt-5.6-sol", "gpt-5.6-terra", "kimi-k2"],
      "an unfiltered catalog keeps the hidden models selectable"
    );
    assert.deepEqual(body.data.whitelist.model_ids, ["gpt-5.6-sol"]);
    assert.equal(body.data.whitelist.updated_at_ms, 1_700_000_000_000);
    assert.equal(body.data.filter_active, true);
    assert.deepEqual(body.data.sources, catalogFixture().sources, "per-source availability reaches the operator");
  });
});

Deno.test("an empty stored whitelist is reported as no filter, not as nothing selected", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    const empty = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.data.whitelist, { model_ids: [], updated_at_ms: 0 });
    assert.equal(emptyBody.data.filter_active, false);

    kv.values.set(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY]), { model_ids: [], updated_at_ms: 1_700_000_000_000 });
    const stored = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    const storedBody = await stored.json();
    assert.equal(storedBody.data.filter_active, false, "an empty saved list lists every model");
  });
});

Deno.test("the model picker refuses to render without KV", async () => {
  await withKv(null, async () => {
    const response = await handleAdminModelsCatalogGet({
      buildCatalog: () => Promise.reject(new Error("the catalog must not be built without KV")),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.type, "server_error");
  });
});

Deno.test("saving a selection trims, de-duplicates, and preserves the operator's order", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    const saved = await handleAdminCodexModelsWhitelistSet(
      new Request(WHITELIST_URL, {
        method: "POST",
        body: JSON.stringify({ model_ids: [" gpt-5.6-sol ", "gpt-5.6-sol", "", "  ", "gpt-5.6-terra"] }),
      })
    );
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.deepEqual(savedBody.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.equal(savedBody.stored, true);
    assert.deepEqual(kv.storedWhitelist()?.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"], "KV stores the canonical order");

    const read = await handleAdminCodexModelsWhitelistGet();
    assert.deepEqual((await read.json()).data.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"]);

    const cleared = await handleAdminCodexModelsWhitelistSet(new Request(WHITELIST_URL, { method: "POST", body: JSON.stringify({ model_ids: [] }) }));
    assert.equal(cleared.status, 200);
    assert.deepEqual(kv.storedWhitelist()?.model_ids, [], "an empty selection clears the filter");
  });
});

Deno.test("the model picker rejects a selection it cannot store faithfully", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    for (const body of ['{"model_ids":"gpt-5.6-sol"}', '{"model_ids":[42]}', "not json", "{}"]) {
      const response = await handleAdminCodexModelsWhitelistSet(new Request(WHITELIST_URL, { method: "POST", body }));
      assert.equal(response.status, 400, body);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
    assert.equal(kv.storedWhitelist(), null, "a rejected selection must not be persisted");

    const oversized = await handleAdminCodexModelsWhitelistSet(
      new Request(WHITELIST_URL, {
        method: "POST",
        body: JSON.stringify({ model_ids: Array.from({ length: 4_000 }, (_, index) => `model-${index}-${"x".repeat(40)}`) }),
      })
    );
    assert.equal(oversized.status, 413);
    assert.equal(kv.storedWhitelist(), null);
  });
});

Deno.test("normalizeWhitelistModelIds keeps the first spelling of every identifier", () => {
  assert.deepEqual(normalizeWhitelistModelIds([" a ", "b", "a", "", "   ", 7, null, "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizeWhitelistModelIds([]), []);
});

Deno.test("whitelist filters hide unlisted models on every model surface, and an empty list hides none", () => {
  const listModels = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const catalogModels = [{ slug: "a" }, { id: "b" }, { name: "c" }];
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const saved = (modelIds: readonly string[]): CodexModelsWhitelist => ({ model_ids: modelIds, updated_at_ms: 1 });

  assert.deepEqual(
    filterWhitelistedModelList(listModels, null).map((model) => model.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    filterWhitelistedModelList(listModels, saved([])).map((model) => model.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    filterWhitelistedModelList(listModels, saved(["b", "gone"])).map((model) => model.id),
    ["b"]
  );

  assert.deepEqual(filterWhitelistedCatalogModels(catalogModels, null).length, 3);
  assert.deepEqual(filterWhitelistedCatalogModels(catalogModels, saved([])).length, 3);
  assert.deepEqual(
    filterWhitelistedCatalogModels(catalogModels, saved(["a", "c"])).map((model) => model.slug ?? model.id ?? model.name),
    ["a", "c"]
  );

  assert.deepEqual(filterWhitelistedModelMap(entries, saved([])).length, 3);
  assert.deepEqual(
    filterWhitelistedModelMap(entries, saved(["c"])).map((entry) => entry.id),
    ["c"]
  );
});

Deno.test("the model picker route is registered and stays behind admin auth", async () => {
  const unauthenticated = await handler(new Request("https://ai.ubq.fi/admin/models/catalog"));
  assert.equal(unauthenticated.status, 401, "an unauthenticated catalog read reaches the admin gate instead of 404");
  const unknown = await handler(new Request("https://ai.ubq.fi/admin/models/catalog-unknown"));
  assert.equal(unknown.status, 404);
});

Deno.test("the public and admin catalogs are built by one shared unfiltered snapshot", () => {
  // Drift guard: the admin picker must list models the whitelist hides, and the
  // public catalog must still apply the whitelist to the very same snapshot.
  const publicHandler = /export const handlePublicModelCatalog = async \(\): Promise<Response> => \{([\s\S]*?)\n\};/.exec(openaiSource)?.[1] ?? "";
  assert.notEqual(publicHandler, "", "handlePublicModelCatalog must stay declared");
  assert.match(publicHandler, /const catalog = await buildModelCatalogSnapshot\(\);/);
  assert.match(publicHandler, /filterWhitelistedModelMap\(catalog\.models, catalogWhitelist\)/);
  assert.match(publicHandler, /sources: catalog\.sources/);

  const adminHandler = /export const handleAdminModelsCatalogGet = async \(([\s\S]*?)\n\};/.exec(adminSource)?.[1] ?? "";
  assert.notEqual(adminHandler, "", "handleAdminModelsCatalogGet must stay declared");
  assert.match(adminHandler, /const buildCatalog = dependencies\.buildCatalog \?\? buildModelCatalogSnapshot;/);
  assert.match(adminHandler, /models: catalog\.models/);
  assert.doesNotMatch(adminHandler, /filterWhitelisted/, "the picker must not hide the models it can re-enable");
});

Deno.test("the Models tab renders checkbox tools instead of a free-text whitelist", () => {
  assert.match(adminHtml, /id="models-whitelist-list" data-model-picker/);
  assert.doesNotMatch(adminHtml, /models-whitelist-input/);
  assert.doesNotMatch(adminScript, /modelsWhitelistInput/);
  for (const id of [
    "models-whitelist-search",
    "models-whitelist-sort",
    "models-whitelist-only-selected",
    "models-whitelist-check-all",
    "models-whitelist-uncheck-all",
    "models-whitelist-invert",
    "models-whitelist-drop-missing",
    "models-whitelist-discard",
    "models-whitelist-reload",
    "models-whitelist-save",
    "models-whitelist-badge",
    "models-whitelist-summary",
    "models-whitelist-warning",
  ]) {
    assert.match(adminHtml, new RegExp(`id="${id}"`), `${id} must be rendered`);
    assert.match(adminScript, new RegExp(`mustGet\\("${id}"\\)`), `${id} must be wired`);
  }
  for (const provider of ["all", "codex", "openlux", "surplus"]) {
    assert.match(adminHtml, new RegExp(`data-model-provider="${provider}"`));
  }

  assert.match(adminScript, /checkbox\.type = "checkbox"/);
  assert.match(adminScript, /dataset\.modelToggle/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/models\/catalog"\), \{/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/models\/whitelist"\), \{/);
  assert.match(adminScript, /if \(modelsHasUnsavedChanges\(\) && options\.force !== true\)/);

  // Bulk tools have to say whether they act on the whole catalog or the filtered view.
  assert.match(
    adminScript,
    /modelsCheckAllBtn\.textContent = scoped[\s\S]{0,80}`Check \$\{formatNumber\(visibleCount\)\} shown`[\s\S]{0,60}`Check all \$\{formatNumber\(visibleCount\)\}`/
  );
  assert.match(
    adminScript,
    /modelsUncheckAllBtn\.textContent = scoped[\s\S]{0,80}`Uncheck \$\{formatNumber\(visibleCount\)\} shown`[\s\S]{0,60}`Uncheck all \$\{formatNumber\(visibleCount\)\}`/
  );
  // Identifiers the catalog dropped must be removable instead of pinning the filter on.
  assert.match(adminScript, /const modelsMissingIds = \(\) => \{/);
  assert.match(adminScript, /modelsMissingWarning\(\)/);

  // The legacy rule has to stay visible: an empty selection is a cleared filter.
  assert.match(adminHtml, /Saving an empty selection removes the filter/);
  assert.match(adminScript, /No models checked: the filter is off/);
});
