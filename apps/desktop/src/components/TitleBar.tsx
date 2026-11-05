import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Dropdown, Popover, Spinner } from "@heroui/react";
import { ArrowDownToLine, Bug, Check, Copy, Minus, Palette, Square, X } from "lucide-react";
import { useIsTight } from "../lib/breakpoints";
import { AppearanceControls } from "./AppearanceControls";
import { BugReportModal } from "./BugReportModal";
import { Hint } from "./Hint";

const appWindow = getCurrentWindow();

interface TitleBarProps {
  title: string;
  projectName?: string;
  onCloseProject?: () => void;
  onBackToStart?: () => void;
  onOpenSettings: () => void;
  /** Rendered centered in the title bar — e.g. the Workspace/Operator
   * View tabs when a project is open, saving the vertical space a
   * separate tab-bar row would otherwise cost. */
  centerContent?: ReactNode;
  /** An update found at startup: shown as a button whether or not its dialog
   * was dismissed or is turned off. */
  update?: { version: string; installing: boolean; onInstall: () => void };
}

/** Once to arm (checkmark), again within this to install and restart. */
const UPDATE_ARM_MS = 5000;

/** The title bar's update button: green, since an update is good news and
 * the accent is the user's. The first press only arms it, so a stray click
 * never restarts the app. */
function UpdateButton({ version, installing, onInstall }: NonNullable<TitleBarProps["update"]>) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const text = installing
    ? "Installing update…"
    : armed
      ? "Click again to install — AmpCore restarts"
      : `Update to ${version} available`;
  return (
    <Hint text={text}>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        aria-label={text}
        isDisabled={installing}
        onPress={() => {
          clearTimeout(timer.current);
          if (armed) return onInstall();
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), UPDATE_ARM_MS);
        }}
      >
        {installing ? (
          <Spinner size="sm" />
        ) : armed ? (
          <Check size={16} color="var(--amp-color-green-6)" />
        ) : (
          <ArrowDownToLine size={16} color="var(--amp-color-green-6)" />
        )}
      </Button>
    </Hint>
  );
}

export function TitleBar({
  title,
  projectName,
  onCloseProject,
  onBackToStart,
  onOpenSettings,
  centerContent,
  update,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const tight = useIsTight();

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="grid h-9 select-none grid-cols-[1fr_auto_1fr] items-center border-b border-b-[light-dark(var(--amp-color-gray-2),var(--amp-color-dark-6))] px-[var(--amp-spacing-xs)]"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <Dropdown>
          <Dropdown.Trigger className="rounded-md border-0 bg-transparent px-2 py-1 text-sm text-[var(--amp-color-dimmed)] hover:bg-[var(--amp-color-gray-light)]">
            File
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu className="min-w-[180px]">
              <Dropdown.Section>
                <Dropdown.Item id="settings" onAction={onOpenSettings}>
                  Open App Settings
                </Dropdown.Item>
              </Dropdown.Section>
              {projectName && onCloseProject && (
                <Dropdown.Section>
                  <Dropdown.Item id="exit-project" onAction={onCloseProject}>
                    Exit Project
                  </Dropdown.Item>
                </Dropdown.Section>
              )}
              {onBackToStart && (
                <Dropdown.Section>
                  <Dropdown.Item id="back-to-start" onAction={onBackToStart}>
                    Back to Start
                  </Dropdown.Item>
                </Dropdown.Section>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {/* Below `useIsTight` the File menu, the centered tabs and the three
            window buttons already fill the bar, so the title (also shown in
            the OS taskbar) is the one thing that gives up its space. Driven
            by the shared breakpoint rather than Tailwind's own `sm:`, which
            happened to match today but could drift from it silently. */}
        {!tight && (
          <span
            data-tauri-drag-region
            className="min-w-0 flex-1 truncate"
            style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 500 }}
          >
            {title}
          </span>
        )}
      </div>

      <div data-tauri-drag-region className="flex min-w-0 items-center justify-center gap-1">
        {centerContent}
      </div>

      <div data-tauri-drag-region className="flex items-center justify-end gap-1">
        {/* Appearance sits left of the window buttons: it's app chrome, not an
            OS control, and keeping it out of that group avoids a mis-click on
            Close. The same controls also live in Settings → Appearance. */}
        {update && <UpdateButton {...update} />}
        <Hint text="Report a bug">
          <Button isIconOnly variant="ghost" size="sm" aria-label="Report a bug" onPress={() => setBugReportOpen(true)}>
            <Bug size={16} />
          </Button>
        </Hint>
        <BugReportModal isOpen={bugReportOpen} onClose={() => setBugReportOpen(false)} />
        <Popover>
          <Button isIconOnly variant="ghost" size="sm" aria-label="Appearance">
            <Palette size={16} />
          </Button>
          <Popover.Content placement="bottom end">
            <Popover.Dialog className="w-[320px]">
              <AppearanceControls />
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <Minus size={16} />
        </Button>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={() => appWindow.toggleMaximize()}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </Button>
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          className="hover:!bg-[var(--amp-color-red-light)] hover:!text-[var(--amp-color-red-6)]"
          onPress={() => appWindow.close()}
          aria-label="Close"
        >
          <X size={16} />
        </Button>
      </div>
    </div>
  );
}
