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

use serde::{Deserialize, Serialize};
use specta::Type;

use super::amp_push::PushAction;
use super::project::{AmpChannel, ChannelEq, EqDirection, Limiter, PeakLimiter, RmsLimiter};
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

/// Which EQ side `section` means; only consulted for the EQ sections.
fn eq_side(section: ClipSection) -> EqDirection {
    match section {
        ClipSection::OutputEq => EqDirection::Output,
        _ => EqDirection::Input,
    }
}

pub fn paste_into_project(channel: &mut AmpChannel, section: ClipSection, clip: &ChannelClip) -> Result<(), String> {
    let direction = eq_side(section);
    let target_eq = match direction {
        EqDirection::Input => &channel.input_eq,
        EqDirection::Output => &channel.output_eq,
    };
    check(target_eq, clip, section)?;
    match clip {
        ChannelClip::Eq { eq } => match direction {
            EqDirection::Input => channel.input_eq = eq.clone(),
            EqDirection::Output => channel.output_eq = eq.clone(),
        },
        _ => channel.limiter = pasted_limiter(&channel.limiter, clip),
    }
    Ok(())
}

/// The writes that make `channel` (the last FC=27 snapshot) hold `clip` in
/// `section`. An EQ is one whole-chain write (FC=52) echoing the chain's
/// unmodelled bytes; a limiter stage is its own record, plus the other stage
/// when the peak floor had to be raised.
pub fn live_paste_actions(channel: &ChannelConfig, section: ClipSection, clip: &ChannelClip) -> Result<Vec<PushAction>, String> {
    let ch = channel.channel_index as u8;
    let direction = eq_side(section);
    let (target_eq, wire) = match direction {
        EqDirection::Input => (&channel.input_eq, &channel.input_eq_wire),
        EqDirection::Output => (&channel.output_eq, &channel.output_eq_wire),
    };
    check(target_eq, clip, section)?;
    if let ChannelClip::Eq { eq } = clip {
        return Ok(vec![PushAction::EqChain { channel: ch, direction, eq: eq.clone(), wire: wire.clone() }]);
    }

    let old = channel.limiter;
    let new = pasted_limiter(&old, clip);
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
    use crate::data::project::AmpAssignment;
    use crate::live::cvr::channel_config_v118::{parse_channel_config, BYTES_PER_CHANNEL, TRAILER_SIZE_V118};

    fn channels() -> Vec<AmpChannel> {
        AmpAssignment::new(None, None, 2, None, None).channels
    }

    #[test]
    fn eq_pastes_across_sides_and_kinds_are_checked() {
        let mut chs = channels();
        chs[0].input_eq.bands[3].gain_db = 4.5;
        let clip = copy_from_project(&chs[0], ClipSection::InputEq);

        paste_into_project(&mut chs[1], ClipSection::OutputEq, &clip).unwrap();
        assert_eq!(chs[1].output_eq.bands[3].gain_db, 4.5);
        assert!(paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip).is_err());
    }

    #[test]
    fn limiter_paste_keeps_hardware_facts_and_the_peak_floor() {
        let mut chs = channels();
        chs[0].limiter.rms.threshold_vrms = 100.0;
        chs[0].limiter.rms.max_vrms = 1.0;
        chs[1].limiter.rms.max_vrms = 200.0;
        chs[1].limiter.peak.threshold_vp = 50.0;
        let clip = copy_from_project(&chs[0], ClipSection::RmsLimiter);

        paste_into_project(&mut chs[1], ClipSection::RmsLimiter, &clip).unwrap();
        assert_eq!(chs[1].limiter.rms.threshold_vrms, 100.0);
        assert_eq!(chs[1].limiter.rms.max_vrms, 200.0, "the target amp's maximum stays");
        assert!((chs[1].limiter.peak.threshold_vp - 100.0 * std::f64::consts::SQRT_2).abs() < 1e-9);
    }

    #[test]
    fn live_paste_plans_one_chain_write_or_the_touched_stages() {
        let snapshot = parse_channel_config(&vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118], 4).unwrap();
        let live = &snapshot.channels[2];

        let eq = copy_from_live(&snapshot.channels[0], ClipSection::InputEq);
        let actions = live_paste_actions(live, ClipSection::OutputEq, &eq).unwrap();
        assert!(matches!(actions[..], [PushAction::EqChain { channel: 2, direction: EqDirection::Output, .. }]));

        let mut rms = live.limiter.rms;
        rms.threshold_vrms = 60.0;
        let actions = live_paste_actions(live, ClipSection::RmsLimiter, &ChannelClip::RmsLimiter { rms }).unwrap();
        assert!(matches!(actions[..], [PushAction::RmsLimiter { .. }, PushAction::PeakLimiter { .. }]), "floor raised the peak too");
    }
}
