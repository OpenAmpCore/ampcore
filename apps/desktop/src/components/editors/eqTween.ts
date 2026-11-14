import { useEffect, useRef, useState } from "react";
import type { ChannelEq, CrossoverSlot, EqBand } from "../../lib/bindings";
import { responseCurve } from "../../lib/eqResponse";
import type { EqStageRef, ResponsePoint } from "../../lib/filterResponse";
import { CURVE_POINTS, stageKey, stagesOf } from "./eqStages";

const EASE_MS = 300;

type Stage = EqBand | CrossoverSlot;

/** One stage on its way: from what was on screen to the new value, its
 * presence (share of the curve, point opacity) from `p0` to 1 or 0. */
type Anim = { from: Stage; p0: number; to: Stage; start: number };

/** The chain as drawn: a stage still fading counts as on, and `weights` (its
 * presence 0..1, by `stageKey`) is set while anything is easing. */
export type EqTween = { eq: ChannelEq; weights: Record<string, number> | null };

function stageOf(eq: ChannelEq, ref: EqStageRef): Stage {
  return ref.kind === "band" ? eq.bands[ref.bandIndex] : eq[ref.kind];
}

function withStage(eq: ChannelEq, ref: EqStageRef, stage: Stage): ChannelEq {
  if (ref.kind !== "band") return { ...eq, [ref.kind]: stage };
  const bands = eq.bands.slice();
  bands[ref.bandIndex] = stage as EqBand;
  return { ...eq, bands };
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

const logLerp = (a: number | null, b: number | null, t: number) => (a && b && a > 0 && b > 0 ? a * (b / a) ** t : b);

/** Freq and Q on a log scale, gain linearly; a filter type change jumps. */
function lerpStage(a: Stage, b: Stage, t: number): Stage {
  if (a.filterType !== b.filterType) return b;
  const out = { ...b, freqHz: logLerp(a.freqHz, b.freqHz, t) };
  if ("q" in a && "q" in b) {
    const band = out as EqBand;
    band.q = logLerp(a.q, b.q, t);
    band.gainDb = a.gainDb != null && b.gainDb != null ? a.gainDb + (b.gainDb - a.gainDb) * t : b.gainDb;
  }
  return out;
}

/** Where `anim` is at `now`: the stage drawn (on while present) and its presence. */
function sample(anim: Anim, now: number): { stage: Stage; p: number; done: boolean } {
  const raw = Math.min(1, (now - anim.start) / EASE_MS);
  const t = easeOut(raw);
  const p = anim.p0 + ((anim.to.active ? 1 : 0) - anim.p0) * t;
  // A stage coming on has no old shape worth easing from.
  const params = anim.p0 === 0 ? anim.to : lerpStage(anim.from, anim.to, t);
  return { stage: { ...params, active: p > 0 }, p, done: raw >= 1 };
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** `target` eased in over `EASE_MS` whenever it changes: each changed stage
 * slides from where it is drawn now, and a stage switched off or on fades its
 * share of the curve. `instant` (a drag, a nudge, the release after one) jumps. */
export function useEqTween(target: ChannelEq, instant: boolean): EqTween {
  const anims = useRef(new Map<string, Anim>());
  const prev = useRef(target);
  const [, setFrame] = useState(0);
  const now = performance.now();

  if (target !== prev.current) {
    const old = prev.current;
    prev.current = target;
    if (instant || reducedMotion() || old.bands.length !== target.bands.length) anims.current.clear();
    else {
      for (const ref of stagesOf(target)) {
        const key = stageKey(ref);
        const to = stageOf(target, ref);
        const was = stageOf(old, ref);
        if (JSON.stringify(was) === JSON.stringify(to)) continue;
        const running = anims.current.get(key);
        const shown = running ? sample(running, now) : { stage: was, p: was.active ? 1 : 0 };
        anims.current.set(key, { from: shown.stage, p0: shown.p, to, start: now });
      }
    }
  }

  useEffect(() => {
    if (anims.current.size === 0) return;
    const id = requestAnimationFrame(() => setFrame((n) => n + 1));
    return () => cancelAnimationFrame(id);
  });

  if (anims.current.size === 0) return { eq: target, weights: null };
  let eq = target;
  const weights: Record<string, number> = {};
  for (const [key, anim] of anims.current) {
    const { stage, p, done } = sample(anim, now);
    if (done) anims.current.delete(key);
    const ref = stagesOf(target).find((r) => stageKey(r) === key);
    if (!ref) continue;
    eq = withStage(eq, ref, stage);
    weights[key] = p;
  }
  // The last frame is the target itself, so nothing schedules another.
  return anims.current.size === 0 ? { eq: target, weights: null } : { eq, weights };
}

/** The whole chain's curve, each stage's share scaled by its presence: a
 * cascade sums dB, so a fading stage fades out of the total exactly. */
export function totalCurve(eq: ChannelEq, weights: Record<string, number> | null): ResponsePoint[] {
  if (!weights) return responseCurve(eq, null, CURVE_POINTS);
  const total = responseCurve(eq, null, CURVE_POINTS).map((p) => ({ ...p, db: 0 }));
  for (const ref of stagesOf(eq)) {
    const w = weights[stageKey(ref)] ?? 1;
    if (w === 0) continue;
    responseCurve(eq, ref, CURVE_POINTS).forEach((p, i) => (total[i].db += w * p.db));
  }
  return total;
}
