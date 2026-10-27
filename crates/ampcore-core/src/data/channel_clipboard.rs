//! Copy/paste of one channel section — a whole EQ chain or one limiter stage —
//! shared by every app and both edit targets. A `ChannelClip` is plain data,
//! so it can be copied from a live amp and pasted into a project (or the other
//! way): `paste_into_project` mutates an `AmpChannel`, `live_paste_actions`
//! plans the writes that make a live channel hold the same thing.
//!
//! The clip is tagged by what it holds, and each section only takes its own
//! kind (an EQ fits either EQ side). Ported from the prior web app's
//! `lib/copy-paste.ts`, which does the same with its "origin" tag.
//!
//! Not copied: `auto`, `max_vrms` and `max_vp`. The first is read-only in this
//! app, and the maxima describe the target amp's hardware (see `amp_push.rs`),
//! so the target keeps its own.
//!
//! A paste is checked against the *target's* ranges and limiter ceiling
//! (`validation.rs`) before anything changes: a clip from a bigger amp, or from
//! a project saved before the ranges were corrected, is refused with the
//! offending value rather than stored or sent.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::amp_push::PushAction;
use super::capability::cvr::AmpParamRanges;
use super::project::{AmpChannel, ChannelEq, EqDirection, Limiter, LimiterPatch, PeakLimiter, RmsLimiter};
use super::validation;
use crate::live::cvr::channel_config::ChannelConfig;

/// Where a clip comes from or goes to on a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipSection {
    InputEq,
    OutputEq,
    RmsLimiter,
    PeakLimiter,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChannelClip {
    Eq { eq: ChannelEq },
    RmsLimiter { rms: RmsLimiter },
    PeakLimiter { peak: PeakLimiter },
}

impl ChannelClip {
    /// Whether this clip can be pasted into `section`.
    pub fn fits(&self, section: ClipSection) -> bool {
        matches!(
            (self, section),
            (ChannelClip::Eq { .. }, ClipSection::InputEq | ClipSection::OutputEq)
                | (ChannelClip::RmsLimiter { .. }, ClipSection::RmsLimiter)
                | (ChannelClip::PeakLimiter { .. }, ClipSection::PeakLimiter)
        )
    }
}

fn copy(section: ClipSection, input_eq: &ChannelEq, output_eq: &ChannelEq, limiter: &Limiter) -> ChannelClip {
    match section {
        ClipSection::InputEq => ChannelClip::Eq { eq: input_eq.clone() },
        ClipSection::OutputEq => ChannelClip::Eq { eq: output_eq.clone() },
        ClipSection::RmsLimiter => ChannelClip::RmsLimiter { rms: limiter.rms },
        ClipSection::PeakLimiter => ChannelClip::PeakLimiter { peak: limiter.peak },
    }
}

pub fn copy_from_project(channel: &AmpChannel, section: ClipSection) -> ChannelClip {
    copy(section, &channel.input_eq, &channel.output_eq, &channel.limiter)
}

pub fn copy_from_live(channel: &ChannelConfig, section: ClipSection) -> ChannelClip {
    copy(section, &channel.input_eq, &channel.output_eq, &channel.limiter)
}

/// `limiter` after pasting `clip` onto it. Also keeps the rule `LimiterEditor.tsx`'s `requiredPeakFloor` enforces on
/// every edit — peak power at least double the RMS power, i.e.
/// `Vp >= √2 · Vrms` — by raising the peak threshold when a paste would break
/// it, the same way an RMS edit in the editor does.
fn pasted_limiter(limiter: &Limiter, clip: &ChannelClip) -> Limiter {
    let mut out = *limiter;
    match clip {
        ChannelClip::RmsLimiter { rms } => {
            out.rms = RmsLimiter { auto: out.rms.auto, max_vrms: out.rms.max_vrms, ..*rms };
        }
        ChannelClip::PeakLimiter { peak } => {
            out.peak = PeakLimiter { max_vp: out.peak.max_vp, ..*peak };
        }
        ChannelClip::Eq { .. } => {}
    }
    out.peak.threshold_vp = out.peak.threshold_vp.max(out.rms.threshold_vrms * std::f64::consts::SQRT_2);
    out
}

fn check(target_eq: &ChannelEq, clip: &ChannelClip, section: ClipSection) -> Result<(), String> {
    if !clip.fits(section) {
        let target = match section {
            ClipSection::InputEq => "an input EQ",
            ClipSection::OutputEq => "an output EQ",
            ClipSection::RmsLimiter => "the RMS limiter",
            ClipSection::PeakLimiter => "the peak limiter",
        };
        return Err(format!("The clipboard doesn't fit {target}"));
    }
    if let ChannelClip::Eq { eq } = clip {
        if eq.bands.len() != target_eq.bands.len() {
            return Err(format!("The copied EQ has {} bands, this channel has {}", eq.bands.len(), target_eq.bands.len()));
        }
    }
    Ok(())
}

