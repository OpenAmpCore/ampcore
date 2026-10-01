import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type ChannelSpeakerState,
  type Project,
  type SpeakerLibraryEntry,
  type SpeakerStatus,
} from "./bindings";

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

export function speakerName(entry: SpeakerLibraryEntry): string {
  return `${entry.brand} ${entry.model}`;
}


/** What differs from the library; empty for match and detached. */
export function speakerFields(status: SpeakerStatus): string[] {
  return status.kind === "edited" || status.kind === "libraryUpdated" ? status.fields : [];
}
