//! Online ← offline push: turns the difference between a project amp and its
//! linked network amp into an ordered list of writes, so the *amp* adopts the
//! plan. The mirror image of `amp_merge.rs`, which copies the other way.
//!
//! The two directions are not symmetric. A pull is one atomic FC=27 read; a
//! push is N sequential ACK'd UDP writes against hardware that cannot roll
//! back. So this module plans rather than acts: it produces a `PushPlan` of
//! labelled stages up front, the caller executes them in order and stops at
//! the first failure, and a partly-applied push is resolved by planning again
//! — the next plan simply contains whatever is still different.
//!
//! **Diffing is the hash's diffing.** Every comparison runs through
//! `fingerprint.rs`'s `round_to_step` with the same `*_STEPS` constants, and
//! skips exactly what the hash skips: a band bypassed on both sides, a
//! disabled limiter stage, an inactive crosspoint's gain, a gain/Q the filter
//! type doesn't use. Anything else would plan writes that cannot change
//! whether the two fingerprints match — the only definition of "done" this
//! feature has (see `edit_lock.rs`).
//!
//! **Two fields are read-only by decision, not by protocol**:
//! `limiter.rms.max_vrms` and `limiter.peak.max_vp`. The vendor carries them
//! in its 13-byte FC=54/55 records, but they describe what the hardware *is*
//! — its rated output voltage — rather than what anyone plans for it. They
//! are hashed, so a push that left them differing could never converge; instead
//! `adopt_device_facts` copies them the other way as part of the same
//! transaction, and `PushPlan.adopted` lists them so the swap is visible
//! rather than silent.
//!
//! `ohms` takes no part in any of this: it is a local value that only converts
//! volts to watts in the limiter editor, so it is neither written nor adopted.

use serde::Serialize;
use specta::Type;

use super::capability::{PowerMode, SourceKind};
use super::fingerprint::{
    canonical_input_name, canonical_output_name, output_letter, round_to_step, FingerprintRow, DELAY_STEPS, FREQ_STEPS,
    GAIN_STEPS, Q_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{AmpAssignment, AmpChannel, ChannelEq, CrossoverSlot, EqBand, EqDirection, SourceTrim};
use crate::live::cvr::fir::ChannelFirSnapshot;
use crate::live::cvr::channel_config::{ChannelConfig, ChannelConfigSnapshot, EqChainWire};
use crate::live::cvr::channel_config_v118::{crossover_filter_type_code, eq_filter_type_code};
use crate::live::cvr::write;
use crate::live::cvr::write_v118::{EqChainBand, EQ_CHAIN_BANDS};

mod packets;
mod adopt;
pub use packets::*;
pub use adopt::*;

/// Which source family an FC=62 trim applies to. The wire carries this in the
/// packet's `segment` field, not its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceTrimFamily {
    Analog,
    Dante,
}

impl SourceTrimFamily {
    /// Segment 2 is AES3, which this app dropped — the gap is deliberate.
    /// These are the device's own numbers, so Dante stays 1 rather than
    /// sliding up to fill it.
    pub fn segment(self) -> u8 {
        match self {
            SourceTrimFamily::Analog => 0,
            SourceTrimFamily::Dante => 1,
        }
    }
}

