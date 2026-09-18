import { AlertDialog, Button } from "@heroui/react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { resolveScheme, useAppearance } from "../lib/appearance";

export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shown beneath the description, e.g. a wiring diagram. Paths under
   * `public/` — separate light/dark assets since these are line art drawn
   * for one background, not something `--foreground` can recolour. */
  image?: { light: string; dark: string };
  /** `danger` for destructive/irreversible actions (red icon + red button);
   * `warning` for consequential but recoverable ones. Fixed status colours,
   * never the user's accent — a warning must still read as one. */
  tone?: "warning" | "danger";
}

/** The app's one "are you sure?" dialog. Built on HeroUI's `AlertDialog`,
 * which requires an explicit choice — outside clicks and Escape don't
 * dismiss it by default.
 *
 * Usage: `const { confirm, dialog } = useConfirm();` render `{dialog}` once,
 * then `if (await confirm({ title, description })) doTheThing();`. */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    // A second request while one is open answers the first as "no".
    resolveRef.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const dialog = <ConfirmDialog options={options} onSettle={settle} />;
  return { confirm, dialog };
}

function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions | null;
  onSettle: (ok: boolean) => void;
}) {
  // Kept after close so the content doesn't blank out during the exit
  // animation.
  const lastOptions = useRef<ConfirmOptions | null>(null);
  if (options) lastOptions.current = options;
  const shown = options ?? lastOptions.current;
  const tone = shown?.tone ?? "warning";
  const { colorScheme } = useAppearance();
  const isDark = resolveScheme(colorScheme) === "dark";

  return (
    <AlertDialog.Backdrop isOpen={options !== null} onOpenChange={(open) => !open && onSettle(false)}>
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status={tone} />
            <AlertDialog.Heading>{shown?.title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="flex flex-col gap-3">
              <div style={{ fontSize: "var(--amp-font-size-sm)" }}>{shown?.description}</div>
              {shown?.image && (
                <img
                  src={isDark ? shown.image.dark : shown.image.light}
                  alt=""
                  className="mx-auto max-w-[200px] rounded-md object-contain"
                />
              )}
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="ghost" onPress={() => onSettle(false)}>
              {shown?.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant={tone === "danger" ? "danger" : "primary"} onPress={() => onSettle(true)}>
              {shown?.confirmLabel ?? "Confirm"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
