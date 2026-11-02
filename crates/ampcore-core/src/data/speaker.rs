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
//! channel — output EQ, both limiter stages, delay, polarity, trim, noise
//! gate, power mode, FIR bypass and the FIR filter itself. Fields after polarity
//! are `Option`: a preset that lacks one (an imported blob, an older way)
//! leaves the amp's own value. `fit` adapts a way to the target amp's
//! capability and reports what it had to drop or clamp. Left out:
//! - the blob's DEQ block: this app has no DEQ. The raw FC=57 blob is kept
//!   (`SpeakerWay.fc57_hex`), so nothing is lost for a later pass;
//! - limiter `auto`/`max_*`: the maxima describe the amp, not the speaker
//!   (the same rule as `channel_clipboard.rs`);
//! - load (`ohms`): a local value on the output, for the limiter editor's
//!   watts; it says what is connected here, not what the preset is. A way
//!   keeps the speaker's nominal impedance (`SpeakerWay.nominal_ohms`) for the
//!   library editor's watt figures only: it never fills in an output's load
//!   and is never applied or compared;
//! - output volume and mute: how loud the system runs tonight, never part of
//!   a speaker on any make or model — not stored, applied or compared;
//! - output name and bridging: wiring, not speaker.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::capability::{AmpCapability, ParamRange, PowerMode};
use super::common::{new_id, now_millis};
use super::validation;
use super::fingerprint::{
    canonical_eq, format_band, format_crossover, round_to_step, DELAY_STEPS, GAIN_STEPS, VOLT_STEPS, WHOLE_STEPS,
};
use super::project::{AmpAssignment, AmpChannel, ChannelEq, ChannelFir, Limiter, Project, SpeakerRef};
use crate::live::cvr::speaker_data::{decode_speaker_data, hex_to_bytes, SpeakerData};

/// The speaker library's format, in `speakers.json` and export files. Separate
/// from the project format, since the library lives outside any project.
/// Migrations and the newer-file check live in `store.rs::migrate_speakers`.
///
/// 0: a bare list of entries, before the format had a version.
/// 1: the same entries, wrapped with this version.
/// 2: every way carries the whole output: trim, noise gate, power mode, FIR
///    bypass and FIR are no longer optional (`null` was "the amp keeps its own").
pub const CURRENT_SPEAKER_LIBRARY_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProcessing {
    pub output_eq: ChannelEq,
    pub limiter: Limiter,
    pub delay_out_ms: f64,
    pub phase_inverted: bool,
    // The rest of the output. A speaker always carries all of it, so applying
    // one leaves nothing of the output's own behind (volume and load aside).
    // Library version 1 allowed `null` here; `store.rs::migrate_speakers`
    // fills those in.
    pub output_trim_db: f64,
    pub noise_gate_enabled: bool,
    pub noise_gate_threshold_dbu: f64,
    pub power_mode: PowerMode,
    pub fir_bypassed: bool,
    /// The FIR filter itself; a unit impulse is "no FIR".
    pub fir: ChannelFir,
}

