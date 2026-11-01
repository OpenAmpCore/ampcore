import type { ReactNode } from "react";

/* The amp editor's rail and amp controls, drawn to show the hardware rather
 * than a metaphor: straight lines and square ends, like a schematic. Same
 * `size` prop as lucide, so they swap in directly. Drawn for 24px: a 2px stroke
 * on whole coordinates lands on the pixel grid, so keep new geometry on it and
 * leave out anything too small to survive at that size. */

const icon = (body: ReactNode) =>
  function HardwareIcon({ size = 24 }: { size?: number }) {
    return (
      <svg
        // Inline, not attributes: HeroUI's `.button svg` rule forces 16px otherwise.
        style={{ width: size, height: size }}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        aria-hidden="true"
      >
        {body}
      </svg>
    );
  };

/** Rack amp front panel: mounting holes and channel meters. */
export const RackPanelIcon = icon(
  <>
    <rect x="2" y="6" width="20" height="12" />
    <path d="M9 15v-4M12 15V9M15 15v-3" />
    <g fill="currentColor" stroke="none">
      <rect x="4" y="8" width="2" height="2" />
      <rect x="4" y="14" width="2" height="2" />
      <rect x="18" y="8" width="2" height="2" />
      <rect x="18" y="14" width="2" height="2" />
    </g>
  </>,
);

/** Schematic amplifier: input, triangle, output. */
export const AmplifierIcon = icon(<path d="M1 12h6M7 5v14l12-7zM19 12h4" />);

/** Crosspoint matrix: crossing lines with the connected points filled. */
export const CrosspointMatrixIcon = icon(
  <>
    <path d="M2 5h20M2 12h20M2 19h20M5 2v20M12 2v20M19 2v20" />
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="5" r="3.5" />
      <circle cx="19" cy="12" r="3.5" />
      <circle cx="12" cy="19" r="3.5" />
    </g>
  </>,
);

/** Speaker cabinet front: tweeter above woofer. */
export const CabinetIcon = icon(
  <>
    <rect x="5" y="2" width="14" height="20" />
    <circle cx="12" cy="7" r="2" />
    <circle cx="12" cy="15" r="4" />
  </>,
);

/** Memory slots, the active one filled. */
export const MemorySlotsIcon = icon(
  <>
    <rect x="3" y="3" width="18" height="4" />
    <rect x="3" y="10" width="18" height="4" fill="currentColor" />
    <rect x="3" y="17" width="18" height="4" />
  </>,
);

/** Two faders with their caps joined, moving as one. */
export const GangedFadersIcon = icon(
  <>
    <path d="M7 2v20M17 2v20M10 12h4" />
    <g fill="currentColor" stroke="none">
      <rect x="4" y="9" width="6" height="6" />
      <rect x="14" y="9" width="6" height="6" />
    </g>
  </>,
);

const knob = (
  <>
    <circle cx="10" cy="14" r="7" />
    <path d="M10 14V9" />
    <rect x="17" y="5" width="6" height="5" fill="currentColor" stroke="none" />
  </>
);

/** Front-panel rotary encoder with a closed padlock. */
export const KnobLockedIcon = icon(
  <>
    {knob}
    <path strokeWidth="1.5" d="M18.5 5V3a1.5 1.5 0 0 1 3 0v2" />
  </>,
);

/** Front-panel rotary encoder with an open padlock. */
export const KnobUnlockedIcon = icon(
  <>
    {knob}
    <path strokeWidth="1.5" d="M18.5 5V3a1.5 1.5 0 0 1 3 0" />
  </>,
);

/** IEC 60417-5010, power on/off: running. */
export const PowerOnIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10" />
  </>,
);

/** IEC 60417-5009, standby. */
export const StandbyIcon = icon(<path d="M12 2v10M6.5 5.5a9 9 0 1 0 11 0" />);
