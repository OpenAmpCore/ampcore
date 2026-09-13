use serde::{Deserialize, Serialize};
use specta::Type;

use super::capability::{CrossoverFilterType, EqFilterType, PowerMode, SourceKind};
use super::common::{new_id, now_millis};

/// Which physical input feeds a channel — a `SourceKind` alone isn't enough
/// to identify one, since a model typically exposes several physical inputs
/// per kind (e.g. 4 analog inputs on a 4-channel amp); `index` picks which
/// one (0.. the kind's `SourceChannelCount.channel_count`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSource {
    pub kind: SourceKind,
    pub index: u32,
}

/// One crosspoint in a channel's row of the input matrix — the gain/active
/// state for a single source position. `source_index` is positional (0..
/// `AmpDspTopology.matrix_input_count`), not a `SourceKind` itself, since a
/// model can have multiple sources of the same kind (e.g. 4 analog + 4 Dante
/// inputs on a Dante-equipped model).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCrosspoint {
    pub source_index: u32,
    pub gain_db: f64,
    pub active: bool,
}

/// One HP or LP crossover slot (band 0 / band 9 of the fixed 10-band chain —
/// see `EQ_BANDS_PER_CHANNEL`). No `q` field: Q is implied entirely by
/// `filter_type` (e.g. "BW-12" always means Q=1/sqrt(2), never a
/// user-settable independent value), confirmed against the old app's
/// reference UI. Has `active` — HP/LP slots are independently bypassable.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CrossoverSlot {
    pub filter_type: CrossoverFilterType,
    pub freq_hz: f64,
    pub active: bool,
}

/// One of the 8 parametric bands (bands 1-8 of the fixed 10-band chain).
/// `active` mirrors `MatrixCrosspoint.active` — lets a band be fully
/// disengaged independent of its stored gain/freq/Q.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub filter_type: EqFilterType,
    pub freq_hz: f64,
    pub gain_db: f64,
    pub q: f64,
    pub active: bool,
}

/// A full 10-band EQ chain (HP crossover + 8 parametric bands + LP
/// crossover) for one channel, one direction. `AmpChannel` holds two of
/// these (`input_eq`/`output_eq`) — Input/Output tabs' EQ sub-tabs.
/// `bands.len()` == `AmpDspTopology.eq_bands_per_channel - 2`; grown/shrunk
/// alongside `channels` whenever the assigned model's topology changes, see
/// `reconcile_eq_bands`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEq {
    pub hp: CrossoverSlot,
    pub bands: Vec<EqBand>,
    pub lp: CrossoverSlot,
}

/// Which of a channel's two independent 10-band EQ chains a command targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EqDirection {
    Input,
    Output,
}

/// Which crossover slot (band 0 or band 9) a command targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CrossoverSlotKind {
    Hp,
    Lp,
}

/// Partial update for one `EqBand` — bundled into a single struct param
/// (rather than 5 separate `Option<T>` params) because `projects_set_eq_band`
/// otherwise exceeds `tauri-specta`'s `SpectaFn` 10-parameter limit. Every
/// field `None` means "leave unchanged", same semantics as the flat
/// `Option<T>` params every other partial-update command uses.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EqBandPatch {
    pub filter_type: Option<EqFilterType>,
    pub freq_hz: Option<f64>,
    pub gain_db: Option<f64>,
    pub q: Option<f64>,
    pub active: Option<bool>,
}

/// Partial update for a `CrossoverSlot` — same bundling rationale as
/// `EqBandPatch`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CrossoverSlotPatch {
    pub filter_type: Option<CrossoverFilterType>,
    pub freq_hz: Option<f64>,
    pub active: Option<bool>,
}

/// RMS-window limiter stage — ranged by `AmpParamRanges.rms_limiter_*`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RmsLimiter {
    pub enabled: bool,
    pub threshold_vrms: f64,
    pub attack_ms: f64,
    pub release_multiplier: f64,
    /// Vendor `RMS_Limiter_Auto`. Read back, not yet editable here.
    #[serde(default)]
    pub auto: bool,
    /// Vendor `RMS_Limiter_max` (V). Read back, not yet editable here.
    #[serde(default)]
    pub max_vrms: f64,
}

