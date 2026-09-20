import { useSyncExternalStore } from "react";

/** Local UI preferences — not app/project data, just browser-side toggles,
 * so `localStorage` is enough (no Rust-backed storage needed).
 *
 * Reads go through a tiny subscribable store rather than a bare getter
 * because these are consumed *live*: flipping "Show Fingerprint Menu" in
 * the settings modal has to make the icon appear in an amp editor that is
 * already mounted elsewhere in the tree. A plain `localStorage.getItem`
 * call can't do that — nothing would re-render. */

export type PreferenceKey =
  | "autoUpdateChecks"
  | "showFingerprintMenu"
  | "showRawTelemetry";

/** Kept verbatim from before the store rewrite for `autoUpdateChecks`, so a
 * user who had already turned update checks off stays opted out. */
const STORAGE_KEYS: Record<PreferenceKey, string> = {
  autoUpdateChecks: "ampcore.autoUpdateChecksEnabled",
  showFingerprintMenu: "ampcore.showFingerprintMenu",
  showRawTelemetry: "ampcore.showRawTelemetry",
};

/** Update checks are on unless opted out; the two Amp Edit surfaces are
 * developer-facing and stay hidden until asked for. */
const DEFAULTS: Record<PreferenceKey, boolean> = {
  autoUpdateChecks: true,
  showFingerprintMenu: false,
  showRawTelemetry: false,
};

const listeners = new Set<() => void>();

/** Cached so `getSnapshot` returns a referentially stable value per key —
 * `useSyncExternalStore` re-reads on every render and would loop if the
 * snapshot changed identity. Booleans are primitives so this is really just
 * about avoiding a `localStorage` hit per render. */
const cache = new Map<PreferenceKey, boolean>();

function read(key: PreferenceKey): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS[key]);
  } catch {
    // Private mode / blocked site data — fall through to the default.
  }
  return raw === null ? DEFAULTS[key] : raw === "true";
}

export function getPreference(key: PreferenceKey): boolean {
  let value = cache.get(key);
  if (value === undefined) {
    value = read(key);
    cache.set(key, value);
  }
  return value;
}

export function setPreference(key: PreferenceKey, value: boolean): void {
  cache.set(key, value);
  try {
    localStorage.setItem(STORAGE_KEYS[key], String(value));
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
export function usePreference(key: PreferenceKey): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getPreference(key),
    () => DEFAULTS[key],
  );
}
