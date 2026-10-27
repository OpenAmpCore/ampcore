import { useRef, type ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";
import { RefreshCw } from "lucide-react";

/** WKWebView (macOS) reports "Macintosh"; WebView2 (Windows) and WebKitGTK don't. */
const IS_MAC = /Macintosh/.test(navigator.userAgent);

/** Where discovery is most likely being blocked. On macOS 15+ that is Local
 * Network privacy, not the firewall: until AmpCore is allowed there, every
 * broadcast `send_to` fails — and the driver ignores send errors, so the
 * only symptom is an empty list. On Windows it is the firewall prompt. */
const NETWORK_HINT = IS_MAC
  ? "Make sure this Mac is on the same network as the amps, and that AmpCore is allowed in System Settings › Privacy & Security › Local Network."
  : "Make sure this computer is on the same network as the amps, and that your firewall lets AmpCore through.";

/** A discovery empty state from start to finish: the caller's `scanning`
 * content while `useScanTimeout` waits, then a "nothing found" message with
 * a Scan again button. Discovery itself never stops, so an amp that turns up
 * at any point replaces this whole component.
 *
 * Both states render through one component so that two things survive the
 * swap between them:
 * - The `role="status"` region. A live region is only announced when its
 *   *content* changes; one inserted already filled often isn't. So it stays
 *   mounted for the whole empty state and holds text only — the button sits
 *   outside it, or its label would be read as part of the message, and the
 *   spinner is `aria-hidden` because HeroUI's is a live region of its own.
 * - Keyboard focus. Scan again removes its own button, so the press first
 *   moves focus to this component's root, which outlives it — otherwise
 *   focus drops to the document body (or the dialog's first control). */
export function ScanStatus({
  timedOut,
  scanning,
  spinner,
  title = "No amps found",
  hint = NETWORK_HINT,
  onScanAgain,
}: {
  timedOut: boolean;
  /** Shown, and announced, while still waiting. */
  scanning: ReactNode;
  spinner?: boolean;
  title?: string;
  hint?: string;
  onScanAgain: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} tabIndex={-1} className="flex flex-col items-center gap-2 p-3 text-center outline-none">
      {spinner && !timedOut && (
        <span aria-hidden="true" className="flex">
          <Spinner size="sm" />
        </span>
      )}
      <div role="status" className="flex flex-col items-center gap-2">
        {timedOut ? (
          <>
            <span style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)" }}>{title}</span>
            <span className="max-w-[300px]" style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-xs)" }}>
              {hint}
            </span>
          </>
        ) : (
          scanning
        )}
      </div>
      {timedOut && (
        <Button
          size="sm"
          variant="secondary"
          onPress={() => {
            root.current?.focus();
            onScanAgain();
          }}
        >
          <RefreshCw size={14} /> Scan again
        </Button>
      )}
    </div>
  );
}