/// A limiter paste as the edit it amounts to, so it is checked by the same
/// rule as one (`validation::check_limiter_patch`): the pasted stage's fields
/// — just its enable flag when it arrives disabled, since a disabled stage's
/// values don't reach the audio — plus the peak threshold when the floor
/// raised it.
fn limiter_paste_patch(old: &Limiter, new: &Limiter, clip: &ChannelClip) -> LimiterPatch {
    let rms = matches!(clip, ChannelClip::RmsLimiter { .. });
    let peak = matches!(clip, ChannelClip::PeakLimiter { .. });
    let rms_values = rms && new.rms.enabled;
    let peak_values = peak && new.peak.enabled;
    LimiterPatch {
        rms_enabled: rms.then_some(new.rms.enabled),
        rms_threshold_vrms: rms_values.then_some(new.rms.threshold_vrms),
        rms_attack_ms: rms_values.then_some(new.rms.attack_ms),
        rms_release_multiplier: rms_values.then_some(new.rms.release_multiplier),
        peak_enabled: peak.then_some(new.peak.enabled),
        peak_threshold_vp: (peak_values || new.peak.threshold_vp != old.peak.threshold_vp).then_some(new.peak.threshold_vp),
        peak_hold_ms: peak_values.then_some(new.peak.hold_ms),
        peak_release_ms: peak_values.then_some(new.peak.release_ms),
    }
}

/// `clip`'s values against the target's ranges, before anything changes.
fn check_values(
    target_limiter: &Limiter,
    new_limiter: &Limiter,
    clip: &ChannelClip,
    label: &str,
    ranges: &AmpParamRanges,
    rated_rms_voltage: Option<f64>,
) -> Result<(), String> {
    match clip {
        ChannelClip::Eq { eq } => validation::check_eq_chain(label, eq, ranges),
        _ => {
            let ceiling = validation::limiter_ceiling(target_limiter, rated_rms_voltage, ranges);
            let patch = limiter_paste_patch(target_limiter, new_limiter, clip);
            validation::check_limiter_patch(&patch, new_limiter, ceiling, ranges)
        }
    }
}

/// Which EQ side `section` means; only consulted for the EQ sections.
fn eq_side(section: ClipSection) -> EqDirection {
    match section {
        ClipSection::OutputEq => EqDirection::Output,
        _ => EqDirection::Input,
    }
}

/// `ranges`/`rated_rms_voltage` describe the target amp (its firmware's
/// `cvr_param_ranges`, its model's rated voltage).
pub fn paste_into_project(
    channel: &mut AmpChannel,
    section: ClipSection,
    clip: &ChannelClip,
    ranges: &AmpParamRanges,
    rated_rms_voltage: Option<f64>,
) -> Result<(), String> {
    let direction = eq_side(section);
    let target_eq = match direction {
        EqDirection::Input => &channel.input_eq,
        EqDirection::Output => &channel.output_eq,
    };
    check(target_eq, clip, section)?;
    let new_limiter = pasted_limiter(&channel.limiter, clip);
    check_values(&channel.limiter, &new_limiter, clip, &section_label(section), ranges, rated_rms_voltage)?;
    match clip {
        ChannelClip::Eq { eq } => match direction {
            EqDirection::Input => channel.input_eq = eq.clone(),
            EqDirection::Output => channel.output_eq = eq.clone(),
        },
        _ => channel.limiter = new_limiter,
    }
    Ok(())
}

fn section_label(section: ClipSection) -> String {
    match section {
        ClipSection::InputEq => "Input EQ",
        ClipSection::OutputEq => "Output EQ",
        ClipSection::RmsLimiter | ClipSection::PeakLimiter => "Limiter",
    }
    .to_string()
}

