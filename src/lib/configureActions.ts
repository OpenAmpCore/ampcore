import {
  commands,
  type AppError,
  type CrossoverSlotKind,
  type CrossoverSlotPatch,
  type EqBandPatch,
  type EqDirection,
  type LimiterPatch,
  type PowerMode,
  type Project,
  type SourceKind,
} from "./bindings";
import { actionFailed, toActionResult, type ActionResult } from "./actionResult";

/** Every mutation `AmpConfigureView`'s tabs (and `EqEditor`/`LimiterEditor`)
 * can make, abstracted away from *how* — Project mode persists to a
 * `Project` file via `commands.projectsSetX`, Direct Edit mode writes
 * straight to a live device via `commands.liveControlSetX` (see
 * `liveConfigureAdapter.ts`). Optional members mean "not available for this
 * source", signalled by plain `undefined` — call sites early-return on it.
 *
 * Every member resolves with an `ActionResult` and never rejects, so a
 * caller can react to the outcome (e.g. a tile's `visualValidation`) without
 * try/catch. Callers that don't care can keep ignoring the return value.
 *
 * As of the 1.1.8 Tier-A pass the only member Direct Edit mode still leaves
 * undefined is `setChannelOhms` — a Project-only concept, gated by
 * `ConfigureCapabilities.ohmsEditable` so it explains itself rather than
 * sitting inert. Every other member has a live wire command; FIR is the one
 * remaining device feature with no action here at all, and its tab says so
 * explicitly instead of offering dead controls.
 *
 * Note that an early-return on `undefined` is silent by design *only* where
 * a capability flag already explains the absence. Adding a new optional
 * member without that gating reintroduces a control that looks live and
 * does nothing. */
export interface ConfigureActions {
  setChannelDelayIn(channelIndex: number, delayInMs: number): Promise<ActionResult>;
  setChannelInputMute(channelIndex: number, muted: boolean): Promise<ActionResult>;
  setChannelOutput(
    channelIndex: number,
    trimDb: number | null,
    volumeDb: number | null,
    delayOutMs: number | null,
  ): Promise<ActionResult>;
  setChannelPhaseInvert(channelIndex: number, inverted: boolean): Promise<ActionResult>;
  setChannelOutputMute(channelIndex: number, muted: boolean): Promise<ActionResult>;
  setChannelPowerMode(channelIndex: number, mode: PowerMode): Promise<ActionResult>;

  setChannelName?(channelIndex: number, side: EqDirection, name: string | null): Promise<ActionResult>;
  setOutputBridge?(pairLeaderChannelIndex: number, bridged: boolean): Promise<ActionResult>;
  setChannelSource?(channelIndex: number, kind: SourceKind, index: number | null): Promise<ActionResult>;
  setMatrixCrosspoint?(
    channelIndex: number,
    sourceIndex: number,
    gainDb: number | null,
    active: boolean | null,
  ): Promise<ActionResult>;
  setCrossoverSlot?(
    channelIndex: number,
    direction: EqDirection,
    slot: CrossoverSlotKind,
    patch: CrossoverSlotPatch,
  ): Promise<ActionResult>;
  setEqBand?(
    channelIndex: number,
    direction: EqDirection,
    bandIndex: number,
    patch: EqBandPatch,
  ): Promise<ActionResult>;
  setChannelLimiter?(channelIndex: number, patch: LimiterPatch): Promise<ActionResult>;
  setChannelNoiseGate?(channelIndex: number, enabled: boolean, thresholdDbu: number): Promise<ActionResult>;
  setChannelOhms?(channelIndex: number, ohms: number): Promise<ActionResult>;
  setDeviceName?(name: string | null): Promise<ActionResult>;
}

/** Affordances that are conceptually Project-only (no live-device
 * equivalent exists at all, not just "not implemented yet") — today just the
 * Limiter tab's Ohms field, rendered disabled rather than silently inert. */
export interface ConfigureCapabilities {
  ohmsEditable: boolean;
}

export const PROJECT_CONFIGURE_CAPABILITIES: ConfigureCapabilities = {
  ohmsEditable: true,
};

export const LOCKED_CONFIGURE_CAPABILITIES: ConfigureCapabilities = {
  ohmsEditable: false,
};

/** Actions for an edit-locked project amp (see `data/edit_lock.rs`). Required
 * members refuse with `message`; optional members are omitted so the controls
 * that already gate on them (EQ graph, bridge, source, matrix, limiter…) render
 * disabled. The lock banner is the explanation their absence needs. */
