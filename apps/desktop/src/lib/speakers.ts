import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Hypher from "hypher";
import german from "hyphenation.de";
import {
  commands,
  type ChannelSpeakerState,
  type Project,
  type SpeakerDetails,
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

/** Details of a speaker not described yet: one unnamed way. */
export const EMPTY_SPEAKER_DETAILS: SpeakerDetails = { brand: "", family: "", model: "", application: "", notes: "", wayLabels: [""] };

export function speakerName(entry: SpeakerLibraryEntry): string {
  return `${entry.brand} ${entry.model}`;
}

const hypher = new Hypher(german);
const BRAND_SHORT = new Map<string, string>();

/** A brand abbreviated. One word: its syllables' initials ("Plansound" →
 * Plan|sound → "PS"), a one-syllable word as it is ("TOP"). Several words
 * (spaces or hyphens): one initial each, short ones kept ("TW AUDiO" → "TWA",
 * "Jobst-Audio" → "JA"). */
export function brandShort(brand: string): string {
  let short = BRAND_SHORT.get(brand);
  if (short === undefined) {
    const words = brand.split(/[\s-]+/).filter(Boolean);
    if (words.length === 1) {
      const syllables = hypher.hyphenate(words[0]);
      short = syllables.length > 1 ? syllables.map((s) => s[0].toUpperCase()).join("") : words[0];
    } else {
      short = words.map((w) => (w.length <= 3 ? w : w[0].toUpperCase())).join("") || "–";
    }
    BRAND_SHORT.set(brand, short);
  }
  return short;
}


/** What differs from the library; empty for match and detached. */
export function speakerFields(status: SpeakerStatus): string[] {
  return status.kind === "edited" || status.kind === "libraryUpdated" ? status.fields : [];
}
