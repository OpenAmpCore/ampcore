import { useEffect, useState } from "react";

/** Minimal `useMediaQuery`, replacing `@mantine/hooks`' version — returns
 * `false` on the very first render (before the listener attaches) and the
 * live match state after, same contract the callers below already coerce
 * `?? false` against. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [query]);

  return matches;
}

/** App-wide layout breakpoints. Deliberately *window*-relative (media
 * queries), not element-relative: every consumer is reacting to "the whole
 * app window got small" — a restored-down desktop window, a snapped half
 * screen, or a tablet — rather than to its own box shrinking.
 *
 * `compact` is the main one: below it, side rails collapse into inline
 * pickers and multi-pane pages stack vertically. `tight` is the second
 * step, for layouts that still don't fit once stacked (phone-ish widths and
 * the modals that go full-screen there). `short` covers vertical squeeze —
 * a wide-but-short window still needs scrolling panes rather than
 * vertically-centered ones.
 *
 * `useMediaQuery` returns `undefined` on the very first render (before the
 * listener attaches); every hook here coerces that to `false` so the
 * desktop layout is what renders first and narrow layouts only ever appear
 * after a real match — never a flash of the wrong one at full size. */
export const COMPACT_MAX_WIDTH = 900;
export const TIGHT_MAX_WIDTH = 640;
export const SHORT_MAX_HEIGHT = 620;

export function useIsCompact(): boolean {
  return useMediaQuery(`(max-width: ${COMPACT_MAX_WIDTH}px)`) ?? false;
}

export function useIsTight(): boolean {
  return useMediaQuery(`(max-width: ${TIGHT_MAX_WIDTH}px)`) ?? false;
}

export function useIsShort(): boolean {
  return useMediaQuery(`(max-height: ${SHORT_MAX_HEIGHT}px)`) ?? false;
}