/// Instantaneous peak limiter stage — ranged by `AmpParamRanges.peak_limiter_*`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PeakLimiter {
    pub enabled: bool,
    pub threshold_vp: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    /// Vendor `peak_Limiter_max` (V). Read back, not yet editable here.
    #[serde(default)]
    pub max_vp: f64,
}

/// A channel's output protection: independent RMS and Peak limiter stages,
/// ported from the old app's `limiter-panel.tsx` (both stages can be engaged
/// simultaneously, each with its own enable flag).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Limiter {
    pub rms: RmsLimiter,
    pub peak: PeakLimiter,
}

/// Partial update for a `Limiter` — bundled into a single struct param for
/// the same `SpectaFn` 10-parameter reason as `EqBandPatch`/`CrossoverSlotPatch`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LimiterPatch {
    pub rms_enabled: Option<bool>,
    pub rms_threshold_vrms: Option<f64>,
    pub rms_attack_ms: Option<f64>,
    pub rms_release_multiplier: Option<f64>,
    pub peak_enabled: Option<bool>,
    pub peak_threshold_vp: Option<f64>,
    pub peak_hold_ms: Option<f64>,
    pub peak_release_ms: Option<f64>,
}

/// One trim + delay pair for a single input source kind.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceTrim {
    pub trim_db: f64,
    pub delay_ms: f64,
}

/// Per-source gain matching (vendor `Ana/Dante/AES_gain_matching`) — each
/// source kind feeding a channel has its own trim and delay.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceTrims {
    pub analog: SourceTrim,
    pub dante: SourceTrim,
    pub aes3: SourceTrim,
}

/// Backup source switching for one channel (vendor `StruPriority`). `first`/
/// `second` are the raw source codes as stored on the amp — which kind a code
/// names depends on the model's source set, so they are not mapped here.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupPriority {
    pub enabled: bool,
    pub first: u8,
    pub second: u8,
    pub threshold_db: i32,
}

/// Per-channel config on an amp assignment. `ohms` is the channel's load
/// impedance, used by the Limiter; the amp reports its own as `load_data`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpChannel {
    pub channel_index: u32,
    pub ohms: f64,
    /// Which physical source feeds this channel's input — Routing tab.
    /// Always set: a physical input always has a source. New channels
    /// default to Analog N (1:1); older files are backfilled on load (see
    /// `CURRENT_PROJECT_SCHEMA_VERSION`).
    pub source: ChannelSource,
    /// One crosspoint per possible matrix source (0..matrix_input_count) —
    /// Matrix tab. Grown/shrunk alongside `channels` whenever the assigned
    /// model (hence its topology) changes; see `reconcile_matrix_size`.
    #[serde(default)]
    pub matrix_crosspoints: Vec<MatrixCrosspoint>,
    /// Input delay, ranged by `AmpParamRanges.delay_in_ms` — Input tab.
    #[serde(default)]
    pub delay_in_ms: f64,
    /// Whether this channel's input is muted — Input tab.
    #[serde(default)]
    pub input_muted: bool,
    /// Output trim, ranged by `AmpParamRanges.output_trim_db` — Output tab.
    #[serde(default)]
    pub output_trim_db: f64,
    /// Output volume, ranged by `AmpParamRanges.output_volume_db` — Output tab.
    #[serde(default)]
    pub output_volume_db: f64,
    /// Output delay, ranged by `AmpParamRanges.delay_out_ms` — Output tab.
    #[serde(default)]
    pub delay_out_ms: f64,
    /// Input EQ tab's 10-band chain (pre-matrix).
    #[serde(default = "default_channel_eq")]
    pub input_eq: ChannelEq,
    /// Output EQ tab's 10-band chain (post-matrix), independent of `input_eq`.
    #[serde(default = "default_channel_eq")]
    pub output_eq: ChannelEq,
    /// Output protection — RMS + Peak limiter stages, Output tab's Limiter
    /// sub-tab.
    #[serde(default = "default_limiter")]
    pub limiter: Limiter,
    /// Whether the output noise gate is engaged — Output tab. Threshold is
    /// only user-adjustable in the UI when
    /// `CvrFirmwareCapability.noise_gate_threshold` is true, but is always
    /// persisted regardless of firmware.
    #[serde(default)]
    pub noise_gate_enabled: bool,
    /// Noise gate threshold in dBu, ranged by
    /// `AmpParamRanges.noise_gate_threshold_dbu` — Output tab.
    #[serde(default)]
    pub noise_gate_threshold_dbu: f64,
    /// Output polarity/phase invert — Output tab.
    #[serde(default)]
    pub output_phase_inverted: bool,
    /// User-assigned label for this channel's input side, overriding the
    /// default "In{n}" label. `None` uses the default. Max length ranged by
    /// `AmpParamRanges.channel_name_max_length`.
    #[serde(default)]
    pub input_name: Option<String>,
    /// User-assigned label for this channel's output side, overriding the
    /// default "Out{letter}" label. `None` uses the default.
    #[serde(default)]
    pub output_name: Option<String>,
    /// Whether this channel's output is muted — Output tab. Mirrors
    /// `input_muted`.
    #[serde(default)]
    pub output_muted: bool,
    /// Whether this channel is mono-bridged with the next channel (fixed
    /// adjacent pairing: `floor(channel_index / 2)` — (0,1), (2,3), …) —
    /// Output tab. **Only meaningful on an even-indexed (pair-leader)
    /// channel with a following odd-indexed partner**; ignored/never read
    /// on odd (follower) channels or on a leader with no partner (e.g. the
    /// trailing channel of an odd-count assignment). Ported from the old
    /// app's per-pair `BridgeReadback`, adapted to a plain persisted field
    /// since this is offline planning, not a live device readback.
    #[serde(default)]
    pub output_bridged: bool,
    /// Output power/impedance mode — Output tab. Ranged by
    /// `AmpDspTopology.power_modes` (which modes the assigned model actually
    /// offers), though CVR currently offers all three unconditionally.
    #[serde(default = "default_power_mode")]
    pub power_mode: PowerMode,
    /// FIR filter bypass. Read back, not yet editable here.
    #[serde(default)]
    pub fir_bypassed: bool,
    /// Per-source trim/delay. Read back, not yet editable here.
    #[serde(default)]
    pub source_trims: SourceTrims,
    /// Backup source switching. Read back, not yet editable here.
    #[serde(default)]
    pub backup_priority: BackupPriority,
}

