import { useSyncExternalStore } from "react";

/** List-valued sibling to `preferences.ts` — same rationale (local UI
 * toggles, live-reactive, `localStorage`-backed), but for a preference whose
 * value is "which of a few named surfaces", not a plain on/off. Kept as a
 * separate module rather than folding into `preferences.ts` because that
 * store's whole shape (`Record<PreferenceKey, boolean>`) is boolean-only. */

export type ListPreferenceKey = "peakHoldSurfaces" | "limiterThresholdSurfaces";

const STORAGE_KEYS: Record<ListPreferenceKey, string> = {
  peakHoldSurfaces: "ampcore.peakHoldSurfaces",
  limiterThresholdSurfaces: "ampcore.limiterThresholdSurfaces",
};

/** Chosen to match the behavior every meter had before either setting
 * existed — peak hold was unconditional everywhere, and the limiter
 * threshold lines were on for the Output tab (the only surface with a
 * toggle) and unconditional on the Limiter tab (which had none). */
const DEFAULTS: Record<ListPreferenceKey, string[]> = {
  peakHoldSurfaces: ["input", "output", "limiter"],
  limiterThresholdSurfaces: ["output", "limiter"],
};

const listeners = new Set<() => void>();

/** Cached for the same reason as `preferences.ts`'s `cache`: stable identity
 * per key so `useSyncExternalStore` doesn't loop, and to avoid a
 * `localStorage` + JSON.parse hit on every render. */
const cache = new Map<ListPreferenceKey, string[]>();

function read(key: ListPreferenceKey): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[key]);
    if (raw === null) return DEFAULTS[key];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
  } catch {
    // Private mode / blocked site data / corrupt JSON — fall through.
  }
  return DEFAULTS[key];
}

export function getListPreference(key: ListPreferenceKey): string[] {
  let value = cache.get(key);
  if (value === undefined) {
    value = read(key);
    cache.set(key, value);
  }
  return value;
}

export function setListPreference(key: ListPreferenceKey, values: string[]): void {
  cache.set(key, values);
  try {
    localStorage.setItem(STORAGE_KEYS[key], JSON.stringify(values));
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
export function useListPreference(key: ListPreferenceKey): string[] {
  return useSyncExternalStore(
    subscribe,
    () => getListPreference(key),
    () => DEFAULTS[key],
  );
}
