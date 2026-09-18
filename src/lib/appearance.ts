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

/** Accent is a single hue (0-359, HSL) picked on a `ColorSlider`; saturation
 * and lightness are pinned so every hue lands as a soft pastel rather than a
 * fully saturated colour — a vibrant `hsl(h, 65%, 50%)` reads as brand-colour
 * loud on buttons/focus rings; this reads as a tint. Because the fixed
 * lightness is high, `--accent-foreground` is a fixed dark ink rather than
 * the white text a vibrant mid-lightness accent could carry — see
 * `ACCENT_FOREGROUND` below. */
export const ACCENT_SATURATION = 65;
export const ACCENT_LIGHTNESS = 80;

/** Dark, theme-independent ink — legible on every pastel hue in both colour
 * schemes, unlike the white text the old vibrant swatches used. */
export const ACCENT_FOREGROUND = "oklch(0.32 0 0)";

export function accentColorForHue(hue: number): string {
  return `hsl(${hue} ${ACCENT_SATURATION}% ${ACCENT_LIGHTNESS}%)`;
}

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

/** A blue-ish hue, roughly matching HeroUI's own stock accent hue. */
export const DEFAULT_ACCENT_HUE = 217;
export const DEFAULT_RADIUS_ID = "default";

export interface Appearance {
  colorScheme: ColorScheme;
  /** Degrees, 0-359. */
  accentHue: number;
  radiusId: string;
}

function read(): Appearance {
  let scheme: ColorScheme = "auto";
  let accentHue = DEFAULT_ACCENT_HUE;
  let radiusId = DEFAULT_RADIUS_ID;
  try {
    const s = localStorage.getItem(SCHEME_KEY);
    if (s === "light" || s === "dark" || s === "auto") scheme = s;
    // Numeric parse rejects the old preset-id strings ("blue", "violet", …)
    // from before the hue slider, falling back to the default hue for them.
    // `stored` is checked for null first — `Number(null)` is 0, a valid hue,
    // which would otherwise turn "nothing saved yet" into "red".
    const stored = localStorage.getItem(ACCENT_KEY);
    const a = stored === null ? NaN : Number(stored);
    if (Number.isFinite(a) && a >= 0 && a < 360) accentHue = a;
    const r = localStorage.getItem(RADIUS_KEY);
    if (r && RADII.some((o) => o.id === r)) radiusId = r;
  } catch {
    // Private mode / blocked site data — fall through to the defaults.
  }
  return { colorScheme: scheme, accentHue, radiusId };
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
  // index.html's pre-paint script bridges the page background inline until
  // the stylesheet loads; from here on `html { background: var(--background) }`
  // owns it and must be free to follow theme switches.
  root.style.removeProperty("background");

  root.style.setProperty("--accent", accentColorForHue(next.accentHue));
  root.style.setProperty("--accent-foreground", ACCENT_FOREGROUND);

  const radius = RADII.find((o) => o.id === next.radiusId) ?? RADII[2];
  root.style.setProperty("--radius", radius.value);
}

function persist(next: Appearance) {
  try {
    localStorage.setItem(SCHEME_KEY, next.colorScheme);
    localStorage.setItem(ACCENT_KEY, String(next.accentHue));
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
export const setAccent = (accentHue: number) => update({ accentHue });
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