/// One planned write. Typed rather than pre-encoded bytes so a plan can be
/// reasoned about and tested independently of the wire encoding — the
/// packet(s) each one becomes are built by `action_packets` below.
#[derive(Debug, Clone)]
pub enum PushAction {
    DeviceName { name: String },
    Source { channel: u8, kind: SourceKind, analog_index: Option<u8> },
    InputMute { channel: u8, muted: bool },
    DelayIn { channel: u8, delay_ms: f64 },
    SourceTrim { channel: u8, family: SourceTrimFamily, trim_db: f64, delay_ms: f64 },
    /// One side's whole 10-band chain, HP and LP included (FC=52). `wire`
    /// carries the bytes of that body this app's model doesn't own, so they
    /// are echoed back rather than invented — see `EqChainWire`.
    EqChain { channel: u8, direction: EqDirection, eq: ChannelEq, wire: EqChainWire },
    MatrixCrosspoint { channel: u8, source_index: u8, gain_db: f64, active: bool },
    OutputTrim { channel: u8, trim_db: f64 },
    OutputVolume { channel: u8, volume_db: f64 },
    OutputMute { channel: u8, muted: bool },
    DelayOut { channel: u8, delay_ms: f64 },
    PhaseInvert { channel: u8, inverted: bool },
    PowerMode { channel: u8, mode: PowerMode },
    FirBypass { channel: u8, bypassed: bool },
    /// The whole FIR filter (FC=43). Planned by `plan_fir`, not `plan_push`:
    /// the amp's FIR isn't in the FC=27 snapshot `plan_push` diffs against.
    FirData { channel: u8, name: String, coefficients: Vec<f32> },
    NoiseGate { channel: u8, enabled: bool, threshold_dbu: i8 },
    RmsLimiter { channel: u8, enabled: bool, threshold_vrms: f64, attack_ms: f64, release_multiplier: f64 },
    RmsLimiterAuto { channel: u8, auto: bool },
    PeakLimiter { channel: u8, enabled: bool, threshold_vp: f64, hold_ms: f64, release_ms: f64 },
    ChannelName { channel: u8, direction: EqDirection, name: String },
    Bridge { pair_index: u8, bridged: bool },
}

impl PushAction {
    /// How many UDP packets this becomes. Kept next to the action rather than
    /// derived from built packets so a plan can be described — and its
    /// progress bar sized — without an encoder or a firmware family.
    pub fn packet_count(&self) -> u32 {
        match self {
            // FC=11 SOURCE_SELECT, plus FC=79 for an analog pick.
            PushAction::Source { analog_index, .. } => 1 + u32::from(analog_index.is_some()),
            // A 2093-byte frame in 450-byte fragments (see `fir.rs`).
            PushAction::FirData { .. } => 5,
            // Everything else is one packet — including a whole EQ chain,
            // which is the entire point of FC=52.
            _ => 1,
        }
    }
}

/// A stage as the frontend sees it: an identity, where it belongs, and how
/// much work it is. The actions themselves never cross the bridge.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushStage {
    /// Stable across re-plans, so a progress event can address a rendered row.
    pub id: String,
    /// "Amp", "In 1", "Out A" — the same grouping `FingerprintRow` uses.
    pub group: String,
    pub label: String,
    pub packets: u32,
}

/// The plan the frontend renders and the progress events index into.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpPushPlan {
    pub stages: Vec<PushStage>,
    pub packet_count: u32,
    /// Device-determined fields the *project* will take from the amp instead
    /// of pushing — see the module doc comment. Empty when they already agree.
    pub adopted: Vec<FingerprintRow>,
}

/// A stage plus the work it stands for.
#[derive(Debug, Clone)]
pub struct PlannedStage {
    pub stage: PushStage,
    pub actions: Vec<PushAction>,
}

/// The executable plan. `describe()` is what reaches the frontend.
#[derive(Debug, Clone)]
pub struct PushPlan {
    pub stages: Vec<PlannedStage>,
    pub adopted: Vec<FingerprintRow>,
}

impl PushPlan {
    pub fn describe(&self) -> AmpPushPlan {
        AmpPushPlan {
            stages: self.stages.iter().map(|s| s.stage.clone()).collect(),
            packet_count: self.stages.iter().map(|s| s.stage.packets).sum(),
            adopted: self.adopted.clone(),
        }
    }
}

/// Something in the project the wire cannot express — surfaced at plan time,
/// so nothing is sent before the caller knows the push can't finish.
#[derive(Debug)]
pub struct PushPlanError(pub String);

impl std::fmt::Display for PushPlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

// ---------------------------------------------------------------------------
// Difference tests — each mirrors how `fingerprint.rs` encodes the field
// ---------------------------------------------------------------------------

fn differs(project: f64, live: f64, steps: f64) -> bool {
    round_to_step(project, steps) != round_to_step(live, steps)
}