export function lockConfigureActions(message: string): ConfigureActions {
  const refuse = async () => actionFailed(message);
  return {
    setChannelDelayIn: refuse,
    setChannelInputMute: refuse,
    setChannelOutput: refuse,
    setChannelPhaseInvert: refuse,
    setChannelOutputMute: refuse,
    setChannelPowerMode: refuse,
  };
}

type ProjectCommandResult = { status: "ok"; data: Project } | { status: "error"; error: AppError };

/** Applies a successful project mutation and reports its outcome. Project
 * failures have never shown a toast; returning the result is what lets the
 * control that fired them show a failure at all. */
async function applyProjectUpdate(
  call: Promise<ProjectCommandResult>,
  onProjectUpdate: (project: Project) => void,
): Promise<ActionResult> {
  const result = await call;
  if (result.status === "ok") onProjectUpdate(result.data);
  return toActionResult(result);
}

/** Mechanical extraction of the `commands.projectsSetX(project.id,
 * assignment.id, ...)` bodies every Configure tab used to call directly —
 * same commands, same `onProjectUpdate` callback, just centralized behind
 * `ConfigureActions` so the tabs themselves don't need to know they're
 * targeting a Project. */
export function createProjectConfigureActions(
  projectId: string,
  assignmentId: string,
  onProjectUpdate: (project: Project) => void,
): ConfigureActions {
  const apply = (call: Promise<ProjectCommandResult>) => applyProjectUpdate(call, onProjectUpdate);

  return {
    setChannelDelayIn: (channelIndex, delayInMs) =>
      apply(commands.projectsSetChannelDelayIn(projectId, assignmentId, channelIndex, delayInMs)),
    setChannelInputMute: (channelIndex, muted) =>
      apply(commands.projectsSetChannelInputMute(projectId, assignmentId, channelIndex, muted)),
    setChannelOutput: (channelIndex, trimDb, volumeDb, delayOutMs) =>
      apply(commands.projectsSetChannelOutput(projectId, assignmentId, channelIndex, trimDb, volumeDb, delayOutMs)),
    setChannelPhaseInvert: (channelIndex, inverted) =>
      apply(commands.projectsSetChannelPhaseInvert(projectId, assignmentId, channelIndex, inverted)),
    setChannelOutputMute: (channelIndex, muted) =>
      apply(commands.projectsSetChannelOutputMute(projectId, assignmentId, channelIndex, muted)),
    setChannelPowerMode: (channelIndex, mode) =>
      apply(commands.projectsSetChannelPowerMode(projectId, assignmentId, channelIndex, mode)),
    setChannelName: (channelIndex, side, name) =>
      apply(commands.projectsSetChannelName(projectId, assignmentId, channelIndex, side, name)),
    setOutputBridge: (pairLeaderChannelIndex, bridged) =>
      apply(commands.projectsSetOutputBridge(projectId, assignmentId, pairLeaderChannelIndex, bridged)),
    setChannelSource: (channelIndex, kind, index) =>
      apply(commands.projectsSetChannelSource(projectId, assignmentId, channelIndex, kind, index)),
    setMatrixCrosspoint: (channelIndex, sourceIndex, gainDb, active) =>
      apply(commands.projectsSetMatrixCrosspoint(projectId, assignmentId, channelIndex, sourceIndex, gainDb, active)),
    setCrossoverSlot: (channelIndex, direction, slot, patch) =>
      apply(commands.projectsSetCrossoverSlot(projectId, assignmentId, channelIndex, direction, slot, patch)),
    setEqBand: (channelIndex, direction, bandIndex, patch) =>
      apply(commands.projectsSetEqBand(projectId, assignmentId, channelIndex, direction, bandIndex, patch)),
    setChannelLimiter: (channelIndex, patch) =>
      apply(commands.projectsSetChannelLimiter(projectId, assignmentId, channelIndex, patch)),
    setChannelNoiseGate: (channelIndex, enabled, thresholdDbu) =>
      apply(commands.projectsSetChannelNoiseGate(projectId, assignmentId, channelIndex, enabled, thresholdDbu)),
    setChannelOhms: (channelIndex, ohms) =>
      apply(commands.projectsSetChannelOhms(projectId, assignmentId, channelIndex, ohms)),
    setDeviceName: (name) =>
      apply(commands.projectsSetAmpDeviceName(projectId, assignmentId, name)),
  };
}
