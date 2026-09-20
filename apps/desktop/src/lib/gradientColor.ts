/** Sampling a CSS gradient stop list in JS, and deriving a more vivid
 * version of it — used by `VuMeter` to color its peak indicator as a
 * saturated version of whatever part of the level gradient the line is
 * currently riding over, so it reads as the same color intensified rather
 * than as a foreign one.
 *
 * Stop syntax matches what `VuMeter` hands to `linear-gradient`: `"#rgb"` or
 * `"#rrggbb"`, optionally followed by a percentage (`"#d4c94a 65%"`). Stops
 * with no percentage are distributed evenly, the same as CSS does.
 */

export type Rgb = readonly [r: number, g: number, b: number];

interface GradientStop {
  color: Rgb;
  /** 0–1 along the gradient. */
  position: number;
}

function parseHex(hex: string): Rgb | null {
  const body = hex.trim().replace(/^#/, "");
  if (body.length === 3) {
    const [r, g, b] = [...body].map((c) => parseInt(c + c, 16));
    return Number.isNaN(r + g + b) ? null : [r, g, b];
  }
  if (body.length === 6) {
    const n = parseInt(body, 16);
    return Number.isNaN(n) ? null : [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  return null;
}

/** Parses `VuMeter`'s gradient prop into positioned stops, sorted by
 * position. Returns `[]` if nothing parsed, so callers fall back rather than
 * render a broken color. Worth memoizing per gradient — the stop list is
 * fixed while the sample position changes every frame. */
export function parseGradientStops(gradient: string[]): GradientStop[] {
  const parsed = gradient.flatMap((entry, i) => {
    const [hex, percent] = entry.trim().split(/\s+/);
    const color = parseHex(hex);
    if (!color) return [];
    const position =
      percent === undefined
        ? gradient.length > 1
          ? i / (gradient.length - 1)
          : 0
        : parseFloat(percent) / 100;
    return Number.isFinite(position) ? [{ color, position }] : [];
  });
  return parsed.sort((a, b) => a.position - b.position);
}

/** The gradient's color at `fraction` (0–1), linearly interpolated between
 * the surrounding stops and clamped to the end stops outside the range —
 * i.e. what the browser paints there. Interpolation is in plain sRGB, which
 * is what `linear-gradient` itself does by default, so the sampled color
 * actually matches the pixels on screen rather than being a "more correct"
 * color the meter never shows. */
export function sampleGradient(stops: GradientStop[], fraction: number): Rgb | null {
  if (stops.length === 0) return null;
  if (fraction <= stops[0].position) return stops[0].color;
  const last = stops[stops.length - 1];
  if (fraction >= last.position) return last.color;

  for (let i = 1; i < stops.length; i++) {
    const end = stops[i];
    if (fraction > end.position) continue;
    const start = stops[i - 1];
    const span = end.position - start.position;
    const t = span <= 0 ? 0 : (fraction - start.position) / span;
    return [
      start.color[0] + (end.color[0] - start.color[0]) * t,
      start.color[1] + (end.color[1] - start.color[1]) * t,
      start.color[2] + (end.color[2] - start.color[2]) * t,
    ];
  }
  return last.color;
}

function rgbToHsl([r, g, b]: Rgb): [h: number, s: number, l: number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hueToChannel(p: number, q: number, t: number): number {
  const tt = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToCss(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return `rgb(${v}, ${v}, ${v})`;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hueToChannel(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToChannel(p, q, h) * 255);
  const b = Math.round(hueToChannel(p, q, h - 1 / 3) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** How much more saturated the peak line is than the gradient under it. */
const VIBRANCY_MULTIPLIER = 2;

/** `rgb` with its vibrancy doubled: the same hue and the same lightness,
 * with saturation multiplied by `VIBRANCY_MULTIPLIER` and clamped at fully
 * saturated. The line reads as an intensified version of the ramp it's
 * riding along rather than as a separate color.
 *
 * Saturation is boosted in HSL specifically so hue and lightness come
 * through untouched — scaling the RGB channels instead would drag lightness
 * along with it and shift the hue of any non-primary color.
 *
 * A fully desaturated stop stays grey: doubling zero saturation is still
 * zero. That's correct for "more vibrant" and worth knowing before using
 * this on a greyscale gradient, where it would be a no-op. */
export function vibrantColor(rgb: Rgb): string {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToCss(h, Math.min(1, s * VIBRANCY_MULTIPLIER), l);
}