/// A crossover slot needs writing when either side is engaged and anything
/// the hash encodes about it differs. Bypassed on both sides, the hash reads
/// only `active`, so a stored freq/type difference is invisible to it and
/// writing it could never help.
fn crossover_differs(project: &CrossoverSlot, live: &CrossoverSlot) -> bool {
    if !project.active && !live.active {
        return false;
    }
    project.active != live.active
        || project.filter_type != live.filter_type
        || differs(project.freq_hz, live.freq_hz, FREQ_STEPS)
}

/// Same rule as `crossover_differs`, plus gain/Q only where the filter type
/// actually uses them — exactly what `canonical_band` nulls out.
fn band_differs(project: &EqBand, live: &EqBand) -> bool {
    if !project.active && !live.active {
        return false;
    }
    if project.active != live.active || project.filter_type != live.filter_type {
        return true;
    }
    if differs(project.freq_hz, live.freq_hz, FREQ_STEPS) {
        return true;
    }
    let caps = project.filter_type.capabilities();
    (caps.supports_gain && differs(project.gain_db, live.gain_db, GAIN_STEPS))
        || (caps.supports_q && differs(project.q, live.q, Q_STEPS))
}

fn trim_differs(project: &SourceTrim, live_trim: f32, live_delay: f32) -> bool {
    differs(project.trim_db, live_trim as f64, GAIN_STEPS) || differs(project.delay_ms, live_delay as f64, DELAY_STEPS)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

struct StageBuilder {
    id: String,
    group: String,
    label: String,
    actions: Vec<PushAction>,
}

impl StageBuilder {
    fn new(id: impl Into<String>, group: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), group: group.into(), label: label.into(), actions: Vec::new() }
    }

    fn push(&mut self, action: PushAction) {
        self.actions.push(action);
    }

    /// A stage with nothing to do is dropped rather than rendered as an
    /// instantly-complete row — the list should read as the work, not as the
    /// amp's topology.
    fn finish(self, out: &mut Vec<PlannedStage>) {
        if self.actions.is_empty() {
            return;
        }
        let packets = self.actions.iter().map(PushAction::packet_count).sum();
        out.push(PlannedStage {
            stage: PushStage { id: self.id, group: self.group, label: self.label, packets },
            actions: self.actions,
        });
    }
}

/// Plans every write needed to make `assignment`'s settings the amp's.
///
/// `device_name` is the amp's current name (FC=0 BASIC_INFO, the same source
/// the fingerprint uses), and `bridged` the per-pair FC=50 readback — `None`
/// for a pair the amp hasn't reported, which is left alone rather than
/// guessed at.
pub fn plan_push(
    assignment: &AmpAssignment,
    snapshot: &ChannelConfigSnapshot,
    device_name: &str,
    bridged: &[Option<bool>],
    matrix_input_count: u32,
) -> Result<PushPlan, PushPlanError> {
    let mut stages: Vec<PlannedStage> = Vec::new();
    let channel_count = assignment.channels.len() as u32;

    // Amp-level first: the device name is the one setting that isn't a
    // channel's, and it costs a single packet.
    let planned_name = assignment.device_name.as_deref().map(str::trim).unwrap_or("");
    let mut amp = StageBuilder::new("amp-name", "Amp", "Device name");
    if planned_name != device_name.trim() {
        if !planned_name.is_ascii() {
            return Err(PushPlanError(format!(
                "The device name \"{planned_name}\" isn't ASCII — the amp stores names as fixed-width ASCII"
            )));
        }
        amp.push(PushAction::DeviceName { name: planned_name.to_string() });
    }
    amp.finish(&mut stages);

    for channel in &assignment.channels {
        let index = channel.channel_index;
        // The caller's guards already reject a snapshot missing a channel;
        // skipping is the honest fallback if one slips through.
        let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == index) else {
            continue;
        };
        let ch = u8::try_from(index).map_err(|_| PushPlanError(format!("channel index {index} is out of range")))?;
        let in_group = format!("In {}", index + 1);
        let out_group = format!("Out {}", output_letter(index));

        plan_input(&mut stages, channel, config, ch, &in_group)?;
        plan_eq(&mut stages, channel, config, ch, EqDirection::Input, &in_group, format!("in-eq-{index}"), "Input EQ");
        plan_matrix(&mut stages, channel, config, ch, &out_group, matrix_input_count)?;
        plan_eq(
            &mut stages,
            channel,
            config,
            ch,
            EqDirection::Output,
            &out_group,
            format!("out-eq-{index}"),
            "Output EQ",
        );
        plan_speaker(&mut stages, channel, config, ch, &out_group);
        plan_output_name(&mut stages, channel, config, ch, &out_group);
    }

    // Bridging last: it re-pairs outputs, so everything above is planned
    // against the topology the amp is already in. The web reference's
    // `adjustBridgeMode` is likewise its final post-apply step.
    let mut bridge = StageBuilder::new("bridge", "Amp", "Bridging");
    for channel in &assignment.channels {
        let leader = channel.channel_index;
        if leader % 2 != 0 || leader + 1 >= channel_count {
            continue;
        }
        let pair = (leader / 2) as usize;
        // `None` means the amp never reported this pair. The fingerprint
        // treats that as unreadable and refuses to hash, so the caller has
        // already rejected the push by the time we get here.
        if let Some(Some(live)) = bridged.get(pair) {
            if *live != channel.output_bridged {
                bridge.push(PushAction::Bridge { pair_index: pair as u8, bridged: channel.output_bridged });
            }
        }
    }
    bridge.finish(&mut stages);

    Ok(PushPlan { stages, adopted: adopted_rows(assignment, snapshot) })
}

