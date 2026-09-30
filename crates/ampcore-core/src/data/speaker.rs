//! The speaker library: named, reusable output processing that a project
//! output can be set up from.
//!
//! The library is this machine's, not the project's. A project output only
//! holds a `SpeakerRef` beside its ordinary values, so a project opens and
//! pushes the same with or without the library. Whether an output still holds
//! what its library way says is a plain value comparison (`speaker_states`) —
//! nothing is hashed or stamped into the amp.
//!
//! What a way carries is `SpeakerProcessing`: output EQ (HP, bands, LP), both
//! limiter stages, output delay and polarity. Left out for now:
//! - volume: a `.sl` blob stores one, but whether it is the output volume or
//!   the trim isn't confirmed on hardware;
//! - FIR: the project stores no coefficients, so the bypass flag alone could
//!   switch on whatever filter the amp happens to hold. The raw FC=57 blob is
//!   kept (`SpeakerWay.fc57_hex`) for a later live pass that can write it whole;
//! - limiter `auto`/`max_*`: read-only here, and the maxima describe the amp,
//!   not the speaker (the same rule as `channel_clipboard.rs`).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::common::{new_id, now_millis};
use super::fingerprint::{canonical_eq, format_band, format_crossover, round_to_step, DELAY_STEPS, VOLT_STEPS, WHOLE_STEPS};
use super::project::{AmpAssignment, AmpChannel, ChannelEq, Limiter, SpeakerRef};
use crate::live::cvr::speaker_data::{decode_speaker_data, SlFile, SpeakerData};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerProcessing {
    pub output_eq: ChannelEq,
    pub limiter: Limiter,
    pub delay_out_ms: f64,
    pub phase_inverted: bool,
}

impl SpeakerProcessing {
    pub fn from_channel(channel: &AmpChannel) -> Self {
        Self {
            output_eq: channel.output_eq.clone(),
            limiter: channel.limiter,
            delay_out_ms: channel.delay_out_ms,
            phase_inverted: channel.output_phase_inverted,
        }
    }

    pub fn from_speaker_data(data: &SpeakerData) -> Self {
        Self {
            output_eq: data.eq.clone(),
            limiter: data.limiter,
            delay_out_ms: data.delay_ms as f64,
            phase_inverted: data.phase_inverted,
        }
    }

    /// Labelled, display-ready values, compared entry by entry. Uses the
    /// fingerprint's rounding and formatting, so "equal" here means what it
    /// means to push and the fingerprint.
    fn entries(&self) -> Vec<(String, String)> {
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

    pub fn from_sl(file: &SlFile) -> Result<Self, String> {
        let blobs = &file.ways;
        let processing = blobs
            .iter()
            .enumerate()
            .map(|(i, blob)| {
                decode_speaker_data(blob)
                    .map(|data| SpeakerProcessing::from_speaker_data(&data))
                    .map_err(|e| format!("way {}: {e}", i + 1))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let details = SpeakerDetails {
            brand: if file.brand.is_empty() { "Unknown".into() } else { file.brand.clone() },
            family: file.family.clone(),
            model: if file.model.is_empty() { "Unknown".into() } else { file.model.clone() },
            application: String::new(),
            notes: file.notes.clone(),
            way_labels: (0..blobs.len()).map(|i| way_label(&file.way_labels, i, blobs.len())).collect(),
        };
        let mut entry = Self::new(details, processing)?;
        for (way, blob) in entry.ways.iter_mut().zip(blobs) {
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
