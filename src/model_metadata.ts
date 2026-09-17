import { normalizeReasoningEffort, type ReasoningEffort } from "./defaults.ts";
import { openRouterMetadataFor, type OpenRouterModelMetadata } from "./openrouter_models.ts";
import { CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT, resolvedAutoCompactTokenLimit } from "./recent_model_context.ts";

/**
 * One place resolves what the gateway knows about a model, from the sources that
 * actually know it, in this order:
 *
 * 1. `codex_upload` — the Codex client's uploaded catalog. Authoritative for
 *    every id it lists, including the reasoning tier strings the gateway must
 *    preserve verbatim.
 * 2. `provider_discovery` — the provider that serves the id, as discovered from
 *    its own `/v1/models` response.
 * 3. `openrouter` — the third-party public catalog, for ids the first two are
 *    silent about.
 *
 * The curated per-model tables this replaced are commented out in
 * `src/recent_model_context.ts`. Nothing here invents a value: an id no source
 * describes resolves to nulls and reports `unknown`, so a gap shows up as a gap
 * instead of as a plausible-looking wrong number. Derivation is still allowed and
 * is labeled as such — the auto-compaction limit is computed from a known
 * context window by the shared 85%-or-50k-reserve rule, which is arithmetic, not
 * per-model knowledge.
 */
export type ModelMetadataSource = "codex_upload" | "provider_discovery" | "openrouter" | "unknown";

/**
 * What a single source claims about a model, in upstream vocabulary: Codex
 * snapshot records use `context_window`/`default_reasoning_level`, and callers
 * adapt those before handing them over.
 */
export type ModelMetadataHint = Readonly<{
  context_window_tokens?: number | null;
  max_context_window_tokens?: number | null;
  auto_compact_token_limit_tokens?: number | null;
  effective_context_window_percent?: number | null;
  supported_reasoning_levels?: readonly unknown[] | null;
  default_reasoning_effort?: unknown;
  /** True when the source states reasoning cannot be disabled, such as OpenRouter's `mandatory`. */
  reasoning_mandatory?: boolean;
}>;

export type ResolvedModelMetadata = Readonly<{
  context_window_tokens: number | null;
  max_context_window_tokens: number | null;
  auto_compact_token_limit_tokens: number | null;
  effective_context_window_percent: number | null;
  supported_reasoning_levels: readonly ReasoningEffort[] | null;
  default_reasoning_effort: ReasoningEffort | null;
  context_source: ModelMetadataSource;
  reasoning_source: ModelMetadataSource;
}>;

export type ModelMetadataSources = Readonly<{
  codex?: ModelMetadataHint | null;
  provider?: ModelMetadataHint | null;
  openRouter?: OpenRouterModelMetadata | null;
}>;

const positiveTokenCount = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

const firstTokenCount = (...values: readonly unknown[]): number | null => {
  for (const value of values) {
    const resolved = positiveTokenCount(value);
    if (resolved !== null) return resolved;
  }
  return null;
};

/**
 * Advertised tiers arrive as bare strings, `null` (an explicit no-reasoning
 * entry), or `{ effort }` objects. Every non-empty advertised tier is preserved
 * in its advertised order: the gateway has no tier allowlist to enforce.
 */
const advertisedReasoningLevels = (levels: readonly unknown[] | null | undefined): ReasoningEffort[] => {
  if (!Array.isArray(levels)) return [];
  const resolved: ReasoningEffort[] = [];
  for (const entry of levels) {
    const raw = entry !== null && typeof entry === "object" && "effort" in entry ? (entry as { effort?: unknown }).effort : entry;
    const level = raw === null ? "none" : normalizeReasoningEffort(raw);
    if (level && !resolved.includes(level)) resolved.push(level);
  }
  return resolved;
};

const openRouterHint = (metadata: OpenRouterModelMetadata): ModelMetadataHint => ({
  context_window_tokens: metadata.context_window_tokens,
  max_context_window_tokens: metadata.max_context_window_tokens,
  supported_reasoning_levels: metadata.reasoning?.supported_efforts ?? null,
  default_reasoning_effort: metadata.reasoning?.default_effort ?? null,
  reasoning_mandatory: metadata.reasoning?.mandatory ?? false,
});

/**
 * `none` is the gateway's one reasoning special case: it is offered whenever a
 * source advertises any tier and does not declare reasoning mandatory, so a
 * client can always ask for no reasoning on a model that allows it.
 */
const withNoneAndDefault = (
  advertised: readonly ReasoningEffort[],
  defaultLevel: ReasoningEffort | null,
  mandatory: boolean
): { levels: readonly ReasoningEffort[]; defaultLevel: ReasoningEffort | null } => {
  if (!advertised.length) return { levels: [], defaultLevel };
  const levels = !mandatory && !advertised.includes("none") ? ["none", ...advertised] : [...advertised];
  return { levels: defaultLevel && !levels.includes(defaultLevel) ? [...levels, defaultLevel] : levels, defaultLevel };
};

