import type { AmpAssignment, SpeakerLibraryEntry, SpeakerProcessing, SpeakerWay } from "../../lib/bindings";
import { ACTION_OK, actionFailed } from "../../lib/actionResult";
import type { ConfigureActions } from "../../lib/configureActions";

const REFUSED = "Not part of a speaker.";

const DEFAULT_OHMS = 8;

/** "Full" for a one-way speaker, else "Way N": what a way without a label is
 * called, as `speaker.rs::way_label` names it on save. */
export function defaultWayLabel(index: number, count: number): string {
  return count === 1 ? "Full" : `Way ${index + 1}`;
}

/** The speaker as a stand-in amp with one output per way, so the Output tab's
 * own row and editors (EQ, limiter, FIR) edit a speaker exactly as they edit
 * outputs. A way's label is the output's name, and its nominal impedance the
 * Load, which only the watt figures use. */
export function speakerAssignment(entry: SpeakerLibraryEntry, ampModelId: string | null, firmwareVersion: string | null): AmpAssignment {
  return {
    id: "speaker",
    mac: null,
    ampModelId,
    firmwareVersion,
    channels: entry.ways.map(({ label, processing: p, nominalOhms }, i) => ({
      channelIndex: i,
      outputName: label || null,
      // A way without a stored impedance reads as 8 Ω, a new output's default.
      ohms: nominalOhms ?? DEFAULT_OHMS,
      source: { kind: "analog", index: 0 },
      outputEq: p.outputEq,
      limiter: p.limiter,
      delayOutMs: p.delayOutMs,
      outputPhaseInverted: p.phaseInverted,
      outputTrimDb: p.outputTrimDb,
      noiseGateEnabled: p.noiseGateEnabled,
      noiseGateThresholdDbu: p.noiseGateThresholdDbu,
      powerMode: p.powerMode,
      firBypassed: p.firBypassed,
      fir: p.fir,
    })),
  };
}

/** `ConfigureActions` over the speaker's ways: channel `i` is way `i`, and
 * every edit changes that way in the draft. Name and Load set the way's label
 * and nominal impedance. Input-side and wiring actions don't exist for a
 * speaker and are left out (optional) or refused (required). */
export function wayActions(setWay: (index: number, change: (way: SpeakerWay) => SpeakerWay) => void): ConfigureActions {
  const refuse = async () => actionFailed(REFUSED);
  const edit = (index: number, change: (p: SpeakerProcessing) => SpeakerProcessing) => {
    setWay(index, (w) => ({ ...w, processing: change(w.processing) }));
    return Promise.resolve(ACTION_OK);
  };
  return {
    setChannelDelayIn: refuse,
    setChannelInputMute: refuse,
    setChannelOutputMute: refuse,
    setChannelOhms: (i, ohms) => {
      setWay(i, (w) => ({ ...w, nominalOhms: ohms }));
      return Promise.resolve(ACTION_OK);
    },
    setChannelName: (i, _, name) => {
      setWay(i, (w) => ({ ...w, label: name ?? "" }));
      return Promise.resolve(ACTION_OK);
    },
    // Volume is never part of a speaker (see `data/speaker.rs`).
    setChannelOutput: (i, trimDb, _volumeDb, delayOutMs) =>
      edit(i, (p) => ({
        ...p,
        outputTrimDb: trimDb ?? p.outputTrimDb,
        delayOutMs: delayOutMs ?? p.delayOutMs,
      })),
    setChannelPhaseInvert: (i, inverted) => edit(i, (p) => ({ ...p, phaseInverted: inverted })),
    setChannelNoiseGate: (i, enabled, thresholdDbu) =>
      edit(i, (p) => ({ ...p, noiseGateEnabled: enabled, noiseGateThresholdDbu: thresholdDbu })),
    setChannelFirBypass: (i, bypassed) => edit(i, (p) => ({ ...p, firBypassed: bypassed })),
    setChannelPowerMode: (i, mode) => edit(i, (p) => ({ ...p, powerMode: mode })),
    setChannelFirData: (i, name, coefficients) => edit(i, (p) => ({ ...p, fir: { name, coefficients } })),
    // What an amp holds after the vendor's Remove: a unit impulse.
    clearChannelFirData: (i) => edit(i, (p) => ({ ...p, fir: { name: "", coefficients: [1] } })),
    setCrossoverSlot: (i, __, slot, patch) =>
      edit(i, (p) => {
        const current = p.outputEq[slot];
        return {
          ...p,
          outputEq: {
            ...p.outputEq,
            [slot]: {
              filterType: patch.filterType ?? current.filterType,
              freqHz: patch.freqHz ?? current.freqHz,
              active: patch.active ?? current.active,
            },
          },
        };
      }),
    setEqBand: (i, __, bandIndex, patch) =>
      edit(i, (p) => ({
        ...p,
        outputEq: {
          ...p.outputEq,
          bands: p.outputEq.bands.map((band, b) =>
            b !== bandIndex
              ? band
              : {
                  filterType: patch.filterType ?? band.filterType,
                  freqHz: patch.freqHz ?? band.freqHz,
                  gainDb: patch.gainDb ?? band.gainDb,
                  q: patch.q ?? band.q,
                  active: patch.active ?? band.active,
                },
          ),
        },
      })),
    setChannelLimiter: (i, patch) =>
      edit(i, (p) => {
        const { rms, peak } = p.limiter;
        return {
          ...p,
          limiter: {
            rms: {
              ...rms,
              enabled: patch.rmsEnabled ?? rms.enabled,
              thresholdVrms: patch.rmsThresholdVrms ?? rms.thresholdVrms,
              attackMs: patch.rmsAttackMs ?? rms.attackMs,
              releaseMultiplier: patch.rmsReleaseMultiplier ?? rms.releaseMultiplier,
            },
            peak: {
              ...peak,
              enabled: patch.peakEnabled ?? peak.enabled,
              thresholdVp: patch.peakThresholdVp ?? peak.thresholdVp,
              holdMs: patch.peakHoldMs ?? peak.holdMs,
              releaseMs: patch.peakReleaseMs ?? peak.releaseMs,
            },
          },
        };
      }),
  };
}