/// The writes that make `channel` (the last FC=27 snapshot) hold `clip` in
/// `section`. An EQ is one whole-chain write (FC=52) echoing the chain's
/// unmodelled bytes; a limiter stage is its own record, plus the other stage
/// when the peak floor had to be raised.
pub fn live_paste_actions(
    channel: &ChannelConfig,
    section: ClipSection,
    clip: &ChannelClip,
    ranges: &AmpParamRanges,
    rated_rms_voltage: Option<f64>,
) -> Result<Vec<PushAction>, String> {
    let ch = channel.channel_index as u8;
    let direction = eq_side(section);
    let (target_eq, wire) = match direction {
        EqDirection::Input => (&channel.input_eq, &channel.input_eq_wire),
        EqDirection::Output => (&channel.output_eq, &channel.output_eq_wire),
    };
    check(target_eq, clip, section)?;
    let old = channel.limiter;
    let new = pasted_limiter(&old, clip);
    check_values(&old, &new, clip, &section_label(section), ranges, rated_rms_voltage)?;
    if let ChannelClip::Eq { eq } = clip {
        return Ok(vec![PushAction::EqChain { channel: ch, direction, eq: eq.clone(), wire: wire.clone() }]);
    }

    let mut actions = Vec::new();
    if matches!(clip, ChannelClip::RmsLimiter { .. }) {
        let rms = new.rms;
        actions.push(PushAction::RmsLimiter {
            channel: ch,
            enabled: rms.enabled,
            threshold_vrms: rms.threshold_vrms,
            attack_ms: rms.attack_ms,
            release_multiplier: rms.release_multiplier,
        });
    }
    if matches!(clip, ChannelClip::PeakLimiter { .. }) || new.peak.threshold_vp != old.peak.threshold_vp {
        let peak = new.peak;
        actions.push(PushAction::PeakLimiter {
            channel: ch,
            enabled: peak.enabled,
            threshold_vp: peak.threshold_vp,
            hold_ms: peak.hold_ms,
            release_ms: peak.release_ms,
        });
    }
    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::capability::cvr::{cvr_param_ranges, CvrFirmwareCapability};
    use crate::data::project::AmpAssignment;
    use crate::live::cvr::channel_config_v118::{parse_channel_config, BYTES_PER_CHANNEL, TRAILER_SIZE_V118};

    fn channels() -> Vec<AmpChannel> {
        AmpAssignment::new(None, None, 2, None, None).channels
    }

    fn ranges() -> AmpParamRanges {
        cvr_param_ranges(&CvrFirmwareCapability::from_version(Some("1.1.8")))
    }

    #[test]
    fn eq_pastes_across_sides_and_kinds_are_checked() {
        let mut chs = channels();
        chs[0].input_eq.bands[3].gain_db = 4.5;
        let clip = copy_from_project(&chs[0], ClipSection::InputEq);

        paste_into_project(&mut chs[1], ClipSection::OutputEq, &clip, &ranges(), None).unwrap();
        assert_eq!(chs[1].output_eq.bands[3].gain_db, 4.5);
        assert!(paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip, &ranges(), None).is_err());
    }

    #[test]
    fn limiter_paste_keeps_hardware_facts_and_the_peak_floor() {
        let mut chs = channels();
        chs[0].limiter.rms.threshold_vrms = 100.0;
        chs[0].limiter.rms.max_vrms = 1.0;
        chs[1].limiter.rms.max_vrms = 200.0;
        chs[1].limiter.peak.threshold_vp = 50.0;
        let clip = copy_from_project(&chs[0], ClipSection::RmsLimiter);

        paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip, &ranges(), None).unwrap();
        assert_eq!(chs[1].limiter.rms.threshold_vrms, 100.0);
        assert_eq!(chs[1].limiter.rms.max_vrms, 200.0, "the target amp's maximum stays");
        assert!((chs[1].limiter.peak.threshold_vp - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9);
    }

    #[test]
    fn live_paste_plans_one_chain_write_or_the_touched_stages() {
        let snapshot = parse_channel_config(&vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118], 4).unwrap();
        let live = &snapshot.channels[2];

        // From a project: the zeroed snapshot's HP reads as active at 0 Hz,
        // which a paste now rightly refuses.
        let eq = copy_from_project(&channels()[0], ClipSection::InputEq);
        let actions = live_paste_actions(live, ClipSection::OutputEq, &eq, &ranges(), None).unwrap();
        assert!(matches!(actions[..], [PushAction::EqChain { channel: 2, direction: EqDirection::Output, .. }]));

        let mut rms = live.limiter.rms;
        rms.threshold_vrms = 60.0;
        rms.attack_ms = 5.0;
        rms.release_multiplier = 4.0;
        let actions = live_paste_actions(live, ClipSection::RmsLimiter, &ChannelClip::RmsLimiter { rms }, &ranges(), None).unwrap();
        assert!(matches!(actions[..], [PushAction::RmsLimiter { .. }, PushAction::PeakLimiter { .. }]), "floor raised the peak too");
    }

    /// A clip is held to the target's limits: a threshold above the target's
    /// rated output, or a timing below the vendor minimum, is refused and the
    /// channel left as it was.
    #[test]
    fn paste_is_checked_against_the_target() {
        let mut chs = channels();
        chs[0].limiter.rms.enabled = true;
        chs[0].limiter.rms.threshold_vrms = 100.0;
        let clip = copy_from_project(&chs[0], ClipSection::RmsLimiter);
        let before = chs[1].limiter.rms.threshold_vrms;
        let err = paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip, &ranges(), Some(72.1)).unwrap_err();
        assert!(err.contains("RMS limiter threshold"), "{err}");
        assert_eq!(chs[1].limiter.rms.threshold_vrms, before);

        chs[0].limiter.rms.threshold_vrms = 50.0;
        chs[0].limiter.rms.attack_ms = 0.0;
        let clip = copy_from_project(&chs[0], ClipSection::RmsLimiter);
        assert!(paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip, &ranges(), Some(72.1)).is_err());

        chs[0].output_eq.bands[0].active = true;
        chs[0].output_eq.bands[0].gain_db = 30.0;
        let clip = copy_from_project(&chs[0], ClipSection::OutputEq);
        assert!(paste_into_project(&mut chs[1], ClipSection::OutputEq, &clip, &ranges(), None).is_err());
    }
}
