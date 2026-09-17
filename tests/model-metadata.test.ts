import assert from "node:assert/strict";

import { CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT } from "../src/recent_model_context.ts";
import {
  CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS,
  CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS,
  codexSubscriptionMetadataHint,
} from "../src/model_metadata.ts";
import { codexSnapshotMetadataHint, resolveModelMetadata } from "../src/model_metadata.ts";
import type { OpenRouterModelMetadata } from "../src/openrouter_models.ts";

const enrichment = (overrides: Partial<OpenRouterModelMetadata> = {}): OpenRouterModelMetadata => ({
  id: "openai/gpt-5.6-sol",
  context_window_tokens: 1_050_000,
  max_context_window_tokens: 1_050_000,
  reasoning: { supported_efforts: ["max", "high", "medium"], default_effort: "medium", mandatory: false },
  ...overrides,
});

Deno.test("an id no source describes resolves to unknown instead of a curated guess", () => {
  // These ids were previously answered by the curated tables, which are now
  // disabled: with no source, the honest answer is "nothing is known".
  for (const id of ["glm-5.3", "claude-sonnet-5", "deepseek-v4-pro", "gpt-5.6-terra"]) {
    const resolved = resolveModelMetadata(id, { openRouter: null });
    assert.equal(resolved.context_window_tokens, null, id);
    assert.equal(resolved.max_context_window_tokens, null, id);
    assert.equal(resolved.auto_compact_token_limit_tokens, null, id);
    assert.equal(resolved.effective_context_window_percent, null, id);
    assert.equal(resolved.supported_reasoning_levels, null, id);
    assert.equal(resolved.default_reasoning_effort, null, id);
    assert.equal(resolved.context_source, "unknown", id);
    assert.equal(resolved.reasoning_source, "unknown", id);
  }
});

Deno.test("the uploaded Codex catalog outranks every other source", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: {
      context_window_tokens: 272_000,
      max_context_window_tokens: 400_000,
      supported_reasoning_levels: ["low", "high"],
      default_reasoning_effort: "high",
    },
    provider: { context_window_tokens: 1_000_000, supported_reasoning_levels: ["none"] },
    openRouter: enrichment(),
  });
  assert.equal(resolved.context_window_tokens, 272_000);
  assert.equal(resolved.max_context_window_tokens, 400_000);
  assert.equal(resolved.context_source, "codex_upload");
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "low", "high"]);
  assert.equal(resolved.default_reasoning_effort, "high");
  assert.equal(resolved.reasoning_source, "codex_upload");
});

Deno.test("a serving provider's own declaration outranks enrichment", () => {
  const resolved = resolveModelMetadata("deepseek-flash", {
    provider: { context_window_tokens: 1_000_000, max_context_window_tokens: 1_000_000 },
    openRouter: enrichment({ id: "~deepseek/deepseek-flash-latest", context_window_tokens: 65_536, max_context_window_tokens: 65_536 }),
  });
  assert.equal(resolved.context_window_tokens, 1_000_000);
  assert.equal(resolved.context_source, "provider_discovery");
  // Reasoning was not declared by the provider, so enrichment supplies it.
  assert.equal(resolved.reasoning_source, "openrouter");
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "max", "high", "medium"]);
});

Deno.test("enrichment is the last resort, and the resolved context derives the auto-compact limit", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", { openRouter: enrichment() });
  assert.equal(resolved.context_window_tokens, 1_050_000);
  assert.equal(resolved.max_context_window_tokens, 1_050_000);
  assert.equal(resolved.auto_compact_token_limit_tokens, 892_500);
  assert.equal(resolved.context_source, "openrouter");
  assert.equal(resolved.effective_context_window_percent, CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT);
  assert.equal(resolved.default_reasoning_effort, "medium");
});

Deno.test("a declared auto-compact limit inside the resolved window is preserved", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 272_000, auto_compact_token_limit_tokens: 200_000 },
    openRouter: enrichment(),
  });
  assert.equal(resolved.context_window_tokens, 272_000);
  assert.equal(resolved.auto_compact_token_limit_tokens, 200_000);
});

