import { useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { commands, type AmpEditLock, type Project } from "../lib/bindings";

/** Keeps a matched project amp following its linked online amp.
 *
 * While a session runs, the editor writes straight to the amp (see
 * `AmpConfigureView`'s live-through mode), so the project is a mirror rather
 * than a second source of truth: every reading that differs is pulled back in
 * with the same `projects_merge_amp_from_live` the merge panel uses. Changes
 * made anywhere — this editor, the amp's front panel, another controller, a
 * preset recall — reach the project the same way.
 *
 * A session starts the moment the two fingerprints match and ends when the amp
 * goes away or a pull fails; the edit lock then takes over again. */
export function useLinkedSync({
  projectId,
  assignmentId,
  lock,
  deviceName,
  onProjectUpdate,
}: {
  projectId: string;
  assignmentId: string | undefined;
  lock: AmpEditLock | null;
  deviceName: string | undefined;
  onProjectUpdate: (project: Project) => void;
}) {
  const [following, setFollowing] = useState(false);
  const [pulling, setPulling] = useState(false);
  // Read by the pull effect without making it re-run on every new reading.
  const pullingRef = useRef(false);
  const pulledHash = useRef<string | null>(null);
  const updateRef = useRef(onProjectUpdate);
  updateRef.current = onProjectUpdate;
  const nameRef = useRef(deviceName);
  nameRef.current = deviceName;

  const state = lock?.state;
  // Changes on every real change to the amp — that, not the reading itself,
  // is what has to reach the project.
  const liveHash = lock?.live?.ampHash ?? null;

  // Another amp is another session.
  useEffect(() => {
    setFollowing(false);
    pulledHash.current = null;
  }, [projectId, assignmentId]);

  useEffect(() => {
    // `checking`/`unreadable` keep the session: the amp is still the source of
    // truth, and a reading gap (e.g. FC=50 bridge not answered yet) shouldn't
    // drop live editing. Only losing the amp — or the user stepping out of the
    // session by hand — does. `following` is sticky otherwise, so `disengaged`
    // has to clear it explicitly or a disengage from a live session would
    // leave the editor still writing to the amp.
    if (state === "matches") setFollowing(true);
    else if (state === "offline" || state === "unlinked" || state === "disengaged") setFollowing(false);
  }, [state]);

  useEffect(() => {
    if (!following || !assignmentId || state !== "mismatch") return;
    // One pull at a time; `pulling` is a dependency, so finishing one
    // re-runs this and picks up anything that changed meanwhile.
    if (pullingRef.current || (liveHash !== null && pulledHash.current === liveHash)) return;

    let cancelled = false;
    pullingRef.current = true;
    setPulling(true);
    commands.projectsMergeAmpFromLive(projectId, assignmentId).then((response) => {
      pullingRef.current = false;
      if (cancelled) return;
      setPulling(false);

      if (response.status === "ok" && response.data.merged && response.data.project) {
        pulledHash.current = liveHash;
        updateRef.current(response.data.project);
        return;
      }

      const reason =
        response.status === "error"
          ? response.error.message
          : "the amps still differ after copying the settings";
      setFollowing(false);
      notifications.show({
        color: "red",
        title: `Stopped following ${nameRef.current ?? "the amp"}`,
        message: `${reason} — this project amp no longer updates itself. Use the comparison to match them again.`,
        autoClose: false,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [following, state, liveHash, pulling, projectId, assignmentId]);

  return { following, pulling };
}
