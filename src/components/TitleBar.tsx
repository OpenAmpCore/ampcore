import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ActionIcon, Button, Group, Menu, Text } from "@mantine/core";
import { Copy, Minus, Square, X } from "lucide-react";
import { useIsTight } from "../lib/breakpoints";

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
      className="grid h-9 select-none grid-cols-[1fr_auto_1fr] items-center border-b border-b-[light-dark(var(--mantine-color-gray-2),var(--mantine-color-dark-6))] px-[var(--mantine-spacing-xs)]"
    >
      <Group data-tauri-drag-region gap="xs" wrap="nowrap" className="min-w-0">
        <Menu shadow="md" width={180} position="bottom-start">
          <Menu.Target>
            <Button variant="subtle" color="gray" size="compact-sm">
              File
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={onOpenSettings}>Open App Settings</Menu.Item>
            {projectName && onCloseProject && (
              <>
                <Menu.Divider />
                <Menu.Item onClick={onCloseProject}>Exit Project</Menu.Item>
              </>
            )}
            {onBackToStart && (
              <>
                <Menu.Divider />
                <Menu.Item onClick={onBackToStart}>Back to Start</Menu.Item>
              </>
            )}
          </Menu.Dropdown>
        </Menu>
        {/* Below `useIsTight` the File menu, the centered tabs and the three
            window buttons already fill the bar, so the title (also shown in
            the OS taskbar) is the one thing that gives up its space. Driven
            by the shared breakpoint rather than Tailwind's own `sm:`, which
            happened to match today but could drift from it silently. */}
        {!tight && (
          <Text data-tauri-drag-region size="sm" fw={500} truncate className="min-w-0 flex-1">
            {title}
          </Text>
        )}
      </Group>

      <Group data-tauri-drag-region gap={4} wrap="nowrap" justify="center" className="min-w-0">
        {centerContent}
      </Group>

      <Group data-tauri-drag-region gap={4} wrap="nowrap" justify="flex-end">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          <Minus size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={() => appWindow.toggleMaximize()}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          <X size={16} />
        </ActionIcon>
      </Group>
    </div>
  );
}
