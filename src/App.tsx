import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Tabs } from "@mantine/core";
import { AppModeSelector } from "./components/AppModeSelector";
import { LiveControlView } from "./components/LiveControlView";
import { ProjectSelector } from "./components/ProjectSelector";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { SettingsModal } from "./components/SettingsModal";
import { TitleBar } from "./components/TitleBar";
import { UpdateAvailableModal } from "./components/UpdateAvailableModal";
import { getPreference, setPreference } from "./lib/preferences";
import type { Project } from "./lib/bindings";

type AppMode = "modeSelect" | "liveControl" | "projectDesign";

function App() {
  const [version, setVersion] = useState("");
  const [mode, setMode] = useState<AppMode>("modeSelect");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  /** Owned here (not inside ProjectWorkspace) so the tab selector can live in
   * the title bar instead of its own row — saves vertical space. */
  const [workspaceTab, setWorkspaceTab] = useState<string | null>("workspace");

  useEffect(() => {
    setWorkspaceTab("workspace");
  }, [selectedProject?.id]);

  useEffect(() => {
    getVersion().then(setVersion);

    if (import.meta.env.DEV || !getPreference("autoUpdateChecks")) {
      return;
    }

    check()
      .then((update) => {
        if (update) {
          setPendingUpdate(update);
        }
      })
      .catch((e) => console.error("Update check failed", e));
  }, []);

  async function handleInstallUpdate() {
    if (!pendingUpdate) return;
    setInstallingUpdate(true);
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (e) {
      console.error("Update install failed", e);
      setInstallingUpdate(false);
    }
  }

  function handleDisableUpdateChecks() {
    setPreference("autoUpdateChecks", false);
    setPendingUpdate(null);
  }

  function handleBackToStart() {
    setSelectedProject(null);
    setMode("modeSelect");
  }

  const windowTitle = selectedProject
    ? `AmpCore ${version} - ${selectedProject.name}`.trim()
    : `AmpCore ${version}`.trim();

  useEffect(() => {
    // Kept for the OS taskbar / Alt-Tab switcher — the native titlebar
    // itself is hidden (decorations: false), replaced by <TitleBar />.
    getCurrentWindow().setTitle(windowTitle);
  }, [windowTitle]);

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden">
      <TitleBar
        title={windowTitle}
        projectName={selectedProject?.name}
        onCloseProject={handleBackToStart}
        onBackToStart={!selectedProject && mode !== "modeSelect" ? handleBackToStart : undefined}
        onOpenSettings={() => setSettingsOpen(true)}
        centerContent={
          mode === "projectDesign" && selectedProject ? (
            <Tabs value={workspaceTab} onChange={setWorkspaceTab} variant="pills" radius="sm">
              <Tabs.List>
                <Tabs.Tab value="workspace">Workspace</Tabs.Tab>
                <Tabs.Tab value="operator">Operator View</Tabs.Tab>
              </Tabs.List>
            </Tabs>
          ) : undefined
        }
      />
      <div className="min-h-0 min-w-0 flex-1">
        {mode === "modeSelect" && (
          <AppModeSelector
            onSelectLiveControl={() => setMode("liveControl")}
            onSelectProjectDesign={() => setMode("projectDesign")}
          />
        )}
        {mode === "liveControl" && <LiveControlView />}
        {mode === "projectDesign" &&
          (!selectedProject ? (
            <ProjectSelector onSelect={setSelectedProject} />
          ) : (
            <ProjectWorkspace
              project={selectedProject}
              onProjectUpdate={setSelectedProject}
              activeTab={workspaceTab}
              onActiveTabChange={setWorkspaceTab}
            />
          ))}
      </div>
      <SettingsModal opened={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UpdateAvailableModal
        update={pendingUpdate}
        installing={installingUpdate}
        onInstall={handleInstallUpdate}
        onAbort={() => setPendingUpdate(null)}
        onDisable={handleDisableUpdateChecks}
      />
    </div>
  );
}

export default App;