Deno.test("the Codex subscription bound outranks enrichment for a Codex-served id", () => {
  // OpenRouter publishes the API-level maximum; a subscription serves less, so
  // the conservative bound has to win when the upload states no window.
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: { supported_reasoning_levels: ["low", "high"] },
    codexSubscription: codexSubscriptionMetadataHint(),
    openRouter: enrichment({ context_window_tokens: 1_050_000, max_context_window_tokens: 1_050_000 }),
  });
  assert.equal(resolved.context_window_tokens, CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS);
  assert.equal(resolved.max_context_window_tokens, CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS);
  assert.equal(resolved.auto_compact_token_limit_tokens, 222_000);
  assert.equal(resolved.context_source, "codex_subscription");
  // Tiers still come from the upload, which is authoritative for them.
  assert.equal(resolved.reasoning_source, "codex_upload");
});

Deno.test("an uploaded Codex window beats the subscription bound", () => {
  const resolved = resolveModelMetadata("gpt-5.6-sol", {
    codex: { context_window_tokens: 400_000, max_context_window_tokens: 400_000 },
    codexSubscription: codexSubscriptionMetadataHint(),
    openRouter: enrichment(),
  });
  assert.equal(resolved.context_window_tokens, 400_000);
  assert.equal(resolved.context_source, "codex_upload");
});

Deno.test("ids Codex does not serve keep their provider or enrichment window", () => {
  const resolved = resolveModelMetadata("glm-5.3", {
    openRouter: enrichment({ id: "z-ai/glm-5.3", context_window_tokens: 1_310_720, max_context_window_tokens: 1_310_720 }),
  });
  assert.equal(resolved.context_window_tokens, 1_310_720);
  assert.equal(resolved.context_source, "openrouter");
});

Deno.test("a mandatory-reasoning model does not gain a none tier it does not advertise", () => {
  const resolved = resolveModelMetadata("glm-5.3", {
    openRouter: enrichment({
      id: "z-ai/glm-5.3",
      reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "max", mandatory: true },
    }),
  });
  assert.deepEqual(resolved.supported_reasoning_levels, ["max", "high", "low"]);
  assert.equal(resolved.default_reasoning_effort, "max");
});

Deno.test("every advertised tier survives, including ones the gateway does not know", () => {
  const resolved = resolveModelMetadata("qwen3.8", {
    openRouter: enrichment({
      id: "qwen/qwen3.8",
      reasoning: { supported_efforts: ["none", "thinking", "hyper"], default_effort: "thinking", mandatory: false },
    }),
  });
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "thinking", "hyper"]);
});

Deno.test("the Codex snapshot adapter maps explicit null defaults to none", () => {
  assert.deepEqual(codexSnapshotMetadataHint(null), null);
  const hint = codexSnapshotMetadataHint({
    context_window: 400_000,
    auto_compact_token_limit: null,
    supported_reasoning_levels: [null, "low", { effort: "high" }, { effort: "" }],
    default_reasoning_level: null,
  });
  assert.ok(hint, "the adapter returns a hint for a real record");
  assert.equal(hint.context_window_tokens, 400_000);
  assert.equal(hint.auto_compact_token_limit_tokens, null);
  assert.equal(hint.default_reasoning_effort, "none");
  const resolved = resolveModelMetadata("any-model", { codex: hint, openRouter: null });
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "low", "high"]);
  assert.equal(resolved.default_reasoning_effort, "none");
  assert.equal(resolved.context_source, "codex_upload");
});

Deno.test("a Codex record without an explicit default keeps no default effort", () => {
  const hint = codexSnapshotMetadataHint({ context_window: 100_000, supported_reasoning_levels: ["low", "high"] });
  assert.ok(hint, "the adapter returns a hint for a real record");
  assert.equal(hint.default_reasoning_effort, undefined);
  const resolved = resolveModelMetadata("any-model", { codex: hint, openRouter: null });
  assert.equal(resolved.default_reasoning_effort, null);
  assert.deepEqual(resolved.supported_reasoning_levels, ["none", "low", "high"]);
});