/// Source, input mute, input delay, per-source trims and the input name —
/// everything on the input side that isn't EQ.
fn plan_input(
    stages: &mut Vec<PlannedStage>,
    channel: &AmpChannel,
    config: &ChannelConfig,
    ch: u8,
    group: &str,
) -> Result<(), PushPlanError> {
    let index = channel.channel_index;
    let mut stage = StageBuilder::new(format!("in-{index}"), group, "Input");

    let planned = channel.source;
    if config.source.map(|s| (s.kind, s.index)) != Some((planned.kind, planned.index)) {
        if planned.kind == SourceKind::Backup {
            // FC=11 selects a real input; backup is a state the amp enters on
            // its own via the priority controls (FC=80, which this push
            // deliberately does not drive — see `plan_input`'s note below).
            return Err(PushPlanError(format!(
                "In {}: backup is a readback state, not something the amp can be told to select",
                index + 1
            )));
        }
        if planned.kind == SourceKind::Aes3 {
            return Err(PushPlanError(format!(
                "In {}: AES3 is shown as the amp reports it, but this app can't select it — pick Analog or Dante",
                index + 1
            )));
        }
        // Only an analog pick names a physical input; Dante is wired 1:1 to
        // its channel, so FC=79 would be meaningless for it.
        //
        // Which also makes any other index unreachable: `channel_config_v118::
        // source` always reads Dante back as `index = channel_index`, so
        // a project asking for a different one would be written, read back
        // changed, and leave the two fingerprints permanently apart. Better to
        // say so than to push and let the amp look stuck in mismatch.
        let analog_index = match planned.kind {
            SourceKind::Analog => Some(u8::try_from(planned.index).map_err(|_| {
                PushPlanError(format!("In {}: analog input {} is out of range", index + 1, planned.index))
            })?),
            _ if planned.index != index => {
                return Err(PushPlanError(format!(
                    "In {}: {:?} input {} can't be selected — digital inputs are wired 1:1 to their channel, so this channel can only take {:?} {}",
                    index + 1,
                    planned.kind,
                    planned.index + 1,
                    planned.kind,
                    index + 1
                )))
            }
            _ => None,
        };
        stage.push(PushAction::Source { channel: ch, kind: planned.kind, analog_index });
    }

    if channel.input_muted != config.input_muted {
        stage.push(PushAction::InputMute { channel: ch, muted: channel.input_muted });
    }
    if differs(channel.delay_in_ms, config.delay_in_ms as f64, DELAY_STEPS) {
        stage.push(PushAction::DelayIn { channel: ch, delay_ms: channel.delay_in_ms });
    }

    // Trim and delay share one packet per family, so a difference in either
    // half sends both — which is also what the vendor does.
    let trims = [
        (SourceTrimFamily::Analog, channel.source_trims.analog, config.analog_trim_db, config.analog_delay_ms),
        (SourceTrimFamily::Dante, channel.source_trims.dante, config.dante_trim_db, config.dante_delay_ms),
    ];
    for (family, planned, live_trim, live_delay) in trims {
        if trim_differs(&planned, live_trim, live_delay) {
            stage.push(PushAction::SourceTrim {
                channel: ch,
                family,
                trim_db: planned.trim_db,
                delay_ms: planned.delay_ms,
            });
        }
    }

    // `backup_priority` is intentionally absent, even though FC=80 is now
    // implemented and reachable from the Routing tab. This push exists to
    // make the two fingerprints agree, and backup is not hashed (its trailer
    // read offset is still unverified against hardware), so a backup packet
    // here could never move the comparison. Worse, `amp_merge` does not
    // mirror backup device→project either, so the two sides can never be
    // observed to agree: every push would re-send it, and for an amp whose
    // owner never touched backup that means writing the struct default —
    // `threshold_db: 0`, i.e. "fail over immediately". Adding it belongs with
    // the fingerprint/merge change once the offset is confirmed, not before.

    // Names compare canonically: the project stores an unnamed channel as
    // `None` while the amp stores the literal default "In1", and those mean
    // the same thing. Writing an empty name is how the default is restored
    // (`decode_name_field` stops at the first NUL).
    let planned_name = canonical_input_name(index, channel.input_name.as_deref());
    if planned_name != canonical_input_name(index, config.input_name.as_deref()) {
        stage.push(PushAction::ChannelName { channel: ch, direction: EqDirection::Input, name: planned_name });
    }

    stage.finish(stages);
    Ok(())
}