/// One assigned amp "slot" within a Project. `id` is independent of `mac` so
/// a slot's configuration survives a physical unit swap. `mac` starts unset
/// at creation time — a slot is planned by model/label alone; linking it to
/// a physical unit's MAC happens later via live network discovery, not by
/// manual entry.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpAssignment {
    pub id: String,
    pub mac: Option<String>,
    pub label: Option<String>,
    pub amp_model_id: Option<String>,
    /// Firmware version this slot is being planned for (e.g. "1.1.8",
    /// "1.1.9") — declared by the user at planning time, not detected, since
    /// offline planning has no live device to sniff it from. Free text
    /// (mirrors `DiscoveredDevice.firmware_family`) rather than a closed
    /// enum, since it's protocol-specific and protocols are pluggable.
    #[serde(default)]
    pub firmware_version: Option<String>,
    pub channels: Vec<AmpChannel>,
    /// The amp's user-set name (FC=60 `CUSTOMER_NAME_MODIFY`, read back via FC=0
    /// BASIC_INFO). Not yet editable here.
    #[serde(default)]
    pub device_name: Option<String>,
    /// Manual override: this amp is linked to hardware that may well be
    /// online, but the user has deliberately stepped out of the live session.
    /// The plan then edits exactly as it does for an offline amp, and nothing
    /// is written to the amp. Persisted here rather than held in the UI so it
    /// survives the amp dropping offline and coming back — the Offline banner
    /// takes over while it is away, and the Disengaged one returns with it.
    /// See `edit_lock::AmpEditLockState::Disengaged`.
    #[serde(default)]
    pub live_disengaged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub schema_version: u32,
    pub created_at: f64,
    pub updated_at: f64,
    pub amp_assignments: Vec<AmpAssignment>,
}

