import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AmpEditLock, type DeviceChannelConfig } from "../lib/bindings";

/** Edit-lock state for one project amp (`projects_amp_edit_lock`). Re-resolves
 * when the project changes, when the linked amp's FC=27 settings arrive, and
 * when the linked amp appears/disappears or goes on/offline.
 *
 * FC=27 lands several times a second for a polled amp, so a new result is only
 * committed to state when it actually differs — the editor re-renders on a
 * lock change, not on every poll. */
export function useAmpEditLock(
  projectId: string,
  assignmentId: string | undefined,
  linkedDeviceId: string | undefined,
  linkedOnline: boolean,
): AmpEditLock | null {
  const [lock, setLock] = useState<AmpEditLock | null>(null);
  const lastJson = useRef("");
  const sequence = useRef(0);
  const refresh = useRef<() => void>(() => {});
  const deviceIdRef = useRef(linkedDeviceId);
  deviceIdRef.current = linkedDeviceId;

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      const project = await listen("project:updated", () => refresh.current());
      const config = await listen<DeviceChannelConfig>("live_channel_config:updated", (event) => {
        if (event.payload.deviceId === deviceIdRef.current) refresh.current();
      });
      if (cancelled) {
        project();
        config();
      } else {
        unlisteners.push(project, config);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    setLock(null);
    lastJson.current = "";
  }, [projectId, assignmentId]);

  useEffect(() => {
    if (!assignmentId) {
      refresh.current = () => {};
      return;
    }
    const run = () => {
      const current = ++sequence.current;
      commands.projectsAmpEditLock(projectId, assignmentId).then((result) => {
        // Only the newest request may commit — responses can arrive out of order.
        if (current !== sequence.current || result.status !== "ok") return;
        const json = JSON.stringify(result.data);
        if (json === lastJson.current) return;
        lastJson.current = json;
        setLock(result.data);
      });
    };
    refresh.current = run;
    run();
    return () => {
      refresh.current = () => {};
    };
  }, [projectId, assignmentId, linkedDeviceId, linkedOnline]);

  return assignmentId ? lock : null;
}
