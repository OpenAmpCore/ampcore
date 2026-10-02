import { useSyncExternalStore } from "react";

/** Local UI preferences — not app/project data, just browser-side toggles,
 * so `localStorage` is enough (no Rust-backed storage needed).
 *
 * Reads go through a tiny subscribable store rather than a bare getter
 * because these are consumed *live*: flipping "Show Fingerprint Menu" in
 * the settings modal has to make the icon appear in an amp editor that is
 * already mounted elsewhere in the tree. A plain `localStorage.getItem`
 * call can't do that — nothing would re-render.
 *
 * Values are stored as JSON, which reads the pre-existing `"true"`/`"false"`
 * boolean entries unchanged. */

const DEFAULTS = {
  /** On unless opted out. */
  autoUpdateChecks: true,
  /** The two Amp Edit surfaces are developer-facing and stay hidden until asked for. */
  showFingerprintMenu: false,
  showRawTelemetry: false,
  /** Debug: the apply confirm shows a now/preset/written diff of every value. */
  showSpeakerComparator: false,
  /** Which meter surfaces get peak hold / limiter threshold lines. Chosen to
   * match the behavior every meter had before either setting existed — peak
   * hold was unconditional everywhere, and the limiter threshold lines were
   * on for the Output tab and unconditional on the Limiter tab. */
  peakHoldSurfaces: ["input", "output", "limiter"] as string[],
  limiterThresholdSurfaces: ["output", "limiter"] as string[],
};

type Preferences = typeof DEFAULTS;
type PreferenceKey = keyof Preferences;

/** Kept verbatim from before the store rewrite, so a user who had already
 * turned update checks off stays opted out. Every other key is `ampcore.<key>`. */
const LEGACY_STORAGE_KEYS: Partial<Record<PreferenceKey, string>> = {
  autoUpdateChecks: "ampcore.autoUpdateChecksEnabled",
};

const listeners = new Set<() => void>();

/** Cached so `getSnapshot` returns a referentially stable value per key —
 * `useSyncExternalStore` re-reads on every render and would loop if the
 * snapshot changed identity (the list values are fresh arrays per parse). */
const cache = new Map<PreferenceKey, unknown>();

function storageKey(key: PreferenceKey): string {
  return LEGACY_STORAGE_KEYS[key] ?? `ampcore.${key}`;
}

function read<K extends PreferenceKey>(key: K): Preferences[K] {
  const fallback = DEFAULTS[key];
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    const valid = Array.isArray(fallback)
      ? Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
      : typeof parsed === typeof fallback;
    if (valid) return parsed as Preferences[K];
  } catch {
    // Private mode / blocked site data / corrupt JSON — fall through.
  }
  return fallback;
}

export function getPreference<K extends PreferenceKey>(key: K): Preferences[K] {
  if (!cache.has(key)) cache.set(key, read(key));
  return cache.get(key) as Preferences[K];
}

export function setPreference<K extends PreferenceKey>(key: K, value: Preferences[K]): void {
  cache.set(key, value);
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Can't persist, but the in-memory value still drives this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive read — the component re-renders when the preference changes,
 * wherever in the tree it was changed from. */
export function usePreference<K extends PreferenceKey>(key: K): Preferences[K] {
  return useSyncExternalStore(
    subscribe,
    () => getPreference(key),
    () => DEFAULTS[key],
  );
}