/// Bumped to 11 when speaker planning was removed: `AmpChannel`'s
/// `speaker_library_id`, `way_index` and `join_group_id` are gone, along with
/// the Speaker Library itself. Older files still load — serde ignores the
/// leftover fields — and `ProjectDataState::load` rewrites any file below this
/// version once, which strips them from disk.
///
/// Bumped to 12 when `AmpChannel.source` became required: files below 12 with
/// a missing/`null` source load as Analog `channelIndex` (see
/// `store::backfill_channel_sources`) and are rewritten once.
///
/// Bumped to 13 for full FC=27 coverage: limiter auto/max, and
/// `AmpChannel`/`AmpAssignment` fields for FIR bypass, per-source trims,
/// backup priority and device name. All default via serde
/// (off/zero/empty); files below 13 are rewritten once.
///
/// Bumped to 14 when dynamic EQ was dropped for all models: the schema-13
/// `AmpChannel.dynamic_eq` is gone. serde ignores the leftover field, and files
/// below 14 are rewritten once, which strips it from disk.
///
/// Bumped to 15 when the schema-13 `ChannelEq.bypassed` was dropped: CVR amps
/// have no whole-EQ bypass, only per-band active/bypassed. Same leftover-field
/// handling as 14.
///
/// Bumped to 16 when input/output channel linking was dropped for all models:
/// the schema-13 `AmpAssignment.link_input`/`link_output` are gone. Same
/// leftover-field handling as 14.
///
/// Bumped to 17 when the schema-13 `AmpChannel.knob_gain_db` was dropped: CVR
/// amps have no per-channel knob gain setting. Same leftover-field handling
/// as 14.
///
/// Bumped to 18 for `AmpAssignment.live_disengaged`, the manual "leave the amp
/// alone" override. Defaults to `false` via serde — an older file loads as
/// engaged, which is exactly how it behaved — so no custom migration is
/// needed; files below 18 are rewritten once.
pub const CURRENT_PROJECT_SCHEMA_VERSION: u32 = 18;

impl Project {
    pub fn new(name: String, description: String) -> Self {
        let now = now_millis();
        Self {
            id: new_id(),
            name,
            description,
            schema_version: CURRENT_PROJECT_SCHEMA_VERSION,
            created_at: now,
            updated_at: now,
            amp_assignments: Vec::new(),
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now_millis();
    }
}

impl AmpAssignment {
    pub fn new(
        mac: Option<String>,
        label: Option<String>,
        channel_count: u32,
        amp_model_id: Option<String>,
        firmware_version: Option<String>,
    ) -> Self {
        let channels = (0..channel_count).map(new_channel).collect();
        Self {
            id: new_id(),
            mac,
            label,
            amp_model_id,
            firmware_version,
            channels,
            device_name: None,
            live_disengaged: false,
        }
    }

    /// Grows/shrinks `channels` to match `channel_count`, preserving existing
    /// per-channel config where indices still exist — never a destructive
    /// wipe, per the amp-model-reconciliation rule in the data model plan.
    pub fn reconcile_channel_count(&mut self, channel_count: u32) {
        if self.channels.len() as u32 > channel_count {
            self.channels.truncate(channel_count as usize);
        } else {
            for channel_index in self.channels.len() as u32..channel_count {
                self.channels.push(new_channel(channel_index));
            }
        }
    }

    /// Grows/shrinks every channel's `matrix_crosspoints` to
    /// `matrix_input_count`, preserving existing crosspoint values at
    /// surviving indices — same non-destructive rule as
    /// `reconcile_channel_count`. Called whenever the assigned model (hence
    /// its resolved topology) changes. A newly added crosspoint follows the
    /// amp's natural 1:1 routing: In N → Out N active at 0 dB, the rest off.
    pub fn reconcile_matrix_size(&mut self, matrix_input_count: u32) {
        for channel in &mut self.channels {
            let channel_index = channel.channel_index;
            if channel.matrix_crosspoints.len() as u32 > matrix_input_count {
                channel.matrix_crosspoints.truncate(matrix_input_count as usize);
            } else {
                for source_index in channel.matrix_crosspoints.len() as u32..matrix_input_count {
                    channel.matrix_crosspoints.push(MatrixCrosspoint {
                        source_index,
                        gain_db: 0.0,
                        active: source_index == channel_index,
                    });
                }
            }
        }
    }

