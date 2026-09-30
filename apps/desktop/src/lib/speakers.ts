import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type ChannelSpeakerState,
  type Project,
  type SpeakerLibraryEntry,
  type SpeakerProcessing,
} from "./bindings";
import { ACTION_OK, ACTION_UNAVAILABLE, type ActionResult } from "./actionResult";
import type { ConfigureActions } from "./configureActions";

/** This machine's speaker library, kept current through `speakers:updated`. */
export function useSpeakerLibrary(): SpeakerLibraryEntry[] {
  const [entries, setEntries] = useState<SpeakerLibraryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    commands.speakersList().then((r) => {
      if (!cancelled && r.status === "ok") setEntries(r.data);
    });
    listen<SpeakerLibraryEntry[]>("speakers:updated", (e) => setEntries(e.payload)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return entries;
}

/** Library status of every output of one project amp that has a speaker.
 * Re-resolved whenever the project or the library changes. */
export function useSpeakerStates(
  project: Project | undefined,
  assignmentId: string | undefined,
  library: SpeakerLibraryEntry[],
): Map<number, ChannelSpeakerState> {
  const [states, setStates] = useState(new Map<number, ChannelSpeakerState>());
  const projectId = project?.id;
  const updatedAt = project?.updatedAt;
  useEffect(() => {
    if (!projectId || !assignmentId) {
      setStates(new Map());
      return;
    }
    let cancelled = false;
    commands.speakersChannelStates(projectId, assignmentId).then((r) => {
      if (!cancelled && r.status === "ok") setStates(new Map(r.data.map((s) => [s.channelIndex, s])));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, assignmentId, updatedAt, library]);
  return states;
}

/** Writes a library way's values into an output through the editor's own
 * actions, so a project amp following its linked amp writes to the amp like
 * any hand edit (see `commands/speakers.rs`). Stops at the first failure. */
export async function applySpeakerProcessing(
  actions: ConfigureActions,
  channelIndex: number,
  p: SpeakerProcessing,
): Promise<ActionResult> {
  const paste = actions.pasteChannelSection;
  if (!paste) return ACTION_UNAVAILABLE;
  const steps: Array<() => Promise<ActionResult>> = [
    () => paste(channelIndex, "outputEq", { kind: "eq", eq: p.outputEq }),
    // RMS before peak: pasting RMS may raise the peak floor, and the peak
    // stage's own values must win afterwards.
    () => paste(channelIndex, "rmsLimiter", { kind: "rmsLimiter", rms: p.limiter.rms }),
    () => paste(channelIndex, "peakLimiter", { kind: "peakLimiter", peak: p.limiter.peak }),
    () => actions.setChannelOutput(channelIndex, null, null, p.delayOutMs ?? 0),
    () => actions.setChannelPhaseInvert(channelIndex, p.phaseInverted),
  ];
  for (const step of steps) {
    const result = await step();
    if (!result.ok) return result;
  }
  return ACTION_OK;
}

export function speakerName(entry: SpeakerLibraryEntry): string {
  return `${entry.brand} ${entry.model}`;
}

