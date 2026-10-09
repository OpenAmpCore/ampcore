import { useEffect, useRef, useState } from "react";
import { toast } from "@heroui/react";
import { commands, type AmpEditLock, type Project } from "../lib/bindings";

/** Keeps every matched project amp following its linked online amp — for the
 * whole project, not just the amp whose editor is open.
 *
 * While a session runs, the editor writes straight to the amp (see
 * `AmpConfigureView`'s live-through mode), so the project is a mirror rather
 * than a second source of truth: every reading that differs is pulled back in
 * with the same `projects_merge_amp_from_live` the merge panel uses. Changes
 * made anywhere — an editor, the amp's front panel, another controller, a
 * preset recall — reach the project the same way, whichever view is open:
 * leaving an amp's editor mid-recall must not end its session.
 *
 * A session starts the moment the two fingerprints match and ends when the amp
 * goes away, is disengaged, or a pull fails; the edit lock then takes over
 * again. Returns the assignment ids currently following. */
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
  const [following, setFollowing] = useState(new Set<string>());
  // Bumped when a pull lands, so the pull effect re-runs and picks up
  // anything that changed meanwhile.
  const [pulls, setPulls] = useState(0);
  // Per amp, read by the pull effect without making it re-run on every reading.
  const pulling = useRef(new Set<string>());
  const pulledHash = useRef(new Map<string, string | null>());
  const updateRef = useRef(onProjectUpdate);
  updateRef.current = onProjectUpdate;
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  // Another project is another set of sessions.
  useEffect(() => {
    setFollowing(new Set());
    pulledHash.current.clear();
  }, [projectId]);

  useEffect(() => {
    // `checking`/`unreadable` keep the session: the amp is still the source of
    // truth, and a reading gap (FC=50 bridge or a FIR not read yet — e.g. just
    // after a recall) shouldn't drop live editing. Only losing the amp — or
    // stepping out of the session by hand — does. `following` is sticky
    // otherwise, so `disengaged` has to clear it explicitly or a disengage
    // from a live session would leave the editor still writing to the amp.
    setFollowing((prev) => {
      const next = new Set(prev);
      for (const [id, lock] of locks) {
        if (lock.state === "matches") next.add(id);
        else if (lock.state === "offline" || lock.state === "unlinked" || lock.state === "disengaged") next.delete(id);
      }
      // An amp that left the project leaves its session.
      for (const id of next) if (!locks.has(id)) next.delete(id);
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, [locks]);

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
        const reason = response.status === "error" ? response.error.message : "the amps still differ after copying the settings";
        setFollowing((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.danger(`Stopped following ${nameRef.current(id) ?? "the amp"}`, {
          description: `${reason} — this project amp no longer updates itself. Use the comparison to match them again.`,
          timeout: 0,
        });
      });
    }
  }, [following, locks, pulls, projectId]);

  return following;
}