/// The peak floor (`Vp >= √2 · Vrms`, the rule every limiter edit keeps), for
/// everything entering the library from outside an amp, so the library holds
/// exactly what an apply writes and status compares like with like.
fn with_peak_floor(mut limiter: Limiter) -> Limiter {
    limiter.peak.threshold_vp = limiter.peak.threshold_vp.max(limiter.rms.threshold_vrms * std::f64::consts::SQRT_2);
    limiter
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
            output_trim_db: channel.output_trim_db,
            noise_gate_enabled: channel.noise_gate_enabled,
            noise_gate_threshold_dbu: channel.noise_gate_threshold_dbu,
            power_mode: channel.power_mode,
            fir_bypassed: channel.fir_bypassed,
            fir: channel.fir.clone(),
        }
    }

    /// A fresh output's values — flat EQ, both limiters off, no delay, no
    /// FIR: what a way created from scratch starts from.
    pub fn neutral() -> Self {
        Self::from_channel(&AmpAssignment::new(None, None, 1, None, None).channels[0])
    }

    /// The peak floor is applied here, once (`with_peak_floor`). The blob's
    /// volume and mute are never taken (see the module doc), and it carries no
    /// trim, gate or power mode: those start at a fresh output's values.
    pub fn from_speaker_data(data: &SpeakerData) -> Self {
        Self {
            output_eq: data.eq.clone(),
            limiter: with_peak_floor(data.limiter),
            delay_out_ms: data.delay_ms as f64,
            phase_inverted: data.phase_inverted,
            fir_bypassed: data.fir_bypassed,
            fir: ChannelFir { name: data.fir_name.clone().unwrap_or_default(), coefficients: data.fir_taps.clone() },
            ..Self::neutral()
        }
    }

    /// What applying this way to `current` can actually write on an amp with
    /// capability `cap`, plus a line for everything that differs from the way
    /// as stored: bands the amp doesn't have, bands the preset doesn't have
    /// (the amp's stay), and values clamped into the amp's ranges. `Err` when
    /// the amp can't take a speaker at all. Disabled stages and bypassed
    /// bands are fitted silently: their values don't reach the sound.
    ///
    /// Limiter thresholds are capped by the target channel's ceiling
    /// (`validation::limiter_ceiling`): its own reported maxima, else the
    /// model's rated voltage — the same bound the limiter editor shows.
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
            band.q = clamp(to, &format!("EQ · Band {n} Q"), "", band.q, validation::eq_q_range(band.filter_type, r));
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

        let ceiling = validation::limiter_ceiling(&current.limiter, cap.topology.rated_rms_voltage, r);
        let rms = &mut out.limiter.rms;
        let to = if rms.enabled { &mut issues } else { &mut quiet };
        rms.threshold_vrms =
            clamp(to, "RMS limiter threshold", " Vrms", rms.threshold_vrms, validation::rms_threshold_range(ceiling, r));
        // Timings are whole numbers on the wire, which would truncate a fraction.
        rms.attack_ms = clamp(to, "RMS limiter attack", " ms", rms.attack_ms.round(), r.rms_limiter_attack_ms);
        rms.release_multiplier =
            clamp(to, "RMS limiter release", "×", rms.release_multiplier.round(), r.rms_limiter_release_multiplier);
        let peak = &mut out.limiter.peak;
        let to = if peak.enabled { &mut issues } else { &mut quiet };
        peak.threshold_vp =
            clamp(to, "Peak limiter threshold", " Vp", peak.threshold_vp, validation::peak_threshold_range(ceiling, r));
        peak.hold_ms = clamp(to, "Peak limiter hold", " ms", peak.hold_ms.round(), r.peak_limiter_hold_ms);
        peak.release_ms = clamp(to, "Peak limiter release", " ms", peak.release_ms.round(), r.peak_limiter_release_ms);
        // The limiter editor's own rule: peak power at least double the RMS power.
        let floor = out.limiter.rms.threshold_vrms * std::f64::consts::SQRT_2;
        if out.limiter.peak.threshold_vp < floor {
            if out.limiter.peak.enabled {
                issues.push(format!("Peak limiter threshold: {:.2} → {:.2} Vp (at least √2 × RMS)", out.limiter.peak.threshold_vp, floor));
            }
            out.limiter.peak.threshold_vp = floor;
        }
        out.delay_out_ms = clamp(&mut issues, "Delay", " ms", out.delay_out_ms, r.delay_out_ms);

        // The rest of the output: what the amp can't hold is dropped, and the
        // output keeps its own value there.
        let fw = &cap.firmware;
        if fw.noise_gate_threshold {
            out.noise_gate_threshold_dbu =
                clamp(&mut issues, "Noise gate threshold", " dBu", out.noise_gate_threshold_dbu.round(), r.noise_gate_threshold_dbu);
        } else {
            if (out.noise_gate_threshold_dbu - current.noise_gate_threshold_dbu).abs() > 1e-6 {
                issues.push(format!("Noise gate threshold: {:.0} dBu dropped, this firmware has none", out.noise_gate_threshold_dbu));
            }
            out.noise_gate_threshold_dbu = current.noise_gate_threshold_dbu;
        }
        if !fw.fir_filters {
            if out.fir_bypassed != current.fir_bypassed {
                issues.push("FIR bypass: dropped, this firmware has no FIR".into());
            }
            if !out.fir.same_taps(&[1.0]) {
                issues.push("FIR filter: dropped, this firmware has no FIR".into());
            }
            out.fir_bypassed = current.fir_bypassed;
            out.fir = current.fir.clone();
        }
        let modes = &cap.topology.power_modes;
        if !modes.is_empty() && !modes.contains(&out.power_mode) {
            issues.push(format!("Power mode: {:?} dropped, this amp has no such mode", out.power_mode));
            out.power_mode = current.power_mode;
        }
        out.output_trim_db = clamp(&mut issues, "Output trim", " dB", out.output_trim_db, r.output_trim_db);
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
        channel.output_trim_db = self.output_trim_db;
        channel.noise_gate_enabled = self.noise_gate_enabled;
        channel.noise_gate_threshold_dbu = self.noise_gate_threshold_dbu;
        channel.power_mode = self.power_mode;
        channel.fir_bypassed = self.fir_bypassed;
        channel.fir = self.fir.clone();
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
        out.push(("Output trim".into(), format!("{:.2} dB", round_to_step(self.output_trim_db, GAIN_STEPS))));
        out.push(("Noise gate".into(), if self.noise_gate_enabled { "on" } else { "off" }.to_string()));
        out.push(("Noise gate threshold".into(), format!("{:.0} dBu", self.noise_gate_threshold_dbu)));
        out.push(("Power mode".into(), format!("{:?}", self.power_mode)));
        out.push(("FIR".into(), if self.fir_bypassed { "bypassed" } else { "active" }.to_string()));
        out.push(("FIR filter".into(), self.fir.summary()));
        out
    }

    /// Labels of every entry where `self` and `other` differ.
    pub fn differences(&self, other: &SpeakerProcessing) -> Vec<String> {
        let (a, b) = (self.entries(), other.entries());
        if a.len() != b.len() {
            return vec!["EQ bands".to_string()];
        }
        a.into_iter().zip(b).filter(|(x, y)| x.1 != y.1).map(|(x, _)| x.0).collect()
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
    /// The driver's nominal impedance. Only the preset editor's watt figures
    /// use it: never applied to an output, never compared, no revision bump.
    /// `None` for a way stored before this existed.
    #[serde(default)]
    pub nominal_ohms: Option<f64>,
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

/// Most ways a speaker made or edited here can have.
pub const MAX_WAYS: usize = 4;

/// 1 to `MAX_WAYS` ways, for a speaker created or edited by hand.
pub fn check_way_count(count: usize) -> Result<(), String> {
    match count {
        0 => Err("A speaker needs at least one way".into()),
        n if n > MAX_WAYS => Err(format!("A speaker has at most {MAX_WAYS} ways")),
        _ => Ok(()),
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
                    nominal_ohms: None,
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
        let (blobs, processing): (Vec<(Vec<u8>, f32)>, Vec<_>) = s
            .ways
            .iter()
            .enumerate()
            .map(|(i, way)| {
                let hex = way.device_data.as_ref().map_or("", |d| d.hex.as_str());
                let blob = hex_to_bytes(hex).map_err(|e| format!("way {}: {e}", i + 1))?;
                let data = decode_speaker_data(&blob).map_err(|e| format!("way {}: {e}", i + 1))?;
                Ok(((blob, data.load_ohms), SpeakerProcessing::from_speaker_data(&data)))
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
        for (way, (blob, load_ohms)) in entry.ways.iter_mut().zip(&blobs) {
            way.fc57_hex = Some(blob.iter().map(|b| format!("{b:02x}")).collect());
            // The blob's load is the speaker's impedance as the old app knew it.
            way.nominal_ohms = Some(*load_ohms as f64).filter(|o| o.is_finite() && *o > 0.0);
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
        way.processing = SpeakerProcessing { limiter: with_peak_floor(processing.limiter), ..processing };
        way.fc57_hex = None; // no longer what the blob says
        self.revision += 1;
        self.updated_at = now_millis();
        Ok(())
    }

    /// A copy under a new id, its model marked "(copy)". It starts at revision
    /// 1: no output was set up from it yet.
    pub fn duplicate(&self) -> Self {
        let now = now_millis();
        Self {
            id: new_id(),
            model: format!("{} (copy)", self.model),
            revision: 1,
            created_at: now,
            updated_at: now,
            ..self.clone()
        }
    }

    /// Takes the library editor's edit of this entry as a whole: details, way
    /// labels, values, impedances and ways. Edited way `i` was stored way
    /// `origins[i]` (`None`: added), so ways can be removed from anywhere;
    /// `remap_way_refs` then moves the outputs along. The revision moves once,
    /// and only when what an output would get changed: values or ways, never
    /// metadata or impedance.
    pub fn save_edit(&mut self, edited: SpeakerLibraryEntry, origins: &[Option<u32>]) -> Result<(), String> {
        check_way_count(edited.ways.len())?;
        let known = origins.iter().flatten();
        if origins.len() != edited.ways.len()
            || known.clone().any(|&o| o as usize >= self.ways.len())
            || known.clone().collect::<std::collections::HashSet<_>>().len() != known.count()
        {
            return Err("The edited ways don't match this speaker any more".into());
        }
        let mut changed = origins.iter().enumerate().any(|(i, o)| *o != Some(i as u32)) || origins.len() != self.ways.len();
        let mut ways = Vec::with_capacity(edited.ways.len());
        for (mut way, origin) in edited.ways.into_iter().zip(origins) {
            if way.nominal_ohms.is_some_and(|o| !(o.is_finite() && o > 0.0)) {
                return Err("Impedance must be above 0 Ω".into());
            }
            way.processing.limiter = with_peak_floor(way.processing.limiter);
            match origin.and_then(|o| self.ways.get(o as usize)) {
                // Exact, not `differences`: that one skips fields the way leaves out.
                Some(old) if old.processing == way.processing => way.fc57_hex = old.fc57_hex.clone(),
                _ => {
                    changed = true;
                    way.fc57_hex = None; // no longer what the blob says
                }
            }
            ways.push(way);
        }
        let details = SpeakerDetails {
            brand: edited.brand,
            family: edited.family,
            model: edited.model,
            application: edited.application,
            notes: edited.notes,
            way_labels: ways.iter().map(|w| w.label.clone()).collect(),
        };
        details.validate(ways.len())?;
        self.ways = ways;
        self.set_details(details)?;
        if changed {
            self.revision += 1;
        }
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
            project_speaker_id: None,
        })
    }
}

/// Moves the outputs set up from library speaker `library_id` along after a
/// `save_edit` with these `origins`: an output on a way that moved points at
/// its new index, and one on a removed way loses its speaker (its values
/// stay). Whether anything changed, so the caller knows to save `project`.
pub fn remap_way_refs(project: &mut Project, library_id: &str, origins: &[Option<u32>]) -> bool {
    let mut changed = false;
    for channel in project.amp_assignments.iter_mut().flat_map(|a| a.channels.iter_mut()) {
        let Some(old) = channel.speaker.as_ref().filter(|r| r.library_id == library_id).map(|r| r.way_index) else {
            continue;
        };
        match origins.iter().position(|o| *o == Some(old)) {
            Some(new) if new as u32 == old => {}
            Some(new) => {
                channel.speaker.as_mut().unwrap().way_index = new as u32;
                changed = true;
            }
            None => {
                channel.speaker = None;
                changed = true;
            }
        }
    }
    changed
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpeakerStatus {
    /// The output holds exactly what its library way says.
    Match,
    /// The output was changed after it was set up.
    Edited { fields: Vec<String> },
    /// The library way changed after the output was set up. `fields` is what
    /// re-applying would change; a revision that changes nothing here is `Match`.
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

/// With `cap`, the output is compared against the way as `fit` would write it
/// onto this amp, so "Match" means "holds what applying would write" — a way
/// the amp had to clamp must not read "Edited" for ever.
pub fn speaker_status(
    channel: &AmpChannel,
    speaker: &SpeakerRef,
    library: &[SpeakerLibraryEntry],
    cap: Option<&AmpCapability>,
) -> SpeakerStatus {
    let Some(entry) = library.iter().find(|e| e.id == speaker.library_id) else {
        return SpeakerStatus::Detached;
    };
    let Some(way) = entry.ways.get(speaker.way_index as usize) else {
        return SpeakerStatus::Detached;
    };
    let fitted = cap.and_then(|cap| way.processing.fit(channel, cap).ok()).map(|(fitted, _)| fitted);
    let fields = fitted.as_ref().unwrap_or(&way.processing).differences(&SpeakerProcessing::from_channel(channel));
    // A newer revision that leaves this output's values as they are is no news.
    if fields.is_empty() {
        SpeakerStatus::Match
    } else if entry.revision != speaker.revision {
        SpeakerStatus::LibraryUpdated { fields }
    } else {
        SpeakerStatus::Edited { fields }
    }
}

/// One state per output that has a speaker.
pub fn speaker_states(
    assignment: &AmpAssignment,
    library: &[SpeakerLibraryEntry],
    cap: Option<&AmpCapability>,
) -> Vec<ChannelSpeakerState> {
    assignment
        .channels
        .iter()
        .filter_map(|channel| {
            let speaker = channel.speaker.as_ref()?;
            Some(ChannelSpeakerState {
                channel_index: channel.channel_index,
                speaker: speaker.clone(),
                status: speaker_status(channel, speaker, library, cap),
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

    /// `save_edit` with the edit's ways in stored order (any beyond the
    /// stored ones count as added).
    fn save(entry: &mut SpeakerLibraryEntry, edit: SpeakerLibraryEntry) -> Result<(), String> {
        let stored = entry.ways.len() as u32;
        let origins: Vec<_> = (0..edit.ways.len() as u32).map(|i| Some(i).filter(|&i| i < stored)).collect();
        entry.save_edit(edit, &origins)
    }

    /// Removing a middle way: its outputs lose the speaker, later ways' outputs
    /// follow their way, and stale origins are refused.
    #[test]
    fn removing_a_middle_way_moves_its_outputs_along() {
        let p = SpeakerProcessing::from_channel(&channel());
        let mut entry = SpeakerLibraryEntry::new(details(3), vec![p.clone(), p.clone(), p]).unwrap();
        let mut project = Project::new("P".into(), String::new());
        let mut amp = AmpAssignment::new(None, None, 4, None, None);
        for way in 0..3 {
            amp.channels[way].speaker = Some(entry.reference(way as u32).unwrap());
        }
        amp.channels[3].speaker = Some(SpeakerRef { library_id: "other".into(), ..entry.reference(2).unwrap() });
        project.amp_assignments.push(amp);

        let origins = [Some(0), Some(2)];
        let mut edit = entry.clone();
        edit.ways.remove(1);
        assert!(entry.save_edit(edit.clone(), &[Some(0), Some(5)]).is_err(), "no stored way 5");
        assert!(entry.save_edit(edit.clone(), &[Some(0), Some(0)]).is_err(), "a way can't come from one twice");
        entry.save_edit(edit, &origins).unwrap();
        assert_eq!(entry.ways.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), ["W0", "W2"]);

        assert!(remap_way_refs(&mut project, &entry.id, &origins));
        let ways: Vec<_> = project.amp_assignments[0].channels.iter().map(|c| c.speaker.as_ref().map(|s| s.way_index)).collect();
        assert_eq!(ways, [Some(0), None, Some(1), Some(2)], "the other speaker's output is left alone");
        assert!(!remap_way_refs(&mut project, &entry.id, &[Some(0), Some(1)]), "nothing left to move");
    }

    #[test]
    fn status_follows_values_and_revision() {
        let mut ch = channel();
        ch.delay_out_ms = 2.5;
        let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&ch)]).unwrap();
        let speaker = entry.reference(0).unwrap();
        assert_eq!(speaker.label, "Seeburg Hi");
        let library = vec![entry.clone()];
        assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));

        // f32 wire rounding must not read as an edit.
        ch.delay_out_ms = 2.5 + 1e-9;
        assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));

        ch.output_eq.bands[2].gain_db += 1.5;
        ch.output_eq.bands[2].active = true;
        match speaker_status(&ch, &speaker, &library, None) {
            SpeakerStatus::Edited { fields } => assert_eq!(fields, ["EQ · Band 3"]),
            other => panic!("{other:?}"),
        }

        // The library catching up with the output is no news.
        entry.set_way_processing(0, SpeakerProcessing::from_channel(&ch)).unwrap();
        assert!(matches!(speaker_status(&ch, &speaker, &[entry.clone()], None), SpeakerStatus::Match));

        let mut moved = SpeakerProcessing::from_channel(&ch);
        moved.delay_out_ms = 4.0;
        entry.set_way_processing(0, moved).unwrap();
        match speaker_status(&ch, &speaker, &[entry.clone()], None) {
            SpeakerStatus::LibraryUpdated { fields } => assert_eq!(fields, ["Delay"]),
            other => panic!("{other:?}"),
        }

        assert!(matches!(speaker_status(&ch, &speaker, &[], None), SpeakerStatus::Detached));
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
        assert!(matches!(speaker_status(&ch, &speaker, &[entry], None), SpeakerStatus::Match));
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
        way.output_eq.bands[2].gain_db = 30.0; // above the vendor's ±24 dB
        way.output_eq.bands.push(way.output_eq.bands[0]); // a 9th band the amp lacks
        way.output_eq.bands[8].active = true;
        let (fitted, issues) = way.fit(&ch, &cap).unwrap();
        assert_eq!(fitted.delay_out_ms, 20.0);
        assert_eq!(fitted.output_eq.bands[2].gain_db, 24.0);
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

    /// A way the amp had to clamp reads Match once applied — and Edited only
    /// when the output is changed after that.
    #[test]
    fn a_clamped_way_matches_once_applied() {
        let cap = capability("1.1.8");
        let mut ch = channel();
        let mut way = SpeakerProcessing::from_channel(&ch);
        way.delay_out_ms = 25.0; // the amp takes 20
        let entry = SpeakerLibraryEntry::new(details(1), vec![way.clone()]).unwrap();
        let speaker = entry.reference(0).unwrap();
        way.fit(&ch, &cap).unwrap().0.apply_to(&mut ch);
        let library = [entry];
        assert!(matches!(speaker_status(&ch, &speaker, &library, Some(&cap)), SpeakerStatus::Match));
        assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Edited { .. }));
        ch.delay_out_ms = 3.0;
        assert!(matches!(speaker_status(&ch, &speaker, &library, Some(&cap)), SpeakerStatus::Edited { .. }));
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
        assert_eq!(fitted.noise_gate_threshold_dbu, -60.0, "the amp keeps its own");
        assert!(way.fit(&target, &capability("1.1.9")).unwrap().1.is_empty());
    }

    /// A speaker carries the whole output: an imported one starts trim, gate
    /// and power mode at a fresh output's values, applying writes them, and
    /// any of them changed on the output afterwards reads Edited.
    #[test]
    fn a_speaker_owns_the_whole_output() {
        let profile: OldProfile = serde_json::from_str(&profile_json(&["00".repeat(2310).as_str()])).unwrap();
        let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
        let way = &entry.ways[0].processing;
        let neutral = SpeakerProcessing::neutral();
        assert_eq!(
            (way.output_trim_db, way.noise_gate_enabled, way.power_mode),
            (neutral.output_trim_db, neutral.noise_gate_enabled, neutral.power_mode)
        );

        let mut ch = channel();
        ch.output_trim_db = -3.0;
        ch.noise_gate_enabled = true;
        ch.power_mode = PowerMode::V70;
        way.apply_to(&mut ch);
        assert_eq!((ch.output_trim_db, ch.noise_gate_enabled, ch.power_mode), (0.0, false, neutral.power_mode));

        let speaker = entry.reference(0).unwrap();
        let library = [entry.clone()];
        assert!(matches!(speaker_status(&ch, &speaker, &library, None), SpeakerStatus::Match));
        ch.power_mode = PowerMode::V100;
        match speaker_status(&ch, &speaker, &library, None) {
            SpeakerStatus::Edited { fields } => assert_eq!(fields, ["Power mode"]),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn fir_travels_with_the_preset() {
        let mut hex = "00".repeat(2310);
        // FIR name "top" at +32, first tap 0.5 at +64.
        hex.replace_range(64..70, "746f70");
        hex.replace_range(128..136, "0000003f");
        let profile: OldProfile = serde_json::from_str(&profile_json(&[&hex])).unwrap();
        let entry = SpeakerLibraryEntry::from_profile(&profile).unwrap();
        let fir = entry.ways[0].processing.fir.clone();
        assert_eq!((fir.name.as_str(), fir.coefficients[0], fir.coefficients.len()), ("top", 0.5, 512));

        // Applied, the output matches; with another filter on it, it doesn't.
        let mut ch = channel();
        let (fitted, issues) = entry.ways[0].processing.fit(&ch, &capability("1.1.8")).unwrap();
        assert!(!issues.iter().any(|i| i.starts_with("FIR")), "{issues:?}");
        assert!(fitted.fir.same_taps(&fir.coefficients), "1.1.8 has FIR, so it is kept");
        entry.ways[0].processing.apply_to(&mut ch);
        let speaker = entry.reference(0).unwrap();
        assert!(matches!(speaker_status(&ch, &speaker, &[entry.clone()], None), SpeakerStatus::Match));
        ch.fir = ChannelFir::identity();
        match speaker_status(&ch, &speaker, &[entry], None) {
            SpeakerStatus::Edited { fields } => assert_eq!(fields, ["FIR filter"]),
            other => panic!("{other:?}"),
        }
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

    /// A hand edit stores what an import would: the peak floor applied, and no
    /// blob that no longer matches the values.
    #[test]
    fn a_way_edit_applies_the_peak_floor_and_drops_the_blob() {
        let mut p = SpeakerProcessing::from_channel(&channel());
        p.limiter.rms.threshold_vrms = 100.0;
        p.limiter.peak.threshold_vp = 50.0;
        let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&channel())]).unwrap();
        entry.ways[0].fc57_hex = Some("00".into());

        entry.set_way_processing(0, p).unwrap();
        let limiter = entry.ways[0].processing.limiter;
        assert!((limiter.peak.threshold_vp - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9);
        assert_eq!(entry.ways[0].fc57_hex, None);
    }

    #[test]
    fn duplicate_is_a_fresh_entry() {
        let mut ch = channel();
        ch.delay_out_ms = 1.5;
        let mut entry = SpeakerLibraryEntry::new(details(1), vec![SpeakerProcessing::from_channel(&ch)]).unwrap();
        entry.set_way_processing(0, SpeakerProcessing::from_channel(&ch)).unwrap();

        let copy = entry.duplicate();
        assert_ne!(copy.id, entry.id);
        assert_eq!(copy.model, "Hi (copy)");
        assert_eq!(copy.revision, 1);
        assert_eq!(copy.ways[0].processing.delay_out_ms, 1.5);
    }

    /// One editor save is one revision, and only when an output would get
    /// something new.
    #[test]
    fn a_save_bumps_the_revision_once_and_only_for_values() {
        let p = SpeakerProcessing::from_channel(&channel());
        let mut entry = SpeakerLibraryEntry::new(details(2), vec![p.clone(), p]).unwrap();
        entry.ways[0].fc57_hex = Some("00".into());
        entry.ways[1].fc57_hex = Some("00".into());
        let rev = entry.revision;

        let same = entry.clone();
        save(&mut entry, same).unwrap();
        assert_eq!(entry.revision, rev, "a save that changes nothing");

        let mut edit = entry.clone();
        edit.model = "Renamed".into();
        edit.ways[0].label = String::new();
        edit.ways[1].nominal_ohms = Some(4.0);
        save(&mut entry, edit).unwrap();
        assert_eq!(entry.revision, rev, "metadata and impedance are not values");
        assert_eq!((entry.model.as_str(), entry.ways[0].label.as_str()), ("Renamed", "Way 1"));

        let mut edit = entry.clone();
        edit.ways[0].processing.delay_out_ms = 1.0;
        edit.ways[1].processing.phase_inverted = true;
        edit.ways[1].processing.limiter.rms.threshold_vrms = 100.0;
        edit.ways[1].processing.limiter.peak.threshold_vp = 50.0;
        save(&mut entry, edit).unwrap();
        assert_eq!(entry.revision, rev + 1, "two ways changed, one revision");
        assert_eq!(entry.ways[0].fc57_hex, None, "a changed way drops its blob");
        let peak = entry.ways[1].processing.limiter.peak.threshold_vp;
        assert!((peak - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9, "peak floor applied");

        let mut edit = entry.clone();
        edit.ways.pop();
        save(&mut entry, edit).unwrap();
        assert_eq!((entry.ways.len(), entry.revision), (1, rev + 2), "way count is a change");

        let mut bad = entry.clone();
        bad.ways[0].nominal_ohms = Some(0.0);
        assert!(save(&mut entry, bad).is_err());
        let mut bad = entry.clone();
        bad.ways.clear();
        assert!(save(&mut entry, bad).is_err());
        let mut bad = entry.clone();
        bad.ways = vec![bad.ways[0].clone(); MAX_WAYS + 1];
        assert!(save(&mut entry, bad).is_err(), "at most {MAX_WAYS} ways");
    }
}
