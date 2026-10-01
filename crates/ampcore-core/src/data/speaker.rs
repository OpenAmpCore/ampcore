//! The speaker library: named, reusable output processing that a project
//! output can be set up from.
//!
//! The library is this machine's, not the project's. A project output only
//! holds a `SpeakerRef` beside its ordinary values, so a project opens and
//! pushes the same with or without the library. Whether an output still holds
//! what its library way says is a plain value comparison (`speaker_states`) —
//! nothing is hashed or stamped into the amp.
//!
//! What a way carries is `SpeakerProcessing`: the whole output side of a
//! channel — output EQ, both limiter stages, delay, polarity, trim, volume,
//! mute, noise gate, power mode, load and FIR bypass. Fields after polarity
//! are `Option`: a preset that lacks one (an imported blob, an older way)
//! leaves the amp's own value. `fit` adapts a way to the target amp's
//! capability and reports what it had to drop or clamp. Left out:
//! - FIR coefficients: the project stores none. The raw FC=57 blob is kept
//!   (`SpeakerWay.fc57_hex`) for a later live pass that can write it whole;
//! - limiter `auto`/`max_*`: the maxima describe the amp, not the speaker
//!   (the same rule as `channel_clipboard.rs`);
//! - output name and bridging: wiring, not speaker.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::amp_push::PushAction;
use super::capability::{AmpCapability, ParamRange, PowerMode};
use super::common::{new_id, now_millis};
use super::fingerprint::{
    canonical_eq, format_band, format_crossover, round_to_step, DELAY_STEPS, GAIN_STEPS, OHM_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{AmpAssignment, AmpChannel, ChannelEq, EqDirection, Limiter, SpeakerRef};
use crate::live::cvr::channel_config::ChannelConfig;
use crate::live::cvr::speaker_data::{decode_speaker_data, hex_to_bytes, SpeakerData};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProcessing {
    pub output_eq: ChannelEq,
    pub limiter: Limiter,
    pub delay_out_ms: f64,
    pub phase_inverted: bool,
    // The rest of the output. `None` = not in this preset (an imported blob,
    // or a way saved before these existed): the amp keeps its own value.
    #[serde(default)]
    pub output_trim_db: Option<f64>,
    #[serde(default)]
    pub output_volume_db: Option<f64>,
    #[serde(default)]
    pub output_muted: Option<bool>,
    #[serde(default)]
    pub noise_gate_enabled: Option<bool>,
    #[serde(default)]
    pub noise_gate_threshold_dbu: Option<f64>,
    #[serde(default)]
    pub power_mode: Option<PowerMode>,
    #[serde(default)]
    pub ohms: Option<f64>,
    #[serde(default)]
    pub fir_bypassed: Option<bool>,
}

/// `v` limited to `range`; a change is reported as `label: before → after`.
fn clamp(issues: &mut Vec<String>, label: &str, unit: &str, v: f64, range: ParamRange) -> f64 {
    let c = v.clamp(range.min, range.max);
    if (c - v).abs() > 1e-6 {
        issues.push(format!("{label}: {v:.2} → {c:.2}{unit}"));
    }
    c
}

impl SpeakerProcessing {
    pub fn from_channel(channel: &AmpChannel) -> Self {
        Self {
            output_eq: channel.output_eq.clone(),
            limiter: channel.limiter,
            delay_out_ms: channel.delay_out_ms,
            phase_inverted: channel.output_phase_inverted,
            output_trim_db: Some(channel.output_trim_db),
            output_volume_db: Some(channel.output_volume_db),
            output_muted: Some(channel.output_muted),
            noise_gate_enabled: Some(channel.noise_gate_enabled),
            noise_gate_threshold_dbu: Some(channel.noise_gate_threshold_dbu),
            power_mode: Some(channel.power_mode),
            ohms: Some(channel.ohms),
            fir_bypassed: Some(channel.fir_bypassed),
        }
    }

    /// The peak floor (`Vp >= √2 · Vrms`, the rule every limiter edit keeps)
    /// is applied here, once, so the library holds exactly what an apply
    /// writes and status compares like with like.
    pub fn from_speaker_data(data: &SpeakerData) -> Self {
        let mut limiter = data.limiter;
        limiter.peak.threshold_vp = limiter.peak.threshold_vp.max(limiter.rms.threshold_vrms * std::f64::consts::SQRT_2);
        Self {
            output_eq: data.eq.clone(),
            limiter,
            delay_out_ms: data.delay_ms as f64,
            phase_inverted: data.phase_inverted,
            output_muted: Some(data.muted),
            ohms: Some(data.load_ohms as f64).filter(|v| *v > 0.0),
            fir_bypassed: Some(data.fir_bypassed),
            // ponytail: the blob's volume is left out until hardware confirms
            // whether it is the output volume or the trim.
            output_trim_db: None,
            output_volume_db: None,
            noise_gate_enabled: None,
            noise_gate_threshold_dbu: None,
            power_mode: None,
        }
    }

    /// What applying this way to `current` can actually write on an amp with
    /// capability `cap`, plus a line for everything that differs from the way
    /// as stored: bands the amp doesn't have, bands the preset doesn't have
    /// (the amp's stay), and values clamped into the amp's ranges. `Err` when
    /// the amp can't take a speaker at all. Disabled stages and bypassed
    /// bands are fitted silently: their values don't reach the sound.
    ///
    /// ponytail: model-wide ranges only; the channel's own hardware maxima
    /// (`max_vrms`/`max_vp`) are not used. Add them when a real amp clamps.
    pub fn fit(&self, current: &AmpChannel, cap: &AmpCapability) -> Result<(SpeakerProcessing, Vec<String>), String> {
        if !cap.firmware.speaker_management {
            return Err("This amp's firmware has no speaker management".into());
        }
        let r = &cap.param_ranges;
        let mut issues = Vec::new();
        let mut quiet = Vec::new();
        let mut out = self.clone();

        for (label, slot) in [("EQ · HP", &mut out.output_eq.hp), ("EQ · LP", &mut out.output_eq.lp)] {
            let to = if slot.active { &mut issues } else { &mut quiet };
            slot.freq_hz = clamp(to, &format!("{label} freq"), " Hz", slot.freq_hz, r.crossover_freq_hz);
        }

        let have = current.output_eq.bands.len();
        for (i, band) in out.output_eq.bands.iter_mut().enumerate().take(have) {
            let to = if band.active { &mut issues } else { &mut quiet };
            let n = i + 1;
            band.freq_hz = clamp(to, &format!("EQ · Band {n} freq"), " Hz", band.freq_hz, r.crossover_freq_hz);
            band.gain_db = clamp(to, &format!("EQ · Band {n} gain"), " dB", band.gain_db, r.eq_band_gain_db);
            band.q = clamp(to, &format!("EQ · Band {n} Q"), "", band.q, r.eq_band_q);
        }
        for (i, band) in self.output_eq.bands.iter().enumerate().skip(have) {
            if band.active {
                issues.push(format!("EQ · Band {}: dropped, the amp has {have} bands", i + 1));
            }
        }
        out.output_eq.bands.truncate(have);
        for i in out.output_eq.bands.len()..have {
            out.output_eq.bands.push(current.output_eq.bands[i]);
            issues.push(format!("EQ · Band {}: not in the preset, the amp's band stays", i + 1));
        }

        let rms = &mut out.limiter.rms;
        let to = if rms.enabled { &mut issues } else { &mut quiet };
        rms.threshold_vrms = clamp(to, "RMS limiter threshold", " Vrms", rms.threshold_vrms, r.rms_limiter_threshold_vrms);
        rms.attack_ms = clamp(to, "RMS limiter attack", " ms", rms.attack_ms, r.rms_limiter_attack_ms);
        rms.release_multiplier = clamp(to, "RMS limiter release", "×", rms.release_multiplier, r.rms_limiter_release_multiplier);
        let peak = &mut out.limiter.peak;
        let to = if peak.enabled { &mut issues } else { &mut quiet };
        peak.threshold_vp = clamp(to, "Peak limiter threshold", " Vp", peak.threshold_vp, r.peak_limiter_threshold_vp);
        peak.hold_ms = clamp(to, "Peak limiter hold", " ms", peak.hold_ms, r.peak_limiter_hold_ms);
        peak.release_ms = clamp(to, "Peak limiter release", " ms", peak.release_ms, r.peak_limiter_release_ms);
        // The limiter editor's own rule: peak power at least double the RMS power.
        let floor = out.limiter.rms.threshold_vrms * std::f64::consts::SQRT_2;
        if out.limiter.peak.threshold_vp < floor {
            if out.limiter.peak.enabled {
                issues.push(format!("Peak limiter threshold: {:.2} → {:.2} Vp (at least √2 × RMS)", out.limiter.peak.threshold_vp, floor));
            }
            out.limiter.peak.threshold_vp = floor;
        }
        out.delay_out_ms = clamp(&mut issues, "Delay", " ms", out.delay_out_ms, r.delay_out_ms);

        // The rest of the output: what the amp can't hold is dropped (its own
        // value stays), and what the preset lacks is the amp's own, so the
        // result is always a complete output.
        let fw = &cap.firmware;
        if !fw.noise_gate_threshold {
            if let Some(t) = out.noise_gate_threshold_dbu.filter(|t| (t - current.noise_gate_threshold_dbu).abs() > 1e-6) {
                issues.push(format!("Noise gate threshold: {t:.0} dBu dropped, this firmware has none"));
            }
            out.noise_gate_threshold_dbu = None;
        }
        if !fw.fir_filters && out.fir_bypassed.is_some_and(|b| b != current.fir_bypassed) {
            issues.push("FIR bypass: dropped, this firmware has no FIR".into());
            out.fir_bypassed = None;
        }
        let modes = &cap.topology.power_modes;
        if let Some(mode) = out.power_mode.filter(|m| !modes.is_empty() && !modes.contains(m)) {
            issues.push(format!("Power mode: {mode:?} dropped, this amp has no such mode"));
            out.power_mode = None;
        }
        out.output_trim_db = out.output_trim_db.map(|v| clamp(&mut issues, "Output trim", " dB", v, r.output_trim_db));
        out.output_volume_db = out.output_volume_db.map(|v| clamp(&mut issues, "Output volume", " dB", v, r.output_volume_db));
        out.noise_gate_threshold_dbu =
            out.noise_gate_threshold_dbu.map(|v| clamp(&mut issues, "Noise gate threshold", " dBu", v, r.noise_gate_threshold_dbu));
        let own = SpeakerProcessing::from_channel(current);
        out.output_trim_db = out.output_trim_db.or(own.output_trim_db);
        out.output_volume_db = out.output_volume_db.or(own.output_volume_db);
        out.output_muted = out.output_muted.or(own.output_muted);
        out.noise_gate_enabled = out.noise_gate_enabled.or(own.noise_gate_enabled);
        out.noise_gate_threshold_dbu = out.noise_gate_threshold_dbu.or(own.noise_gate_threshold_dbu);
        out.power_mode = out.power_mode.or(own.power_mode);
        out.ohms = out.ohms.or(own.ohms);
        out.fir_bypassed = out.fir_bypassed.or(own.fir_bypassed);
        Ok((out, issues))
    }

    /// Writes this way into a project output. The channel keeps its own
    /// limiter `auto` and maxima — they describe the amp, not the speaker.
    pub fn apply_to(&self, channel: &mut AmpChannel) {
        let (rms, peak) = (&mut channel.limiter.rms, &mut channel.limiter.peak);
        *rms = super::project::RmsLimiter { auto: rms.auto, max_vrms: rms.max_vrms, ..self.limiter.rms };
        *peak = super::project::PeakLimiter { max_vp: peak.max_vp, ..self.limiter.peak };
        channel.output_eq = self.output_eq.clone();
        channel.delay_out_ms = self.delay_out_ms;
        channel.output_phase_inverted = self.phase_inverted;
        if let Some(v) = self.output_trim_db { channel.output_trim_db = v; }
        if let Some(v) = self.output_volume_db { channel.output_volume_db = v; }
        if let Some(v) = self.output_muted { channel.output_muted = v; }
        if let Some(v) = self.noise_gate_enabled { channel.noise_gate_enabled = v; }
        if let Some(v) = self.noise_gate_threshold_dbu { channel.noise_gate_threshold_dbu = v; }
        if let Some(v) = self.power_mode { channel.power_mode = v; }
        if let Some(v) = self.ohms { channel.ohms = v; }
        if let Some(v) = self.fir_bypassed { channel.fir_bypassed = v; }
    }

    /// The writes that make a live channel hold this way, planned from one
    /// snapshot so no stage depends on a reading the others just changed.
    pub fn live_actions(&self, config: &ChannelConfig) -> Result<Vec<PushAction>, String> {
        if self.output_eq.bands.len() != config.output_eq.bands.len() {
            return Err(format!(
                "The speaker has {} EQ bands, this channel has {}",
                self.output_eq.bands.len(),
                config.output_eq.bands.len()
            ));
        }
        let channel = config.channel_index as u8;
        let (rms, peak) = (&self.limiter.rms, &self.limiter.peak);
        Ok(vec![
            PushAction::EqChain {
                channel,
                direction: EqDirection::Output,
                eq: self.output_eq.clone(),
                wire: config.output_eq_wire.clone(),
            },
            PushAction::RmsLimiter {
                channel,
                enabled: rms.enabled,
                threshold_vrms: rms.threshold_vrms,
                attack_ms: rms.attack_ms,
                release_multiplier: rms.release_multiplier,
            },
            PushAction::PeakLimiter {
                channel,
                enabled: peak.enabled,
                threshold_vp: peak.threshold_vp,
                hold_ms: peak.hold_ms,
                release_ms: peak.release_ms,
            },
            PushAction::DelayOut { channel, delay_ms: self.delay_out_ms },
            PushAction::PhaseInvert { channel, inverted: self.phase_inverted },
        ]
        .into_iter()
        .chain(self.output_trim_db.map(|trim_db| PushAction::OutputTrim { channel, trim_db }))
        .chain(self.output_volume_db.map(|volume_db| PushAction::OutputVolume { channel, volume_db }))
        .chain(self.output_muted.map(|muted| PushAction::OutputMute { channel, muted }))
        .chain(self.noise_gate_enabled.map(|enabled| PushAction::NoiseGate {
            channel,
            enabled,
            threshold_dbu: self.noise_gate_threshold_dbu.or(config.noise_gate_threshold_dbu.map(f64::from)).unwrap_or(0.0).round()
                as i8,
        }))
        .chain(self.power_mode.map(|mode| PushAction::PowerMode { channel, mode }))
        .chain(self.fir_bypassed.map(|bypassed| PushAction::FirBypass { channel, bypassed }))
        .collect())
    }

    /// Labelled, display-ready values, compared entry by entry. Uses the
    /// fingerprint's rounding and formatting, so "equal" here means what it
    /// means to push and the fingerprint.
    pub fn entries(&self) -> Vec<(String, String)> {
        let eq = canonical_eq(&self.output_eq);
        let mut out = vec![("EQ · HP".to_string(), format_crossover(&eq.hp))];
        for (i, band) in eq.bands.iter().enumerate() {
            out.push((format!("EQ · Band {}", i + 1), format_band(band)));
        }
        out.push(("EQ · LP".to_string(), format_crossover(&eq.lp)));

        let rms = &self.limiter.rms;
        out.push((
            "RMS limiter".to_string(),
            if rms.enabled {
                format!(
                    "{:.2} Vrms · {} ms · ×{}",
                    round_to_step(rms.threshold_vrms, VOLT_STEPS),
                    round_to_step(rms.attack_ms, WHOLE_STEPS),
                    round_to_step(rms.release_multiplier, WHOLE_STEPS)
                )
            } else {
                "off".to_string()
            },
        ));
        let peak = &self.limiter.peak;
        out.push((
            "Peak limiter".to_string(),
            if peak.enabled {
                format!(
                    "{:.2} Vp · {} ms · {} ms",
                    round_to_step(peak.threshold_vp, VOLT_STEPS),
                    round_to_step(peak.hold_ms, WHOLE_STEPS),
                    round_to_step(peak.release_ms, WHOLE_STEPS)
                )
            } else {
                "off".to_string()
            },
        ));
        out.push(("Delay".to_string(), format!("{:.2} ms", round_to_step(self.delay_out_ms, DELAY_STEPS))));
        out.push(("Polarity".to_string(), if self.phase_inverted { "inverted" } else { "normal" }.to_string()));
        let show = |v: Option<String>| v.unwrap_or_else(|| "—".to_string());
        let on_off = |b: bool| if b { "on" } else { "off" }.to_string();
        out.push(("Output trim".into(), show(self.output_trim_db.map(|v| format!("{:.2} dB", round_to_step(v, GAIN_STEPS))))));
        out.push(("Output volume".into(), show(self.output_volume_db.map(|v| format!("{:.2} dB", round_to_step(v, GAIN_STEPS))))));
        out.push(("Output mute".into(), show(self.output_muted.map(on_off))));
        out.push(("Noise gate".into(), show(self.noise_gate_enabled.map(on_off))));
        out.push(("Noise gate threshold".into(), show(self.noise_gate_threshold_dbu.map(|v| format!("{v:.0} dBu")))));
        out.push(("Power mode".into(), show(self.power_mode.map(|m| format!("{m:?}")))));
        out.push(("Load".into(), show(self.ohms.map(|v| format!("{:.1} Ω", round_to_step(v, OHM_STEPS))))));
        out.push(("FIR".into(), show(self.fir_bypassed.map(|b| if b { "bypassed" } else { "active" }.to_string()))));
        out
    }

    /// Labels of every entry where `self` and `other` differ.
    pub fn differences(&self, other: &SpeakerProcessing) -> Vec<String> {
        let (a, b) = (self.entries(), other.entries());
        if a.len() != b.len() {
            return vec!["EQ bands".to_string()];
        }
        // "—" is a field `self` doesn't carry: nothing to compare.
        a.into_iter().zip(b).filter(|(x, y)| x.1 != "—" && x.1 != y.1).map(|(x, _)| x.0).collect()
    }
}

/// The old app's speaker preset file (`speaker.ways[].deviceData.hex`), as far
/// as import needs it. Everything else in the file is ignored.
#[derive(Debug, Deserialize)]
pub struct OldProfile {
    speaker: OldSpeaker,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldSpeaker {
    #[serde(default)]
    brand: String,
    #[serde(default)]
    family: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    application: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    ways: Vec<OldWay>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OldWay {
    #[serde(default)]
    label: String,
    device_data: Option<OldDeviceData>,
}

#[derive(Debug, Deserialize)]
struct OldDeviceData {
    #[serde(default)]
    hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerWay {
    pub label: String,
    pub processing: SpeakerProcessing,
    /// The way's FC=57 blob as imported, hex — lossless (FIR, volume, DEQ),
    /// kept for a later live write. `None` for a way saved from an output.
    #[serde(default)]
    pub fc57_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerLibraryEntry {
    pub id: String,
    pub brand: String,
    pub family: String,
    pub model: String,
    pub application: String,
    pub notes: String,
    /// Bumped whenever a way's processing changes, never for metadata, so
    /// outputs set up from an older revision can say so.
    pub revision: u32,
    pub ways: Vec<SpeakerWay>,
    pub created_at: f64,
    pub updated_at: f64,
}

/// The user-editable metadata of an entry. `way_labels` must have one label
/// per way.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerDetails {
    pub brand: String,
    pub family: String,
    pub model: String,
    pub application: String,
    pub notes: String,
    pub way_labels: Vec<String>,
}

impl SpeakerDetails {
    fn validate(&self, way_count: usize) -> Result<(), String> {
        if self.brand.trim().is_empty() || self.model.trim().is_empty() {
            return Err("Brand and model are required".into());
        }
        if self.way_labels.len() != way_count {
            return Err(format!("{} way labels for {way_count} ways", self.way_labels.len()));
        }
        Ok(())
    }
}

fn way_label(labels: &[String], index: usize, way_count: usize) -> String {
    match labels.get(index).map(|l| l.trim()).filter(|l| !l.is_empty()) {
        Some(label) => label.to_string(),
        None if way_count == 1 => "Full".to_string(),
        None => format!("Way {}", index + 1),
    }
}

impl SpeakerLibraryEntry {
    pub fn new(details: SpeakerDetails, processing: Vec<SpeakerProcessing>) -> Result<Self, String> {
        details.validate(processing.len())?;
        let now = now_millis();
        let count = processing.len();
        Ok(Self {
            id: new_id(),
            ways: processing
                .into_iter()
                .enumerate()
                .map(|(i, processing)| SpeakerWay {
                    label: way_label(&details.way_labels, i, count),
                    processing,
                    fc57_hex: None,
                })
                .collect(),
            brand: details.brand.trim().to_string(),
            family: details.family.trim().to_string(),
            model: details.model.trim().to_string(),
            application: details.application.trim().to_string(),
            notes: details.notes.trim().to_string(),
            revision: 1,
            created_at: now,
            updated_at: now,
        })
    }

    /// Builds an entry from the old app's speaker preset file. Only the raw
    /// FC=57 blob (`deviceData.hex`) is read: the file's own `parsed` copy
    /// reads the HP/LP slots with EQ codes, which is wrong.
    pub fn from_profile(profile: &OldProfile) -> Result<Self, String> {
        let s = &profile.speaker;
        if s.ways.is_empty() {
            return Err("no ways in this preset file".into());
        }
        let (blobs, processing): (Vec<_>, Vec<_>) = s
            .ways
            .iter()
            .enumerate()
            .map(|(i, way)| {
                let hex = way.device_data.as_ref().map_or("", |d| d.hex.as_str());
                let blob = hex_to_bytes(hex).map_err(|e| format!("way {}: {e}", i + 1))?;
                let data = decode_speaker_data(&blob).map_err(|e| format!("way {}: {e}", i + 1))?;
                Ok((blob, SpeakerProcessing::from_speaker_data(&data)))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .unzip();
        let or_unknown = |v: &str| if v.trim().is_empty() { "Unknown".to_string() } else { v.to_string() };
        let details = SpeakerDetails {
            brand: or_unknown(&s.brand),
            family: s.family.clone(),
            model: or_unknown(&s.model),
            application: s.application.clone(),
            notes: s.notes.clone(),
            way_labels: s.ways.iter().map(|w| w.label.clone()).collect(),
        };
        let mut entry = Self::new(details, processing)?;
        for (way, blob) in entry.ways.iter_mut().zip(&blobs) {
            way.fc57_hex = Some(blob.iter().map(|b| format!("{b:02x}")).collect());
        }
        Ok(entry)
    }

    pub fn set_details(&mut self, details: SpeakerDetails) -> Result<(), String> {
        details.validate(self.ways.len())?;
        let count = self.ways.len();
        for (i, way) in self.ways.iter_mut().enumerate() {
            way.label = way_label(&details.way_labels, i, count);
        }
        self.brand = details.brand.trim().to_string();
        self.family = details.family.trim().to_string();
        self.model = details.model.trim().to_string();
        self.application = details.application.trim().to_string();
        self.notes = details.notes.trim().to_string();
        self.updated_at = now_millis();
        Ok(())
    }

    /// Replaces one way's processing and bumps the revision.
    pub fn set_way_processing(&mut self, way_index: u32, processing: SpeakerProcessing) -> Result<(), String> {
        let way = self.ways.get_mut(way_index as usize).ok_or("No such way")?;
        way.processing = processing;
        way.fc57_hex = None; // no longer what the blob says
        self.revision += 1;
        self.updated_at = now_millis();
        Ok(())
    }

    pub fn reference(&self, way_index: u32) -> Result<SpeakerRef, String> {
        let way = self.ways.get(way_index as usize).ok_or("No such way")?;
        let name = format!("{} {}", self.brand, self.model);
        Ok(SpeakerRef {
            library_id: self.id.clone(),
            way_index,
            revision: self.revision,
            label: if self.ways.len() == 1 { name } else { format!("{name} · {}", way.label) },
        })
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeakerStatus {
    /// The output holds exactly what its library way says.
    Match,
    /// The output was changed after it was set up.
    Edited { fields: Vec<String> },
    /// The library way changed after the output was set up. `fields` is what
    /// re-applying would change (empty when only the revision moved).
    LibraryUpdated { fields: Vec<String> },
    /// The entry or way is gone from this machine's library.
    Detached,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSpeakerState {
    pub channel_index: u32,
    pub speaker: SpeakerRef,
    pub status: SpeakerStatus,
}

pub fn speaker_status(channel: &AmpChannel, speaker: &SpeakerRef, library: &[SpeakerLibraryEntry]) -> SpeakerStatus {
    let Some(entry) = library.iter().find(|e| e.id == speaker.library_id) else {
        return SpeakerStatus::Detached;
    };
    let Some(way) = entry.ways.get(speaker.way_index as usize) else {
        return SpeakerStatus::Detached;
    };
    let fields = way.processing.differences(&SpeakerProcessing::from_channel(channel));
    if entry.revision != speaker.revision {
        SpeakerStatus::LibraryUpdated { fields }
    } else if fields.is_empty() {
        SpeakerStatus::Match
    } else {
        SpeakerStatus::Edited { fields }
    }
}

/// One state per output that has a speaker.
pub fn speaker_states(assignment: &AmpAssignment, library: &[SpeakerLibraryEntry]) -> Vec<ChannelSpeakerState> {
    assignment
        .channels
        .iter()
        .filter_map(|channel| {
            let speaker = channel.speaker.as_ref()?;
            Some(ChannelSpeakerState {
                channel_index: channel.channel_index,
                speaker: speaker.clone(),
                status: speaker_status(channel, speaker, library),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> AmpChannel {
        AmpAssignment::new(None, None, 2, None, None).channels[0].clone()
    }

    fn details(ways: usize) -> SpeakerDetails {
        SpeakerDetails {
            brand: "Seeburg".into(),
            family: "PS1".into(),
            model: "Hi".into(),
            application: String::new(),
            notes: String::new(),
            way_labels: (0..ways).map(|i| format!("W{i}")).collect(),
        }
    }

    #[test]
    fn status_follows_values_and_revision() {
        let mut ch = channel();
        ch.delay_out_ms = 2.5;
        let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&ch)]).unwrap();
        let speaker = entry.reference(0).unwrap();
        assert_eq!(speaker.label, "Seeburg Hi");
        let library = vec![entry.clone()];
        assert!(matches!(speaker_status(&ch, &speaker, &library), SpeakerStatus::Match));

        // f32 wire rounding must not read as an edit.
        ch.delay_out_ms = 2.5 + 1e-9;
        assert!(matches!(speaker_status(&ch, &speaker, &library), SpeakerStatus::Match));

        ch.output_eq.bands[2].gain_db += 1.5;
        ch.output_eq.bands[2].active = true;
        match speaker_status(&ch, &speaker, &library) {
            SpeakerStatus::Edited { fields } => assert_eq!(fields, ["EQ · Band 3"]),
            other => panic!("{other:?}"),
        }

        entry.set_way_processing(0, SpeakerProcessing::from_channel(&ch)).unwrap();
        match speaker_status(&ch, &speaker, &[entry.clone()]) {
            SpeakerStatus::LibraryUpdated { fields } => assert!(fields.is_empty()),
            other => panic!("{other:?}"),
        }

        assert!(matches!(speaker_status(&ch, &speaker, &[]), SpeakerStatus::Detached));
    }

    /// A way whose peak sits below the floor used to read "Edited" forever:
    /// apply raised it, the library didn't.
    #[test]
    fn imported_way_applies_to_match() {
        let mut data = crate::live::cvr::speaker_data::decode_speaker_data(&vec![0u8; 2310]).unwrap();
        data.limiter.rms.threshold_vrms = 50.0;
        data.limiter.peak.threshold_vp = 60.0;
        data.limiter.peak.enabled = true;
        let processing = SpeakerProcessing::from_speaker_data(&data);
        assert!((processing.limiter.peak.threshold_vp - 50.0 * std::f64::consts::SQRT_2).abs() < 1e-9, "floored on import");
        let entry = SpeakerLibraryEntry::new(details(1), vec![processing.clone()]).unwrap();
        let mut ch = channel();
        processing.apply_to(&mut ch);
        let speaker = entry.reference(0).unwrap();
        assert!(matches!(speaker_status(&ch, &speaker, &[entry]), SpeakerStatus::Match));
    }

    fn capability(firmware: &str) -> AmpCapability {
        let model = crate::data::test_fixtures::models().remove(0);
        crate::data::capability::resolve(&model, Some(firmware))
    }

    fn profile_json(ways: &[&str]) -> String {
        let ways: Vec<String> = ways
            .iter()
            .enumerate()
            .map(|(i, hex)| format!(r#"{{"label":"W{i}","deviceData":{{"hex":"{hex}"}}}}"#))
            .collect();
        format!(r#"{{"speaker":{{"brand":"Seeburg","model":"Hi","ways":[{}]}}}}"#, ways.join(","))
    }

    #[test]
    fn imports_old_profile_files() {
        let hex = "00".repeat(2310);
        let profile: OldProfile = serde_json::from_str(&profile_json(&[&hex, &hex])).unwrap();
        let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
        assert_eq!((entry.brand.as_str(), entry.ways.len()), ("Seeburg", 2));
        assert_eq!(entry.ways[1].label, "W1");
        assert_eq!(entry.ways[0].fc57_hex.as_deref(), Some(hex.as_str()));

        let no_ways: OldProfile = serde_json::from_str(&profile_json(&[])).unwrap();
        assert!(SpeakerLibraryEntry::from_profile(&no_ways).is_err());
        for bad in ["zz", "", "00"] {
            let p: OldProfile = serde_json::from_str(&profile_json(&[bad])).unwrap();
            assert!(SpeakerLibraryEntry::from_profile(&p).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn fit_reports_what_the_amp_cannot_take() {
        let ch = channel();
        let cap = capability("1.1.8");
        let mut way = SpeakerProcessing::from_channel(&ch);
        assert!(way.fit(&ch, &cap).unwrap().1.is_empty(), "an amp's own values always fit");

        way.delay_out_ms = 25.0;
        way.output_eq.bands[2].active = true;
        way.output_eq.bands[2].gain_db = 30.0;
        way.output_eq.bands.push(way.output_eq.bands[0]); // a 9th band the amp lacks
        way.output_eq.bands[8].active = true;
        let (fitted, issues) = way.fit(&ch, &cap).unwrap();
        assert_eq!(fitted.delay_out_ms, 20.0);
        assert_eq!(fitted.output_eq.bands[2].gain_db, 18.0);
        assert_eq!(fitted.output_eq.bands.len(), ch.output_eq.bands.len());
        assert!(issues.iter().any(|i| i.starts_with("Delay: 25.00 → 20.00")), "{issues:?}");
        assert!(issues.iter().any(|i| i.starts_with("EQ · Band 3 gain")), "{issues:?}");
        assert!(issues.iter().any(|i| i.starts_with("EQ · Band 9: dropped")), "{issues:?}");

        // A preset with fewer bands keeps the amp's own for the rest.
        let mut short = SpeakerProcessing::from_channel(&ch);
        short.output_eq.bands.truncate(6);
        let (fitted, issues) = short.fit(&ch, &cap).unwrap();
        assert_eq!(fitted.output_eq.bands.len(), ch.output_eq.bands.len());
        assert_eq!(issues.len(), ch.output_eq.bands.len() - 6);

        assert!(way.fit(&ch, &capability("1.0.5")).is_err(), "no speaker management before 1.1.8");
    }

    #[test]
    fn whole_output_conflicts_with_older_firmware() {
        let mut saved_on_119 = channel();
        saved_on_119.noise_gate_threshold_dbu = -40.0;
        let way = SpeakerProcessing::from_channel(&saved_on_119);
        let mut target = channel();
        target.noise_gate_threshold_dbu = -60.0;
        let (fitted, issues) = way.fit(&target, &capability("1.1.8")).unwrap();
        assert!(issues.iter().any(|i| i.starts_with("Noise gate threshold")), "{issues:?}");
        assert_eq!(fitted.noise_gate_threshold_dbu, Some(-60.0), "the amp keeps its own");
        assert!(way.fit(&target, &capability("1.1.9")).unwrap().1.is_empty());

        // A field the preset lacks is never a difference.
        let mut partial = way.clone();
        partial.output_volume_db = None;
        target.output_volume_db = -6.0;
        assert!(!partial.differences(&SpeakerProcessing::from_channel(&target)).contains(&"Output volume".to_string()));
    }

    #[test]
    fn details_rules() {
        let p = SpeakerProcessing::from_channel(&channel());
        assert!(SpeakerLibraryEntry::new(details(2), vec![p.clone()]).is_err(), "label count must match");
        let mut no_brand = details(1);
        no_brand.brand = " ".into();
        assert!(SpeakerLibraryEntry::new(no_brand, vec![p.clone()]).is_err());

        let mut entry = SpeakerLibraryEntry::new(details(2), vec![p.clone(), p]).unwrap();
        assert_eq!(entry.reference(1).unwrap().label, "Seeburg Hi · W1");
        let rev = entry.revision;
        entry.set_details(details(2)).unwrap();
        assert_eq!(entry.revision, rev, "metadata never bumps the revision");
    }
}
