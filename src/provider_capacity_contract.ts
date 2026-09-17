/**
 * Shared provider-capacity storage keys. Keeping the key outside the sampler
 * avoids a routing-to-sampler import cycle while allowing routing to reconcile
 * snapshots written by an earlier sampler run.
 */
export const PROVIDER_CAPACITY_SNAPSHOT_KEY = ["uos_ai", "provider_capacity", "v1", "snapshot"] as const;

/**
 * Width of one capacity-history bucket: also the debounce for event-driven
 * sampling, so the first observation in a bucket samples and later ones do not.
 */
export const PROVIDER_CAPACITY_HISTORY_BUCKET_MS = 15 * 60_000;
