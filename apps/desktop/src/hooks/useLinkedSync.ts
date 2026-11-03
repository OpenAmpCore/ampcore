import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@heroui/react";
import { commands, type AmpEditLock, type Project } from "../lib/bindings";

/** Keeps every followed project amp in step with its linked online amp — for
 * the whole project, not just the amp whose editor is open.
 *
 * Whether an amp is followed is the backend's session
 * (`AmpEditLock.following`, kept by `amp_links.rs::amp_lock`): it starts when
 * the two fingerprints match and ends when the amp goes away, is disengaged,
 * or a pull fails. While it runs, writes go to the amp (the editor's
 * live-through mode, or `amp_write.rs::save_or_push` for any other caller), so
 * the project is a mirror: every reading that differs is pulled back in with
 * `projects_merge_amp_from_live`. Changes made anywhere — an editor, the amp's
 * front panel, another controller, a preset recall — reach the project the same
 * way, whichever view is open. Returns the assignment ids currently followed. */
export function useLinkedSync({
  projectId,
  locks,
  nameOf,
  onProjectUpdate,
}: {
  projectId: string;
  /** Every project amp's edit lock, by assignment id. */
  locks: Map<string, AmpEditLock>;
  /** The amp's name, for the toast when a session ends. */
  nameOf: (assignmentId: string) => string | undefined;
  onProjectUpdate: (project: Project) => void;
}): Set<string> {
  const following = useMemo(
    () => new Set([...locks].flatMap(([id, lock]) => (lock.following ? [id] : []))),
    [locks],
  );
  // Bumped when a pull lands, so the pull effect re-runs and picks up
  // anything that changed meanwhile.
  const [pulls, setPulls] = useState(0);
  // Per amp, read by the pull effect without making it re-run on every reading.
  const pulling = useRef(new Set<string>());
  // The amp hash last pulled — or last failed to pull, so a failure isn't
  // retried (and toasted) until the lock has caught up with the ended session.
  const pulledHash = useRef(new Map<string, string | null>());
  const updateRef = useRef(onProjectUpdate);
  updateRef.current = onProjectUpdate;
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  useEffect(() => {
    pulledHash.current.clear();
  }, [projectId]);

  useEffect(() => {
    for (const id of following) {
      const lock = locks.get(id);
      if (lock?.state !== "mismatch" || pulling.current.has(id)) continue;
      // Changes on every real change to the amp — that, not the reading itself,
      // is what has to reach the project.
      const liveHash = lock.live?.ampHash ?? null;
      if (liveHash !== null && pulledHash.current.get(id) === liveHash) continue;

      pulling.current.add(id);
      void commands.projectsMergeAmpFromLive(projectId, id).then((response) => {
        pulling.current.delete(id);
        setPulls((n) => n + 1);
        // A saved merge is the newest project either way.
        if (response.status === "ok" && response.data.merged && response.data.project) {
          pulledHash.current.set(id, response.data.ampHash ?? liveHash);
          updateRef.current(response.data.project);
          return;
        }
        // The backend has ended the session; the next lock read says so.
        pulledHash.current.set(id, liveHash);
        const reason = response.status === "error" ? response.error.message : "the amps still differ after copying the settings";
        toast.danger(`Stopped following ${nameRef.current(id) ?? "the amp"}`, {
          description: `${reason} — this project amp no longer updates itself. Use the comparison to match them again.`,
          timeout: 0,
        });
      });
    }
  }, [following, locks, pulls, projectId]);

  return following;
}
