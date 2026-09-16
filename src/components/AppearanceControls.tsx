import { Button, ButtonGroup } from "@heroui/react";
import { ACCENTS, RADII, useAppearance, type ColorScheme } from "../lib/appearance";

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
  const { colorScheme, accentId, radiusId, setColorScheme, setAccent, setRadius } = useAppearance();

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
        <div className="flex flex-wrap items-center gap-1.5">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              aria-label={accent.label}
              aria-pressed={accentId === accent.id}
              title={accent.label}
              onClick={() => setAccent(accent.id)}
              // The swatch shows its own colour, so it can't also use the
              // accent for its selected ring — that would be invisible on the
              // selected swatch itself. `--foreground` keeps it legible in
              // both schemes.
              className={`size-5 cursor-pointer rounded-full border-0 p-0 outline-none ring-offset-2 ring-offset-[var(--overlay)] focus-visible:ring-2 focus-visible:ring-[var(--foreground)] ${
                accentId === accent.id ? "ring-2 ring-[var(--foreground)]" : ""
              }`}
              style={{ background: accent.value }}
            />
          ))}
        </div>
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
