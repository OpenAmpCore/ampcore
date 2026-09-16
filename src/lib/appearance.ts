import { useSyncExternalStore } from "react";

/**
 * The app's three appearance knobs, all of which HeroUI exposes as plain CSS
 * custom properties on `:root`: `data-theme` for the colour scheme, `--accent`
 * (+ `--accent-foreground`) for the primary colour, and `--radius` for corner
 * rounding. HeroUI derives everything else itself — `--accent-hover` and the
 * `--accent-soft*` family via `color-mix`, and the whole `--radius-xs..4xl`
 * scale via `calc()` — so these are the only properties we ever write.
 *
 * Deliberately *not* HeroUI's own `useTheme()` hook: it persists under a
 * different key (`heroui-theme`), says "system" where this app says "auto",
 * and sets a `.dark` class in addition to the attribute, so it would fight
 * both this module and the pre-paint script in `index.html`.
 *
 * Kept in sync by hand with that pre-paint script, which reads the same three
 * keys before first paint so none of the three flashes its default on launch.
 */

export type ColorScheme = "light" | "dark" | "auto";

const SCHEME_KEY = "ampcore-color-scheme";
const ACCENT_KEY = "ampcore-accent";
const RADIUS_KEY = "ampcore-radius";

export interface AccentOption {
  id: string;
  label: string;
  /** Written to `--accent`. */
  value: string;
  /** Written to `--accent-foreground` — text/icons drawn on top of `value`. */
  foreground: string;
}

/** `blue` is HeroUI's own stock accent and the app default. `amber` is the
 * colour the app used before the HeroUI migration, kept so that look stays
 * reachable. */
export const ACCENTS: AccentOption[] = [
  { id: "blue", label: "Blue", value: "oklch(0.6204 0.195 253.83)", foreground: "var(--snow)" },
  { id: "violet", label: "Violet", value: "oklch(0.606 0.216 292.7)", foreground: "var(--snow)" },
  { id: "teal", label: "Teal", value: "oklch(0.6 0.118 184.7)", foreground: "var(--snow)" },
  { id: "green", label: "Green", value: "oklch(0.627 0.165 149.2)", foreground: "var(--snow)" },
  { id: "amber", label: "Amber", value: "oklch(0.606 0.117 66.3)", foreground: "var(--snow)" },
  { id: "rose", label: "Rose", value: "oklch(0.616 0.212 12.9)", foreground: "var(--snow)" },
];

export interface RadiusOption {
  id: string;
  label: string;
  /** Written to `--radius`; HeroUI derives the named steps from it. */
  value: string;
}

export const RADII: RadiusOption[] = [
  { id: "square", label: "Square", value: "0rem" },
  { id: "small", label: "Small", value: "0.25rem" },
  { id: "default", label: "Default", value: "0.5rem" },
  { id: "large", label: "Large", value: "0.875rem" },
];

export const DEFAULT_ACCENT_ID = "blue";
export const DEFAULT_RADIUS_ID = "default";

export interface Appearance {
  colorScheme: ColorScheme;
  accentId: string;
  radiusId: string;
}

function read(): Appearance {
  let scheme: ColorScheme = "auto";
  let accentId = DEFAULT_ACCENT_ID;
  let radiusId = DEFAULT_RADIUS_ID;
  try {
    const s = localStorage.getItem(SCHEME_KEY);
    if (s === "light" || s === "dark" || s === "auto") scheme = s;
    const a = localStorage.getItem(ACCENT_KEY);
    if (a && ACCENTS.some((o) => o.id === a)) accentId = a;
    const r = localStorage.getItem(RADIUS_KEY);
    if (r && RADII.some((o) => o.id === r)) radiusId = r;
  } catch {
    // Private mode / blocked site data — fall through to the defaults.
  }
  return { colorScheme: scheme, accentId, radiusId };
}

let current = read();

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveScheme(scheme: ColorScheme): "light" | "dark" {
  return scheme === "auto" ? (prefersDark() ? "dark" : "light") : scheme;
}

/** Writes the three knobs onto `<html>`. `data-theme` is what both HeroUI's
 * `dark:` variant and `design-tokens.css`'s per-scheme blocks key off. */
export function applyAppearance(next: Appearance = current) {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveScheme(next.colorScheme));

  const accent = ACCENTS.find((o) => o.id === next.accentId) ?? ACCENTS[0];
  root.style.setProperty("--accent", accent.value);
  root.style.setProperty("--accent-foreground", accent.foreground);

  const radius = RADII.find((o) => o.id === next.radiusId) ?? RADII[2];
  root.style.setProperty("--radius", radius.value);
}

function persist(next: Appearance) {
  try {
    localStorage.setItem(SCHEME_KEY, next.colorScheme);
    localStorage.setItem(ACCENT_KEY, next.accentId);
    localStorage.setItem(RADIUS_KEY, next.radiusId);
  } catch {
    // Storage unavailable: the change still applies for this session.
  }
}

function update(patch: Partial<Appearance>) {
  current = { ...current, ...patch };
  persist(current);
  applyAppearance(current);
  emit();
}

export const setColorScheme = (colorScheme: ColorScheme) => update({ colorScheme });
export const setAccent = (accentId: string) => update({ accentId });
export const setRadius = (radiusId: string) => update({ radiusId });

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// While "auto", follow live OS theme changes rather than only resolving once
// at selection time. Registered at module scope rather than in an effect so a
// change lands even when no component is currently reading the store.
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (current.colorScheme === "auto") applyAppearance();
  });
}

export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, () => current, () => current);
  return { ...appearance, setColorScheme, setAccent, setRadius };
}