fn plan_eq(
    stages: &mut Vec<PlannedStage>,
    channel: &AmpChannel,
    config: &ChannelConfig,
    ch: u8,
    direction: EqDirection,
    group: &str,
    id: String,
    label: &str,
) {
    let (planned, live, wire) = match direction {
        EqDirection::Input => (&channel.input_eq, &config.input_eq, &config.input_eq_wire),
        EqDirection::Output => (&channel.output_eq, &config.output_eq, &config.output_eq_wire),
    };
    let mut stage = StageBuilder::new(id, group, label);

    // The chain goes out whole (FC=52), so this only decides *whether* to
    // write it. The per-slot predicates are unchanged, which is what keeps a
    // band bypassed on both sides from triggering a write on its own: the
    // hash ignores such a band, so writing it could never help.
    //
    // A write does then carry every slot, including those ignored bands. That
    // is harmless — the hash still skips them — and leaves the amp holding the
    // project's values throughout instead of a mixture.
    let differs = crossover_differs(&planned.hp, &live.hp)
        || crossover_differs(&planned.lp, &live.lp)
        || planned.bands.iter().enumerate().any(|(band_index, band)| {
            // A band the amp doesn't have is out of scope: the caller rejects
            // mismatched band counts before planning.
            live.bands.get(band_index).is_some_and(|live_band| band_differs(band, live_band))
        });

    if differs {
        stage.push(PushAction::EqChain {
            channel: ch,
            direction,
            eq: planned.clone(),
            wire: wire.clone(),
        });
    }

    stage.finish(stages);
}