/**
 * Adapt a Codex snapshot record to a hint. The uploaded catalog publishes
 * `context_window`, `max_context_window`, `auto_compact_token_limit` and
 * `effective_context_window_percent` as plain numbers, a
 * `supported_reasoning_levels` array whose entries are bare strings, `null`, or
 * `{ effort }` objects, and a `default_reasoning_level` whose explicit `null`
 * means `none`.
 */
export const codexSnapshotMetadataHint = (record: Record<string, unknown> | null | undefined): ModelMetadataHint | null => {
  if (!record) return null;
  const explicitNoneDefault = Object.prototype.hasOwnProperty.call(record, "default_reasoning_level") && record.default_reasoning_level === null;
  return {
    context_window_tokens: positiveTokenCount(record.context_window),
    max_context_window_tokens: positiveTokenCount(record.max_context_window),
    auto_compact_token_limit_tokens: positiveTokenCount(record.auto_compact_token_limit),
    effective_context_window_percent: positiveTokenCount(record.effective_context_window_percent),
    supported_reasoning_levels: Array.isArray(record.supported_reasoning_levels) ? record.supported_reasoning_levels : null,
    default_reasoning_effort: explicitNoneDefault ? "none" : record.default_reasoning_level,
  };
};

/** True when a source published either context window, in either spelling. */
const statesContext = (hint: ModelMetadataHint | null): boolean =>
  hint !== null && (positiveTokenCount(hint.context_window_tokens) !== null || positiveTokenCount(hint.max_context_window_tokens) !== null);

const contextSourceOf = (codex: ModelMetadataHint | null, provider: ModelMetadataHint | null, enrichment: ModelMetadataHint | null): ModelMetadataSource => {
  if (statesContext(codex)) return "codex_upload";
  if (statesContext(provider)) return "provider_discovery";
  if (statesContext(enrichment)) return "openrouter";
  return "unknown";
};

/** The wider of a declared maximum and the active window it has to contain. */
const containingWindow = (contextWindow: number | null, declaredMaxWindow: number | null): number | null => {
  if (contextWindow === null) return declaredMaxWindow;
  if (declaredMaxWindow === null) return contextWindow;
  return Math.max(contextWindow, declaredMaxWindow);
};

type ReasoningResolution = Readonly<{
  levels: readonly ReasoningEffort[];
  defaultLevel: ReasoningEffort | null;
  source: ModelMetadataSource;
}>;

/** First source, in precedence order, that advertises at least one tier. */
const reasoningFrom = (codex: ModelMetadataHint | null, provider: ModelMetadataHint | null, enrichment: ModelMetadataHint | null): ReasoningResolution => {
  const candidates: readonly (readonly [ModelMetadataSource, ModelMetadataHint | null])[] = [
    ["codex_upload", codex],
    ["provider_discovery", provider],
    ["openrouter", enrichment],
  ];
  for (const [source, hint] of candidates) {
    const resolved = withNoneAndDefault(
      advertisedReasoningLevels(hint?.supported_reasoning_levels),
      normalizeReasoningEffort(hint?.default_reasoning_effort),
      hint?.reasoning_mandatory === true
    );
    if (resolved.levels.length) return { ...resolved, source };
  }
  return { levels: [], defaultLevel: null, source: "unknown" };
};

export const resolveModelMetadata = (modelId: string, sources: ModelMetadataSources = {}): ResolvedModelMetadata => {
  const openRouter = sources.openRouter === undefined ? openRouterMetadataFor(modelId) : sources.openRouter;
  const codex = sources.codex ?? null;
  const provider = sources.provider ?? null;
  const enrichment = openRouter ? openRouterHint(openRouter) : null;

  const contextWindow = firstTokenCount(codex?.context_window_tokens, provider?.context_window_tokens, enrichment?.context_window_tokens);
  const declaredMaxWindow = firstTokenCount(codex?.max_context_window_tokens, provider?.max_context_window_tokens, enrichment?.max_context_window_tokens);
  const declaredAutoCompact = firstTokenCount(codex?.auto_compact_token_limit_tokens, provider?.auto_compact_token_limit_tokens);
  const declaredPercent = codex?.effective_context_window_percent ?? provider?.effective_context_window_percent;
  const reasoning = reasoningFrom(codex, provider, enrichment);

  return {
    context_window_tokens: contextWindow,
    max_context_window_tokens: containingWindow(contextWindow, declaredMaxWindow),
    auto_compact_token_limit_tokens: contextWindow === null ? declaredAutoCompact : resolvedAutoCompactTokenLimit(contextWindow, declaredAutoCompact),
    effective_context_window_percent: positiveTokenCount(declaredPercent) ?? (contextWindow === null ? null : CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT),
    supported_reasoning_levels: reasoning.levels.length ? reasoning.levels : null,
    default_reasoning_effort: reasoning.defaultLevel,
    context_source: contextSourceOf(codex, provider, enrichment),
    reasoning_source: reasoning.source,
  };
};
