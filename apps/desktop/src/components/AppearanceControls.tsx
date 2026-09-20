import { Button, ButtonGroup, ColorSlider } from "@heroui/react";
import { parseColor } from "react-aria-components";
import { ACCENT_LIGHTNESS, ACCENT_SATURATION, RADII, useAppearance, type ColorScheme } from "../lib/appearance";

/** One label + control row, matching `SettingsModal`'s row shape so these
 * read identically whether they appear in the title-bar menu or the modal. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span style={{ fontSize: "var(--amp-font-size-sm)" }}>{label}</span>
      {children}
    </div>
  );
}

const MODES: { id: ColorScheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "auto", label: "System" },
];

/** The app's three appearance knobs. Shared by `SettingsModal` and the title
 * bar's appearance menu rather than duplicated, since both surface the same
 * store (`src/lib/appearance.ts`) and must stay in step when one is changed
 * while the other is open. */
export function AppearanceControls() {
  const { colorScheme, accentHue, radiusId, setColorScheme, setAccent, setRadius } = useAppearance();

  return (
    <div className="flex flex-col gap-3">
      <Row label="Color mode">
        <ButtonGroup size="sm">
          {MODES.map(({ id, label }) => (
            <Button
              key={id}
              variant={colorScheme === id ? "primary" : "ghost"}
              onPress={() => setColorScheme(id)}
            >
              {label}
            </Button>
          ))}
        </ButtonGroup>
      </Row>

      <Row label="Accent color">
        {/* Saturation/lightness are pinned (see `ACCENT_SATURATION`/
            `ACCENT_LIGHTNESS`) so this only ever picks a hue — every position
            on the track is a pastel tint, never a fully saturated colour. */}
        <ColorSlider
          aria-label="Accent color"
          channel="hue"
          colorSpace="hsl"
          className="w-36"
          value={parseColor(`hsl(${accentHue}, ${ACCENT_SATURATION}%, ${ACCENT_LIGHTNESS}%)`)}
          onChange={(color) => setAccent(color.getChannelValue("hue"))}
        >
          <ColorSlider.Track>
            <ColorSlider.Thumb />
          </ColorSlider.Track>
        </ColorSlider>
      </Row>

      <Row label="Corner radius">
        <ButtonGroup size="sm">
          {RADII.map((radius) => (
            <Button
              key={radius.id}
              variant={radiusId === radius.id ? "primary" : "ghost"}
              onPress={() => setRadius(radius.id)}
            >
              {radius.label}
            </Button>
          ))}
        </ButtonGroup>
      </Row>
    </div>
  );
}
