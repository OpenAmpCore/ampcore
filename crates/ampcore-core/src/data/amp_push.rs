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
//! **Three fields are read-only by decision, not by protocol**: `ohms`,
//! `limiter.rms.max_vrms` and `limiter.peak.max_vp`. The vendor can write the
//! first (FC=72) and carries the other two in its 13-byte FC=54/55 records,
//! but all three describe what the hardware *is* — its load and its rated
//! output voltage — rather than what anyone plans for it. They are hashed, so
//! a push that left them differing could never converge; instead
//! `adopt_device_facts` copies them the other way as part of the same
//! transaction, and `PushPlan.adopted` lists them so the swap is visible
//! rather than silent.

use serde::Serialize;
use specta::Type;

use super::capability::{PowerMode, SourceKind};
use super::fingerprint::{
    canonical_input_name, canonical_output_name, output_letter, round_to_step, FingerprintRow, DELAY_STEPS, FREQ_STEPS,
    GAIN_STEPS, OHM_STEPS, Q_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{AmpAssignment, AmpChannel, ChannelEq, CrossoverSlot, EqBand, EqDirection, SourceTrim};
use crate::live::cvr::channel_config::{ChannelConfig, ChannelConfigSnapshot, EqChainWire};

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
/// packet(s) each one becomes are built in `commands/amp_push.rs`.
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
    // Only the on/off flag is hashed — and on 1.1.8 the threshold has no
    // readback at all, so it can never be diffed. It rides along on the same
    // packet for 1.1.9, the only firmware whose body carries it.
    if channel.noise_gate_enabled != config.noise_gate_enabled {
        stage.push(PushAction::NoiseGate {
            channel: ch,
            enabled: channel.noise_gate_enabled,
            threshold_dbu: channel.noise_gate_threshold_dbu as i8,
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

// ---------------------------------------------------------------------------
// Device-determined fields
// ---------------------------------------------------------------------------

fn row(group: &str, label: &str, project: String, live: String) -> FingerprintRow {
    let differs = project != live;
    FingerprintRow {
        group: group.to_string(),
        label: label.to_string(),
        project: Some(project),
        live: Some(live),
        differs,
        hashed: true,
    }
}

/// The hashed fields a push doesn't write, wherever the two sides disagree —
/// `ohms`, `max_vrms`, `max_vp`. Rendered under the plan so adopting the amp's
/// value is a visible consequence of pushing, not a silent edit.
pub fn adopted_rows(assignment: &AmpAssignment, snapshot: &ChannelConfigSnapshot) -> Vec<FingerprintRow> {
    let mut rows = Vec::new();
    for channel in &assignment.channels {
        let index = channel.channel_index;
        let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == index) else { continue };
        let group = format!("Out {}", output_letter(index));

        if differs(channel.ohms, config.load_ohms as f64, OHM_STEPS) {
            rows.push(row(
                &group,
                "Load",
                format!("{:.1} Ω", round_to_step(channel.ohms, OHM_STEPS)),
                format!("{:.1} Ω", round_to_step(config.load_ohms as f64, OHM_STEPS)),
            ));
        }
        // Max voltages are only hashed while their stage is enabled, so they
        // can only force a mismatch there.
        let (rms, live_rms) = (&channel.limiter.rms, &config.limiter.rms);
        if (rms.enabled || live_rms.enabled) && differs(rms.max_vrms, live_rms.max_vrms, VOLT_STEPS) {
            rows.push(row(
                &group,
                "RMS limiter max",
                format!("{:.2} V", round_to_step(rms.max_vrms, VOLT_STEPS)),
                format!("{:.2} V", round_to_step(live_rms.max_vrms, VOLT_STEPS)),
            ));
        }
        let (peak, live_peak) = (&channel.limiter.peak, &config.limiter.peak);
        if (peak.enabled || live_peak.enabled) && differs(peak.max_vp, live_peak.max_vp, VOLT_STEPS) {
            rows.push(row(
                &group,
                "Peak limiter max",
                format!("{:.2} Vp", round_to_step(peak.max_vp, VOLT_STEPS)),
                format!("{:.2} Vp", round_to_step(live_peak.max_vp, VOLT_STEPS)),
            ));
        }
    }
    rows
}

/// Copies the three read-only device facts into `assignment`, at exactly the
/// steps the hash sees (the same rule `amp_merge.rs` follows). Called as part
/// of saving a push, so the project ends up describing the amp it is linked to
/// rather than an impossible one.
pub fn adopt_device_facts(assignment: &mut AmpAssignment, snapshot: &ChannelConfigSnapshot) {
    for channel in &mut assignment.channels {
        let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == channel.channel_index) else {
            continue;
        };
        channel.ohms = round_to_step(config.load_ohms as f64, OHM_STEPS);
        channel.limiter.rms.max_vrms = round_to_step(config.limiter.rms.max_vrms, VOLT_STEPS);
        channel.limiter.peak.max_vp = round_to_step(config.limiter.peak.max_vp, VOLT_STEPS);
    }
}

#[cfg(test)]
mod tests {
    use super::super::amp_merge::mirror_live_into_assignment;
    use super::super::amp_model::{AmpModelCatalogEntry, AmpProtocol};
    use super::super::capability::cvr::builtin_topology;
    use super::super::capability::{CrossoverFilterType, EqFilterType};
    use super::super::device_link::DeviceModelLink;
    use super::super::edit_lock::LiveAmpReading;
    use super::super::fingerprint::{fingerprint_live_device, fingerprint_project_amp};
    use super::super::project::{
        BackupPriority, ChannelEq, ChannelSource, Limiter, MatrixCrosspoint, PeakLimiter, Project, RmsLimiter,
    };
    use super::*;
    use crate::live::cvr::bridge::DeviceBridgeSnapshot;
    use crate::live::cvr::channel_state::AmpChannelState;
    use crate::live::state::DiscoveredDevice;

    const MAC: &str = "6A:20:67:18:B5:8A";
    const MODEL_ID: &str = "builtin-dsp-2004";
    const DEVICE_NAME: &str = "AMP-2004-ETH";

    fn models() -> Vec<AmpModelCatalogEntry> {
        let mut entry = AmpModelCatalogEntry::new_builtin(MODEL_ID, "CVR", "DSP-2004", 4, false, AmpProtocol::CvrUdp);
        entry.topology = builtin_topology("DSP-2004", 4, false);
        vec![entry]
    }

    fn links() -> Vec<DeviceModelLink> {
        vec![DeviceModelLink {
            mac: MAC.to_string(),
            amp_model_id: MODEL_ID.to_string(),
            auto_matched: false,
            updated_at: 0.0,
        }]
    }

    /// A freshly planned DSP-2004 — every setting at its default.
    fn assignment() -> AmpAssignment {
        let mut assignment =
            AmpAssignment::new(Some(MAC.to_string()), None, 4, Some(MODEL_ID.to_string()), Some("1.1.8".to_string()));
        assignment.reconcile_matrix_size(4);
        assignment.reconcile_eq_bands(10);
        assignment
    }

    /// A value as the FC=27 parser hands it over: through `f32`.
    fn wire(value: f64) -> f64 {
        value as f32 as f64
    }


    /// The companion bytes of a chain, as the amp reports them. Non-default on
    /// purpose: a push echoes these rather than deriving them, so if
    /// `eq_chain_bands` mapped the HP/LP slots wrong the round-trip test would
    /// still pass with zeros here.
    fn live_eq_wire() -> EqChainWire {
        EqChainWire { chain_bypass: 0, hp_gain_db: 1.5, hp_q: 0.71, lp_gain_db: -2.25, lp_q: 1.41 }
    }

    fn live_eq(gain_db: f64) -> ChannelEq {
        ChannelEq {
            hp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth24, freq_hz: wire(110.0), active: true },
            bands: (0..8)
                .map(|i| EqBand {
                    filter_type: if i == 0 { EqFilterType::LowShelf } else { EqFilterType::Peaking },
                    freq_hz: wire(100.0 * (i + 1) as f64 + 0.3),
                    gain_db: wire(gain_db),
                    q: wire(0.7),
                    active: i % 3 == 0,
                })
                .collect(),
            lp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth12, freq_hz: wire(19900.0), active: false },
        }
    }

    /// A tuned channel as the amp reports it: nothing at its default.
    fn live_channel(index: u32) -> ChannelConfig {
        ChannelConfig {
            channel_index: index,
            delay_in_ms: 1.23,
            input_muted: index == 2,
            matrix_crosspoints: (0..4)
                .map(|source_index| MatrixCrosspoint {
                    source_index,
                    gain_db: wire(-3.1),
                    active: source_index == index || source_index == 0,
                })
                .collect(),
            input_eq: live_eq(12.0),
            output_eq: live_eq(-1.5),
            // Deliberately non-zero: these are echoed rather than derived, so
            // zeros here would hide a mapping bug in `eq_chain_bands`.
            input_eq_wire: live_eq_wire(),
            output_eq_wire: live_eq_wire(),
            output_trim_db: -18.0,
            output_volume_db: -20.0,
            output_muted: false,
            delay_out_ms: 7.87,
            output_phase_inverted: index == 1,
            noise_gate_enabled: index == 3,
            limiter: Limiter {
                rms: RmsLimiter {
                    enabled: true,
                    threshold_vrms: wire(56.99),
                    attack_ms: 25.0,
                    release_multiplier: 8.0,
                    auto: true,
                    max_vrms: wire(127.35),
                },
                peak: PeakLimiter {
                    enabled: true,
                    threshold_vp: wire(84.84),
                    hold_ms: 0.0,
                    release_ms: 75.0,
                    max_vp: wire(179.89),
                },
            },
            fir_bypassed: true,
            power_mode: Some(PowerMode::LowOhm),
            source: Some(ChannelSource { kind: SourceKind::Analog, index }),
            input_name: Some(format!("In{}", index + 1)),
            output_name: Some(
                match index {
                    0 => "Kick_A91C",
                    1 => "OutB",
                    _ => "TR",
                }
                .to_string(),
            ),
            analog_trim_db: 1.5,
            analog_delay_ms: 0.25,
            dante_trim_db: 0.0,
            dante_delay_ms: 0.0,
            load_ohms: 4.0,
            backup_priority: BackupPriority { enabled: true, first: 1, second: 2, threshold_db: -80 },
        }
    }

    fn snapshot() -> ChannelConfigSnapshot {
        ChannelConfigSnapshot {
            channels: (0..4).map(live_channel).collect(),
            standby: Some(false),
            standby_locked: Some(false),
            rotary_locked: Some(true),
            preset_name: Some("Lab".to_string()),
            received_at: 0.0,
        }
    }

    fn device() -> DiscoveredDevice {
        DiscoveredDevice {
            id: format!("cvr:{MAC}"),
            driver_id: "cvr".to_string(),
            brand: "CVR".to_string(),
            name: DEVICE_NAME.to_string(),
            mac: MAC.to_string(),
            ip: "192.168.1.50".to_string(),
            firmware_version: "1.1.8".to_string(),
            firmware_family: Some("1.1.8".to_string()),
            gain_max: 0,
            analog_input_channels: 4,
            digital_input_channels: 4,
            output_channels: 4,
            machine_state: 0,
            machine_state_decoded: Some(AmpChannelState::Normal),
            online: true,
            last_seen_at: 0.0,
        }
    }

    fn bridged() -> Vec<Option<bool>> {
        vec![Some(true), Some(false)]
    }

    /// The amp's side of the conversation: obeys one planned write the way the
    /// device would, so a plan can be replayed against a snapshot and the
    /// result re-fingerprinted. Any field this doesn't model would show up as
    /// a surviving difference in `push_makes_hashes_equal`.
    fn apply(
        action: &PushAction,
        snapshot: &mut ChannelConfigSnapshot,
        device_name: &mut String,
        bridged: &mut [Option<bool>],
    ) {
        let channel_of = |snapshot: &mut ChannelConfigSnapshot, ch: u8| -> usize {
            snapshot.channels.iter().position(|c| c.channel_index == u32::from(ch)).expect("channel in snapshot")
        };
        match action {
            PushAction::DeviceName { name } => *device_name = name.clone(),
            PushAction::Source { channel, kind, analog_index } => {
                let i = channel_of(snapshot, *channel);
                // Digital inputs read back 1:1 with their channel; only an
                // analog pick carries its own index (see `plan_input`).
                let index = analog_index.map(u32::from).unwrap_or(u32::from(*channel));
                snapshot.channels[i].source = Some(ChannelSource { kind: *kind, index });
            }
            PushAction::InputMute { channel, muted } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].input_muted = *muted;
            }
            PushAction::DelayIn { channel, delay_ms } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].delay_in_ms = *delay_ms as f32;
            }
            PushAction::SourceTrim { channel, family, trim_db, delay_ms } => {
                let i = channel_of(snapshot, *channel);
                let config = &mut snapshot.channels[i];
                let (trim, delay) = (*trim_db as f32, *delay_ms as f32);
                match family {
                    SourceTrimFamily::Analog => (config.analog_trim_db, config.analog_delay_ms) = (trim, delay),
                    SourceTrimFamily::Dante => (config.dante_trim_db, config.dante_delay_ms) = (trim, delay),
                }
            }
            PushAction::EqChain { channel, direction, eq, wire: chain } => {
                let i = channel_of(snapshot, *channel);
                let config = &mut snapshot.channels[i];
                let (live_eq, live_wire) = match direction {
                    EqDirection::Input => (&mut config.input_eq, &mut config.input_eq_wire),
                    EqDirection::Output => (&mut config.output_eq, &mut config.output_eq_wire),
                };
                // FC=52 replaces the whole chain, so the device ends up
                // holding every slot that was sent — including bands the hash
                // ignores. Values land as f32, which is what makes the
                // rounding in `differs` load-bearing.
                live_eq.hp = CrossoverSlot { freq_hz: wire(eq.hp.freq_hz), ..eq.hp };
                live_eq.lp = CrossoverSlot { freq_hz: wire(eq.lp.freq_hz), ..eq.lp };
                for (band_index, band) in eq.bands.iter().enumerate() {
                    // Unlike the per-band path, gain and Q are always carried
                    // — the body has no way to omit them.
                    live_eq.bands[band_index] = EqBand {
                        freq_hz: wire(band.freq_hz),
                        gain_db: wire(band.gain_db),
                        q: wire(band.q),
                        ..*band
                    };
                }
                // The companion bytes were echoed, so this must leave them
                // exactly as they were — a mapping bug in `eq_chain_bands`
                // shows up here as a changed value.
                *live_wire = chain.clone();
            }
            PushAction::MatrixCrosspoint { channel, source_index, gain_db, active } => {
                let i = channel_of(snapshot, *channel);
                let crosspoint = snapshot.channels[i]
                    .matrix_crosspoints
                    .iter_mut()
                    .find(|cp| cp.source_index == u32::from(*source_index))
                    .expect("crosspoint in snapshot");
                crosspoint.gain_db = wire(*gain_db);
                crosspoint.active = *active;
            }
            PushAction::OutputTrim { channel, trim_db } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].output_trim_db = *trim_db as f32;
            }
            PushAction::OutputVolume { channel, volume_db } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].output_volume_db = *volume_db as f32;
            }
            PushAction::OutputMute { channel, muted } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].output_muted = *muted;
            }
            PushAction::DelayOut { channel, delay_ms } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].delay_out_ms = *delay_ms as f32;
            }
            PushAction::PhaseInvert { channel, inverted } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].output_phase_inverted = *inverted;
            }
            PushAction::PowerMode { channel, mode } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].power_mode = Some(*mode);
            }
            PushAction::FirBypass { channel, bypassed } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].fir_bypassed = *bypassed;
            }
            PushAction::NoiseGate { channel, enabled, .. } => {
                let i = channel_of(snapshot, *channel);
                // 1.1.8 has no threshold readback at all, so only the flag
                // ever comes back.
                snapshot.channels[i].noise_gate_enabled = *enabled;
            }
            PushAction::RmsLimiter { channel, enabled, threshold_vrms, attack_ms, release_multiplier } => {
                let i = channel_of(snapshot, *channel);
                let rms = &mut snapshot.channels[i].limiter.rms;
                rms.enabled = *enabled;
                rms.threshold_vrms = wire(*threshold_vrms);
                // The wire narrows these to u16/u8.
                rms.attack_ms = (*attack_ms as u16) as f64;
                rms.release_multiplier = (*release_multiplier as u8) as f64;
            }
            PushAction::RmsLimiterAuto { channel, auto } => {
                let i = channel_of(snapshot, *channel);
                snapshot.channels[i].limiter.rms.auto = *auto;
            }
            PushAction::PeakLimiter { channel, enabled, threshold_vp, hold_ms, release_ms } => {
                let i = channel_of(snapshot, *channel);
                let peak = &mut snapshot.channels[i].limiter.peak;
                peak.enabled = *enabled;
                peak.threshold_vp = wire(*threshold_vp);
                peak.hold_ms = (*hold_ms as u16) as f64;
                peak.release_ms = (*release_ms as u16) as f64;
            }
            PushAction::ChannelName { channel, direction, name } => {
                let i = channel_of(snapshot, *channel);
                let config = &mut snapshot.channels[i];
                let stored = Some(name.clone());
                match direction {
                    EqDirection::Input => config.input_name = stored,
                    EqDirection::Output => config.output_name = stored,
                }
            }
            PushAction::Bridge { pair_index, bridged: value } => {
                bridged[*pair_index as usize] = Some(*value);
            }
        }
    }

    /// Replays a whole plan, stage by stage in order, the way the command does.
    fn replay(plan: &PushPlan, snapshot: &mut ChannelConfigSnapshot, name: &mut String, bridged: &mut [Option<bool>]) {
        for stage in &plan.stages {
            for action in &stage.actions {
                apply(action, snapshot, name, bridged);
            }
        }
    }

    /// The inverse of `amp_merge`'s `merge_makes_hashes_equal`, and the test
    /// that actually proves the feature: plan a push from a default project
    /// amp onto a fully tuned amp, obey every write, adopt the three
    /// device-determined fields, and the two fingerprints must agree.
    #[test]
    fn push_makes_hashes_equal() {
        let (models, links) = (models(), links());
        let project = Project::new("Test".to_string(), String::new());
        let mut assignment = assignment();
        let mut snapshot = snapshot();
        let mut name = DEVICE_NAME.to_string();
        let mut bridged = bridged();

        let before = fingerprint_project_amp(&project, &assignment, &models);
        let live_before = fingerprint_live_device(&device(), &snapshot, Some(&DeviceBridgeSnapshot { bridged: bridged.clone(), received_at: 0.0 }), &models, &links);
        assert!(live_before.missing.is_empty(), "{:?}", live_before.missing);
        assert_ne!(before.amp_hash, live_before.amp_hash, "the fixture must start out different");

        let plan = plan_push(&assignment, &snapshot, &name, &bridged, 4).expect("plan");
        assert!(!plan.stages.is_empty());
        replay(&plan, &mut snapshot, &mut name, &mut bridged);
        adopt_device_facts(&mut assignment, &snapshot);

        let mut device = device();
        device.name = name;
        let after = fingerprint_project_amp(&project, &assignment, &models);
        let live_after = fingerprint_live_device(
            &device,
            &snapshot,
            Some(&DeviceBridgeSnapshot { bridged: bridged.clone(), received_at: 0.0 }),
            &models,
            &links,
        );
        assert!(live_after.missing.is_empty(), "{:?}", live_after.missing);
        assert_eq!(after.amp_hash, live_after.amp_hash, "a fully replayed push must converge");
    }

    /// A second push against an amp that already matches must plan no work —
    /// otherwise the UI would offer a push that does nothing, forever.
    #[test]
    fn push_plan_is_empty_when_already_matching() {
        let reading = LiveAmpReading {
            device: device(),
            snapshot: Some(snapshot()),
            bridge: Some(DeviceBridgeSnapshot { bridged: bridged(), received_at: 0.0 }),
        };
        let mirrored = mirror_live_into_assignment(&assignment(), &reading, 4);
        let plan = plan_push(&mirrored, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
        assert!(plan.stages.is_empty(), "planned {:?}", plan.stages.iter().map(|s| &s.stage.id).collect::<Vec<_>>());
        assert!(plan.adopted.is_empty());
    }

    /// A band bypassed on both sides is invisible to the hash, so its stored
    /// settings must not trigger a write however far apart they are. With the
    /// chain written whole this is what keeps the predicate load-bearing: it
    /// no longer decides *which* bands go out, only whether the chain does.
    ///
    /// Starts from a mirrored assignment so the bypassed band is the *only*
    /// difference — against a default project amp half the chain differs
    /// anyway, and the chain would rightly be written for those reasons.
    #[test]
    fn bypassed_band_differences_are_skipped() {
        let reading = LiveAmpReading {
            device: device(),
            snapshot: Some(snapshot()),
            bridge: Some(DeviceBridgeSnapshot { bridged: bridged(), received_at: 0.0 }),
        };
        let mut assignment = mirror_live_into_assignment(&assignment(), &reading, 4);
        let mut snapshot = snapshot();
        for channel in &mut assignment.channels {
            channel.input_eq.bands[1].active = false;
            channel.input_eq.bands[1].freq_hz = 777.0;
        }
        for config in &mut snapshot.channels {
            config.input_eq.bands[1].active = false;
            config.input_eq.bands[1].freq_hz = 1234.0;
        }
        let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
        assert!(
            plan.stages.is_empty(),
            "a band bypassed on both sides must not trigger a chain write; planned {:?}",
            plan.stages.iter().map(|s| &s.stage.id).collect::<Vec<_>>()
        );
    }

    /// The three fields a push doesn't write are reported rather than sent.
    #[test]
    fn device_facts_are_adopted_not_pushed() {
        let mut assignment = assignment();
        assignment.channels[0].ohms = 16.0;
        let snapshot = snapshot();
        assert_ne!(assignment.channels[0].ohms, snapshot.channels[0].load_ohms as f64);

        let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
        assert!(plan.adopted.iter().any(|row| row.group == "Out A" && row.label == "Load" && row.differs));

        adopt_device_facts(&mut assignment, &snapshot);
        assert_eq!(assignment.channels[0].ohms, 4.0);
        assert_eq!(assignment.channels[0].limiter.rms.max_vrms, 127.35);
        assert_eq!(assignment.channels[0].limiter.peak.max_vp, 179.89);
    }

    /// Bridging re-pairs outputs, so it has to be the last thing written.
    #[test]
    fn bridging_is_planned_last() {
        let mut assignment = assignment();
        assignment.channels[0].output_bridged = true;
        assignment.channels[2].output_bridged = true;
        let plan = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
        assert_eq!(plan.stages.last().expect("stages").stage.id, "bridge");
    }

    /// A digital input the amp would read back differently can never converge,
    /// so it is refused at plan time instead of pushed.
    #[test]
    fn unreachable_digital_input_is_refused() {
        let mut assignment = assignment();
        assignment.channels[0].source = ChannelSource { kind: SourceKind::Dante, index: 2 };
        let error = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect_err("must refuse");
        assert!(error.0.contains("wired 1:1"), "{}", error.0);
    }

    /// The regression this change exists for: a chain that differs anywhere is
    /// one packet, not up to 38. Guards against a future refactor quietly
    /// reintroducing the per-band plan.
    #[test]
    fn a_differing_chain_costs_one_packet() {
        let mut assignment = assignment();
        // One band's gain, on one side of one channel.
        assignment.channels[0].input_eq.bands[2].gain_db = 4.5;
        assignment.channels[0].input_eq.bands[2].active = true;

        let plan = plan_push(&assignment, &snapshot(), DEVICE_NAME, &bridged(), 4).expect("plan");
        let eq_stages: Vec<_> = plan.stages.iter().filter(|s| s.stage.id == "in-eq-0").collect();
        assert_eq!(eq_stages.len(), 1);
        assert_eq!(eq_stages[0].stage.packets, 1, "a whole chain is one FC=52 write");
        assert!(matches!(
            eq_stages[0].actions.as_slice(),
            [PushAction::EqChain { direction: EqDirection::Input, .. }]
        ));
    }

    /// A whole-chain write still carries the slots the hash ignores, so after
    /// a push the amp holds the project's values throughout rather than a
    /// mixture — while convergence stays driven by the hashed ones only.
    #[test]
    fn a_chain_write_carries_every_slot() {
        let mut assignment = assignment();
        let mut snapshot = snapshot();
        // Band 2 is what triggers the write; band 1 is bypassed on both sides
        // and so invisible to the hash, but must still be sent.
        assignment.channels[0].input_eq.bands[2].gain_db = 4.5;
        assignment.channels[0].input_eq.bands[2].active = true;
        assignment.channels[0].input_eq.bands[1].active = false;
        assignment.channels[0].input_eq.bands[1].freq_hz = 777.0;
        snapshot.channels[0].input_eq.bands[1].active = false;
        snapshot.channels[0].input_eq.bands[1].freq_hz = 1234.0;

        let plan = plan_push(&assignment, &snapshot, DEVICE_NAME, &bridged(), 4).expect("plan");
        let mut name = DEVICE_NAME.to_string();
        let mut bridged = bridged();
        replay(&plan, &mut snapshot, &mut name, &mut bridged);

        assert_eq!(snapshot.channels[0].input_eq.bands[1].freq_hz, 777.0, "the ignored band went out too");
        assert_eq!(snapshot.channels[0].input_eq.bands[2].gain_db, 4.5);
    }
}
