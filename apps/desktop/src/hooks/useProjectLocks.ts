import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AmpEditLock, type Project } from "../lib/bindings";

const EVENTS = ["project:updated", "live_device:updated", "live_channel_config:updated", "live_bridge:updated", "live_fir:updated"];

/** The edit lock of every amp in the project, by assignment id — what the
 * Workspace's amp cards show as their sync state. Re-resolved at most once a
 * second while anything that feeds a lock keeps arriving, and committed only
 * when a lock actually changed.
 * ponytail: one full `projectsAmpEditLock` per amp per second; a summary
 * command (state + difference count for all amps) when projects get large. */
export function useProjectLocks(project: Project): Map<string, AmpEditLock> {
  const [locks, setLocks] = useState(new Map<string, AmpEditLock>());
  const ids = project.ampAssignments.map((a) => a.id).join("\n");

  useEffect(() => {
    let cancelled = false;
    let dirty = true;
    let sequence = 0;
    let lastJson = "";
    const resolve = () => {
      if (!dirty) return;
      dirty = false;
      const current = ++sequence;
      void Promise.all(
        ids.split("\n").filter(Boolean).map(async (id) => [id, await commands.projectsAmpEditLock(project.id, id)] as const),
      ).then((results) => {
        // Only the newest round may commit — responses can arrive out of order.
        if (cancelled || current !== sequence) return;
        const next = results.flatMap(([id, r]) => (r.status === "ok" ? [[id, r.data] as const] : []));
        const json = JSON.stringify(next);
        if (json === lastJson) return;
        lastJson = json;
        setLocks(new Map(next));
      });
    };
    const unlisten = EVENTS.map((event) => listen(event, () => (dirty = true)));
    resolve();
    const timer = setInterval(resolve, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unlisten.forEach((u) => void u.then((stop) => stop()));
    };
  }, [project.id, ids]);

  return locks;
}
