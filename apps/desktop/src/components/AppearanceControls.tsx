import { Button, ButtonGroup, ColorSlider } from "@heroui/react";
import { parseColor } from "react-aria-components";
import { ACCENT_LIGHTNESS, ACCENT_SATURATION, RADII, useAppearance, type ColorScheme } from "../lib/appearance";

/** A label over its control, the control taking the full width — side by
 * side, a narrow menu wrapped some rows and pushed others past its edge. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[var(--amp-color-dimmed)]" style={{ fontSize: "var(--amp-font-size-sm)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

const MODES: { id: ColorScheme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "auto", label: "System" },
];

/** The app's three appearance knobs (`src/lib/appearance.ts`), in the title bar's appearance menu. */
export function AppearanceControls() {
  const { colorScheme, accentHue, radiusId, setColorScheme, setAccent, setRadius } = useAppearance();

  return (
    <div className="flex flex-col gap-4">
      <Row label="Color mode">
        <ButtonGroup size="sm" className="w-full">
          {MODES.map(({ id, label }) => (
            <Button
              key={id}
              className="flex-1"
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
          className="w-full"
          value={parseColor(`hsl(${accentHue}, ${ACCENT_SATURATION}%, ${ACCENT_LIGHTNESS}%)`)}
          onChange={(color) => setAccent(color.getChannelValue("hue"))}
        >
          <ColorSlider.Track>
            <ColorSlider.Thumb />
          </ColorSlider.Track>
        </ColorSlider>
      </Row>

      <Row label="Corner radius">
        <ButtonGroup size="sm" className="w-full">
          {RADII.map((radius) => (
            <Button
              key={radius.id}
              className="flex-1"
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
