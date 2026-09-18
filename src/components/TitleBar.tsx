import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Dropdown, Popover } from "@heroui/react";
import { Copy, Minus, Palette, Square, X } from "lucide-react";
import { useIsTight } from "../lib/breakpoints";
import { AppearanceControls } from "./AppearanceControls";

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
}

export function TitleBar({
  title,
  projectName,
  onCloseProject,
  onBackToStart,
  onOpenSettings,
  centerContent,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
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
        <Popover>
          <Button isIconOnly variant="ghost" size="sm" aria-label="Appearance">
            <Palette size={16} />
          </Button>
          <Popover.Content placement="bottom end">
            <Popover.Dialog className="w-[280px]">
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