fn plan_matrix(
    stages: &mut Vec<PlannedStage>,
    channel: &AmpChannel,
    config: &ChannelConfig,
    ch: u8,
    group: &str,
    matrix_input_count: u32,
) -> Result<(), PushPlanError> {
    let index = channel.channel_index;
    let mut stage = StageBuilder::new(format!("matrix-{index}"), group, "Matrix");

    // Only the model's own inputs: the CVR parser always reads 4 crosspoints,
    // even on a 2-channel amp, and the hash ignores the surplus.
    for crosspoint in channel.matrix_crosspoints.iter().filter(|cp| cp.source_index < matrix_input_count) {
        let Some(live) = config.matrix_crosspoints.iter().find(|cp| cp.source_index == crosspoint.source_index) else {
            continue;
        };
        // An inactive crosspoint's gain isn't hashed, so only the flag counts
        // until one side switches it on.
        let gain_matters = crosspoint.active || live.active;
        if crosspoint.active != live.active || (gain_matters && differs(crosspoint.gain_db, live.gain_db, GAIN_STEPS)) {
            let source_index = u8::try_from(crosspoint.source_index)
                .map_err(|_| PushPlanError(format!("matrix source {} is out of range", crosspoint.source_index)))?;
            stage.push(PushAction::MatrixCrosspoint {
                channel: ch,
                source_index,
                gain_db: crosspoint.gain_db,
                active: crosspoint.active,
            });
        }
    }

    stage.finish(stages);
    Ok(())
}

/// Everything the speaker hash covers except the output EQ, which is its own
/// stage: levels, delay, polarity, power mode, FIR, noise gate and limiters.
fn plan_speaker(stages: &mut Vec<PlannedStage>, channel: &AmpChannel, config: &ChannelConfig, ch: u8, group: &str) {
    let index = channel.channel_index;
    let mut stage = StageBuilder::new(format!("speaker-{index}"), group, "Speaker");

    if differs(channel.output_trim_db, config.output_trim_db as f64, GAIN_STEPS) {
        stage.push(PushAction::OutputTrim { channel: ch, trim_db: channel.output_trim_db });
    }
    if differs(channel.output_volume_db, config.output_volume_db as f64, GAIN_STEPS) {
        stage.push(PushAction::OutputVolume { channel: ch, volume_db: channel.output_volume_db });
    }
    if channel.output_muted != config.output_muted {
        stage.push(PushAction::OutputMute { channel: ch, muted: channel.output_muted });
    }
    if differs(channel.delay_out_ms, config.delay_out_ms as f64, DELAY_STEPS) {
        stage.push(PushAction::DelayOut { channel: ch, delay_ms: channel.delay_out_ms });
    }
    if channel.output_phase_inverted != config.output_phase_inverted {
        stage.push(PushAction::PhaseInvert { channel: ch, inverted: channel.output_phase_inverted });
    }
    // `power_mode` is `None` when the amp's byte didn't match a confirmed
    // mapping. The caller refuses to push in that case (it makes the live
    // fingerprint unreadable), so this only ever writes against a known value.
    if config.power_mode != Some(channel.power_mode) {
        stage.push(PushAction::PowerMode { channel: ch, mode: channel.power_mode });
    }
    if channel.fir_bypassed != config.fir_bypassed {
        stage.push(PushAction::FirBypass { channel: ch, bypassed: channel.fir_bypassed });
    }
    // The threshold exists only where the amp reports one (1.1.9+) and, like a
    // disabled limiter's, only counts while the gate is on — the same rule the
    // hash follows. It is sent rounded, as the hash rounds it; a plain `as i8`
    // would truncate and never converge.
    let threshold_differs = config.noise_gate_threshold_dbu.is_some_and(|live| {
        channel.noise_gate_enabled && differs(channel.noise_gate_threshold_dbu, f64::from(live), WHOLE_STEPS)
    });
    if channel.noise_gate_enabled != config.noise_gate_enabled || threshold_differs {
        stage.push(PushAction::NoiseGate {
            channel: ch,
            enabled: channel.noise_gate_enabled,
            threshold_dbu: channel.noise_gate_threshold_dbu.round() as i8,
        });
    }

    let (rms, live_rms) = (&channel.limiter.rms, &config.limiter.rms);
    // A stage disabled on both sides hashes as just "off", so its stored
    // threshold/attack/release are invisible and not worth a packet.
    let rms_matters = rms.enabled || live_rms.enabled;
    if rms.enabled != live_rms.enabled
        || (rms_matters
            && (differs(rms.threshold_vrms, live_rms.threshold_vrms, VOLT_STEPS)
                || differs(rms.attack_ms, live_rms.attack_ms, WHOLE_STEPS)
                || differs(rms.release_multiplier, live_rms.release_multiplier, WHOLE_STEPS)))
    {
        stage.push(PushAction::RmsLimiter {
            channel: ch,
            enabled: rms.enabled,
            threshold_vrms: rms.threshold_vrms,
            attack_ms: rms.attack_ms,
            release_multiplier: rms.release_multiplier,
        });
    }
    // Auto is hashed only while the stage is enabled, and travels on its own
    // function code (FC=48) rather than inside the FC=55 record.
    if rms_matters && rms.auto != live_rms.auto {
        stage.push(PushAction::RmsLimiterAuto { channel: ch, auto: rms.auto });
    }

    let (peak, live_peak) = (&channel.limiter.peak, &config.limiter.peak);
    let peak_matters = peak.enabled || live_peak.enabled;
    if peak.enabled != live_peak.enabled
        || (peak_matters
            && (differs(peak.threshold_vp, live_peak.threshold_vp, VOLT_STEPS)
                || differs(peak.hold_ms, live_peak.hold_ms, WHOLE_STEPS)
                || differs(peak.release_ms, live_peak.release_ms, WHOLE_STEPS)))
    {
        stage.push(PushAction::PeakLimiter {
            channel: ch,
            enabled: peak.enabled,
            threshold_vp: peak.threshold_vp,
            hold_ms: peak.hold_ms,
            release_ms: peak.release_ms,
        });
    }

    stage.finish(stages);
}