    /// Grows/shrinks every channel's `input_eq.bands`/`output_eq.bands` to
    /// `eq_bands_per_channel - 2` (2 slots reserved for hp/lp), preserving
    /// existing band values at surviving indices — same non-destructive rule
    /// as `reconcile_matrix_size`. For CVR this is a no-op today
    /// (`eq_bands_per_channel` is a constant 10), but stays correct the
    /// moment a differently-shaped model/protocol shows up.
    pub fn reconcile_eq_bands(&mut self, eq_bands_per_channel: u32) {
        let target = eq_bands_per_channel.saturating_sub(2);
        for channel in &mut self.channels {
            reconcile_bands(&mut channel.input_eq.bands, target);
            reconcile_bands(&mut channel.output_eq.bands, target);
        }
    }
}

fn new_channel(channel_index: u32) -> AmpChannel {
    AmpChannel {
        channel_index,
        ohms: 8.0,
        // Every built-in CVR model has one analog input per channel
        // (`capability::cvr::builtin_topology`), so Analog N is always in range.
        source: ChannelSource { kind: SourceKind::Analog, index: channel_index },
        matrix_crosspoints: Vec::new(),
        delay_in_ms: 0.0,
        input_muted: false,
        output_trim_db: 0.0,
        output_volume_db: 0.0,
        delay_out_ms: 0.0,
        input_eq: default_channel_eq(),
        output_eq: default_channel_eq(),
        limiter: default_limiter(),
        noise_gate_enabled: false,
        noise_gate_threshold_dbu: 0.0,
        output_phase_inverted: false,
        input_name: None,
        output_name: None,
        output_muted: false,
        output_bridged: false,
        power_mode: default_power_mode(),
        fir_bypassed: false,
        source_trims: SourceTrims::default(),
        backup_priority: BackupPriority::default(),
    }
}

fn default_power_mode() -> PowerMode {
    PowerMode::LowOhm
}

/// Both stages disabled by default, with in-range starting values so the
/// Limiter sub-tab never opens showing an out-of-range number.
fn default_limiter() -> Limiter {
    Limiter {
        rms: RmsLimiter {
            enabled: false,
            threshold_vrms: 100.0,
            attack_ms: 5.0,
            release_multiplier: 4.0,
            auto: false,
            max_vrms: 0.0,
        },
        peak: PeakLimiter { enabled: false, threshold_vp: 140.0, hold_ms: 10.0, release_ms: 50.0, max_vp: 0.0 },
    }
}

/// One octave apart, 100Hz.. — an arbitrary but reasonable starting spread
/// across the audible range for the 8 parametric bands. Index beyond the
/// table (only possible on a hypothetical non-CVR model with >8 parametric
/// bands) falls back to 1kHz.
const DEFAULT_BAND_FREQS_HZ: [f64; 8] = [100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0, 6400.0, 12800.0];

fn default_eq_band(index: u32) -> EqBand {
    EqBand {
        filter_type: EqFilterType::Peaking,
        freq_hz: DEFAULT_BAND_FREQS_HZ.get(index as usize).copied().unwrap_or(1000.0),
        gain_db: 0.0,
        q: 1.0,
        active: false,
    }
}

/// Grows/shrinks a parametric-band `Vec` to `target` length, preserving
/// existing values at surviving indices — the shared worker behind
/// `AmpAssignment::reconcile_eq_bands`.
fn reconcile_bands(bands: &mut Vec<EqBand>, target: u32) {
    if bands.len() as u32 > target {
        bands.truncate(target as usize);
    } else {
        for index in bands.len() as u32..target {
            bands.push(default_eq_band(index));
        }
    }
}

/// Flat-response default for a freshly-created channel's EQ chain (both
/// `new_channel` and the `#[serde(default = ...)]` backfill for old project
/// files use this): HP/LP bypassed (`active: false`) at Butterworth-12
/// (Q implied by filter type — see `CrossoverSlot`), all 8 parametric bands
/// at 0dB/inactive.
fn default_channel_eq() -> ChannelEq {
    ChannelEq {
        hp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth12, freq_hz: 20.0, active: false },
        bands: (0..8).map(default_eq_band).collect(),
        lp: CrossoverSlot { filter_type: CrossoverFilterType::Butterworth12, freq_hz: 20000.0, active: false },
    }
}
