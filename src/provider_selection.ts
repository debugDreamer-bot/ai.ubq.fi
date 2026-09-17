import { getKv } from "./kv.ts";
import { getString, isRecord } from "./utils.ts";

// ── KV key ───────────────────────────────────────────────────────────────────

export const PROVIDER_SELECTION_KV_KEY = ["uos_ai", "provider_selection", "v1"] as const;

/** Routing reads this control on the hot path, so a short cache bounds KV reads. */
export const PROVIDER_SELECTION_CACHE_TTL_MS = 5_000;

// ── Provider roster ──────────────────────────────────────────────────────────

/**
 * The provider vocabulary the model catalog already publishes, in the order the
 * inference waterfall tries it: the Codex subscription tier first, then the two
 * paid fallback tiers (`surplus` before `openlux`), then the credential-gated
 * direct routes.
 */
export const SELECTABLE_PROVIDER_IDS = ["codex", "surplus", "openlux", "deepseek", "cerebras"] as const;

export type SelectableProviderId = (typeof SELECTABLE_PROVIDER_IDS)[number];

export type ProviderSelection = Readonly<{
  provider_ids: readonly SelectableProviderId[];
  updated_at_ms: number;
}>;

const selectableProviderIdSet = new Set<string>(SELECTABLE_PROVIDER_IDS);

/** Last selection served to the routing path, with the write path priming it. */
let cachedSelection: Readonly<{ value: ProviderSelection | null; expires_at_ms: number }> | null = null;
let selectionLoadInFlight: Promise<ProviderSelection | null> | null = null;

export const isSelectableProviderId = (value: unknown): value is SelectableProviderId => typeof value === "string" && selectableProviderIdSet.has(value.trim());

// ── Normalize / validate ─────────────────────────────────────────────────────

/**
 * Canonical form of a submitted provider list: known ids only, de-duplicated,
 * always in roster order. Storage and the wire response both use this form, so
 * re-saving an already-normalized selection is a no-op.
 */
export const normalizeSelectedProviderIds = (rawIds: readonly unknown[]): SelectableProviderId[] => {
  const submitted = new Set<string>();
  for (const raw of rawIds) {
    const id = getString(raw)?.trim();
    if (id && selectableProviderIdSet.has(id)) submitted.add(id);
  }
  return SELECTABLE_PROVIDER_IDS.filter((id) => submitted.has(id));
};

/**
 * Read a stored selection. Ids that are no longer on the roster are dropped
 * rather than voiding the whole selection, so retiring a provider cannot
 * silently switch every other provider back on.
 */
export const normalizeProviderSelection = (value: unknown): ProviderSelection | null => {
  if (!isRecord(value)) return null;
  const rawIds = value.provider_ids;
  if (!Array.isArray(rawIds)) return null;
  if (rawIds.some((raw) => getString(raw) === null)) return null;
  const updatedAtMs = value.updated_at_ms;
  if (typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) return null;
  return { provider_ids: normalizeSelectedProviderIds(rawIds), updated_at_ms: updatedAtMs };
};

// ── KV helpers ───────────────────────────────────────────────────────────────

export const loadProviderSelection = async (kv: Deno.Kv | null): Promise<ProviderSelection | null> => {
  if (!kv) return null;
  const entry = await kv.get(PROVIDER_SELECTION_KV_KEY, { consistency: "strong" });
  return normalizeProviderSelection(entry.value);
};

/**
 * Persist a selection and prime the routing cache with exactly what was
 * written, so an operator sees the effect of a save on the next request
 * instead of waiting out the cache TTL. Returns `null` when KV rejected it.
 */
export const storeProviderSelection = async (kv: Deno.Kv, providerIds: readonly SelectableProviderId[]): Promise<ProviderSelection | null> => {
  const selection: ProviderSelection = { provider_ids: normalizeSelectedProviderIds(providerIds), updated_at_ms: Date.now() };
  try {
    await kv.set(PROVIDER_SELECTION_KV_KEY, selection);
  } catch {
    return null;
  }
  cachedSelection = { value: selection, expires_at_ms: selection.updated_at_ms + PROVIDER_SELECTION_CACHE_TTL_MS };
  return selection;
};

// ── Enforcement ──────────────────────────────────────────────────────────────

/**
 * An empty or absent selection is no filter at all: every provider stays
 * eligible. That matches the model whitelist contract and keeps an accidental
 * (or stale) empty selection from disabling inference.
 */
export const isProviderEnabled = (provider: SelectableProviderId, selection: ProviderSelection | null): boolean =>
  selection === null || selection.provider_ids.length === 0 || selection.provider_ids.includes(provider);

export const providerSelectionIsActive = (selection: ProviderSelection | null): boolean => selection !== null && selection.provider_ids.length > 0;

/**
 * Keep only the entries an enabled provider serves, narrowing each row to the
 * providers that are still active. An entry no enabled provider serves is
 * dropped, so a disabled provider can never be advertised or dispatched to.
 */
export const filterCatalogEntriesByProviderSelection = <T extends Readonly<{ providers: readonly Readonly<{ id: string }>[] }>>(
  entries: readonly T[],
  selection: ProviderSelection | null
): T[] => {
  if (!selection || selection.provider_ids.length === 0) return [...entries];
  const enabled = new Set<string>(selection.provider_ids);
  const filtered: T[] = [];
  for (const entry of entries) {
    const providers = entry.providers.filter((provider) => enabled.has(provider.id));
    if (!providers.length) continue;
    filtered.push(providers.length === entry.providers.length ? entry : { ...entry, providers });
  }
  return filtered;
};

// ── Cached routing read ──────────────────────────────────────────────────────

/**
 * The routing path reads the selection through this cache. A failed read keeps
 * the last known selection and, with nothing cached, fails open: an operator
 * control must never turn a KV hiccup into a routing outage.
 */
export const loadProviderSelectionCached = async (nowMs = Date.now()): Promise<ProviderSelection | null> => {
  if (cachedSelection && cachedSelection.expires_at_ms > nowMs) return cachedSelection.value;
  if (selectionLoadInFlight) return await selectionLoadInFlight;
  const stale = cachedSelection?.value ?? null;
  selectionLoadInFlight = (async () => {
    try {
      const value = await loadProviderSelection(await getKv());
      cachedSelection = { value, expires_at_ms: nowMs + PROVIDER_SELECTION_CACHE_TTL_MS };
      return value;
    } catch {
      return stale;
    } finally {
      selectionLoadInFlight = null;
    }
  })();
  return await selectionLoadInFlight;
};

export const resetProviderSelectionCacheForTest = (): void => {
  cachedSelection = null;
  selectionLoadInFlight = null;
};