/// The output name is its own stage because it belongs to the output group,
/// while the input name belongs to the input one.
fn plan_output_name(
    stages: &mut Vec<PlannedStage>,
    channel: &AmpChannel,
    config: &ChannelConfig,
    ch: u8,
    group: &str,
) {
    let index = channel.channel_index;
    let mut stage = StageBuilder::new(format!("name-{index}"), group, "Name");

    // Compared on the base alone: the `_XXXX` suffix is derived from the
    // speaker hash, so the fingerprint strips it rather than counting every
    // speaker change twice. The full stored name is what gets written, suffix
    // included — it is data the name carries.
    if canonical_output_name(index, channel.output_name.as_deref())
        != canonical_output_name(index, config.output_name.as_deref())
    {
        let name = channel.output_name.as_deref().map(str::trim).unwrap_or("").to_string();
        stage.push(PushAction::ChannelName { channel: ch, direction: EqDirection::Output, name });
    }

    stage.finish(stages);
}

/// One "FIR filter" stage per output whose FIR taps the amp doesn't hold.
/// Separate from `plan_push` because the amp's FIR isn't in the FC=27
/// snapshot that diffs against: `live` is the driver's FC=43 readings
/// (`LiveAmpReading.fir`). An output with no reading is left alone — the
/// caller has already refused the push, since such an amp can't be
/// fingerprinted. Compared exactly as the hash does: taps only, never the name.
pub fn plan_fir(assignment: &AmpAssignment, live: &[ChannelFirSnapshot]) -> Vec<PlannedStage> {
    let mut stages = Vec::new();
    for channel in &assignment.channels {
        let index = channel.channel_index;
        let Some(held) = live.iter().find(|f| f.channel_index == index) else { continue };
        let Ok(ch) = u8::try_from(index) else { continue };
        let mut stage = StageBuilder::new(format!("fir-{index}"), format!("Out {}", output_letter(index)), "FIR filter");
        if !channel.fir.same_taps(&held.coefficients) {
            stage.push(PushAction::FirData {
                channel: ch,
                name: channel.fir.name.clone(),
                coefficients: channel.fir.coefficients.clone(),
            });
        }
        stage.finish(&mut stages);
    }
    stages
}

// ---------------------------------------------------------------------------
// Device-determined fields
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
