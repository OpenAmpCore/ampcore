//! FC=57 (`SpeakerData`) blobs, as carried (hex) by the old app's speaker
//! preset files. Ground-truthed against Hagen's clone
//! (`lib/parse-speaker-data.ts`); the vendor's own struct is `Speaker_data.cs`.
//!
//! Decode only. The vendor never builds an FC=57 blob from values — it is
//! copy→paste of a whole channel's speaker processing — so neither do we.
//!
//! Only the two layouts seen on this app's amps are decoded: 117 (2310 B) and
//! Tecnare (117 + a 105-byte "DEQ" block, 2415 B). Every one of Hagen's files
//! is Tecnare. The older 157/2216/2252/2294-byte variants are rejected by name.
//!
//! Blob layout (117; Tecnare appends DEQ at +2310, which is not decoded):
//! ```text
//! +0     32  device name   amp-stamped on store, never round-trips
//! +32    32  FIR name
//! +64  2048  FIR taps      f32[512]
//! +2112   1  FIR bypass    1 = bypassed
//! +2113 141  EQ chain      10 × 14 B + chain bypass — the same block as FC=27
//! +2254   4  volume        f32 dB
//! +2258   4  delay         f32 ms
//! +2262   1  polarity      1 = inverted
//! +2263  13  RMS limiter   u16 attack, u8 release×, f32 thr, u8 bypass, u8 auto(0 = on), f32 max
//! +2276  13  peak limiter  u16 hold, u16 release, f32 thr, u8 bypass, f32 max
//! +2289   1  mute          0 = muted
//! +2290   4  load          f32 Ω
//! +2294  16  speaker name
//! ```
//! The limiter blocks have the same shape as their FC=27 counterparts (offset
//! 95/108 in a channel body), so they decode with the same rules.

use crate::data::project::{ChannelEq, Limiter, PeakLimiter, RmsLimiter};

use super::channel_config_v118::{ascii_n, f32_le, parse_eq_block, u16_le, u8_at};
use super::fir::FIR_MAX_TAPS;

pub const FC_SPEAKER_DATA: u8 = 57;

const LEN_117: usize = 2310;
const LEN_TECNARE: usize = 2415;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakerDataVariant {
    V117,
    Tecnare,
}

/// One way's speaker processing, as stored in an FC=57 blob.
#[derive(Debug, Clone)]
pub struct SpeakerData {
    pub variant: SpeakerDataVariant,
    pub fir_name: Option<String>,
    pub fir_taps: Vec<f32>,
    pub fir_bypassed: bool,
    pub eq: ChannelEq,
    pub volume_db: f32,
    pub delay_ms: f32,
    pub phase_inverted: bool,
    pub limiter: Limiter,
    pub muted: bool,
    pub load_ohms: f32,
    pub speaker_name: Option<String>,
}

pub fn decode_speaker_data(blob: &[u8]) -> Result<SpeakerData, String> {
    let variant = match blob.len() {
        LEN_117 => SpeakerDataVariant::V117,
        LEN_TECNARE => SpeakerDataVariant::Tecnare,
        157 => return Err("YCST speaker data (157 bytes) is not supported".into()),
        2216 | 2252 | 2294 => return Err(format!("legacy speaker data ({} bytes) is not supported", blob.len())),
        n => return Err(format!("unknown speaker data size: {n} bytes")),
    };
    let eq = parse_eq_block(blob, 2113);
    Ok(SpeakerData {
        variant,
        fir_name: ascii_n(blob, 32, 32).filter(|n| n != "---"),
        fir_taps: (0..FIR_MAX_TAPS).map(|i| f32_le(blob, 64 + i * 4)).collect(),
        fir_bypassed: u8_at(blob, 2112) != 0,
        eq: ChannelEq { hp: eq.hp, bands: eq.bands, lp: eq.lp },
        volume_db: f32_le(blob, 2254),
        delay_ms: f32_le(blob, 2258),
        phase_inverted: u8_at(blob, 2262) != 0,
        limiter: Limiter {
            rms: RmsLimiter {
                attack_ms: u16_le(blob, 2263) as f64,
                release_multiplier: u8_at(blob, 2265) as f64,
                threshold_vrms: f32_le(blob, 2266) as f64,
                enabled: u8_at(blob, 2270) == 0,
                auto: u8_at(blob, 2271) == 0,
                max_vrms: f32_le(blob, 2272) as f64,
            },
            peak: PeakLimiter {
                hold_ms: u16_le(blob, 2276) as f64,
                release_ms: u16_le(blob, 2278) as f64,
                threshold_vp: f32_le(blob, 2280) as f64,
                enabled: u8_at(blob, 2284) == 0,
                max_vp: f32_le(blob, 2285) as f64,
            },
        },
        muted: u8_at(blob, 2289) == 0,
        load_ohms: f32_le(blob, 2290),
        speaker_name: ascii_n(blob, 2294, 16),
    })
}

/// Hex text (the old app's `deviceData.hex`) to bytes.
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, String> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return Err("not valid hex".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| "not valid hex".to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::capability::CrossoverFilterType;

    fn put_f32(b: &mut [u8], off: usize, v: f32) {
        b[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn put_str(b: &mut [u8], off: usize, s: &str) {
        b[off..off + s.len()].copy_from_slice(s.as_bytes());
    }

    /// A Tecnare blob with the values Hagen's `Seeburg_PS1_Hi` preset decodes to.
    fn seeburg_like_blob() -> Vec<u8> {
        let mut b = vec![0u8; LEN_TECNARE];
        put_str(&mut b, 0, "42424B06-006118-DSP-2004D");
        put_str(&mut b, 32, "---");
        put_f32(&mut b, 64, 1.0);
        b[2112] = 1;
        // Band 0 is the HP slot, in crossover vocabulary: code 3 = Butterworth
        // 18 dB/oct at 297 Hz. (Hagen's parser reads it with EQ codes, as
        // "All-Pass 1st".) Bands 6..=9 are off (0xFF).
        b[2113] = 3;
        put_f32(&mut b, 2113 + 5, 297.0);
        // Band 1: peaking −4 dB @ 531 Hz, Q 3.4.
        let band1 = 2113 + 14;
        b[band1] = 0;
        put_f32(&mut b, band1 + 1, -4.0);
        put_f32(&mut b, band1 + 5, 531.0);
        put_f32(&mut b, band1 + 9, 3.4);
        for band in 6..10 {
            b[2113 + band * 14] = 0xFF;
        }
        put_f32(&mut b, 2254, 18.0);
        put_f32(&mut b, 2258, 2.5);
        b[2263..2265].copy_from_slice(&25u16.to_le_bytes());
        b[2265] = 16;
        put_f32(&mut b, 2266, 48.99);
        b[2271] = 0; // auto on
        b[2276..2278].copy_from_slice(&50u16.to_le_bytes());
        b[2278..2280].copy_from_slice(&300u16.to_le_bytes());
        put_f32(&mut b, 2280, 89.44);
        b[2289] = 1; // not muted
        put_f32(&mut b, 2290, 16.0);
        put_str(&mut b, 2294, "PS1HI");
        b
    }

    #[test]
    fn decodes_tecnare_blob() {
        let d = decode_speaker_data(&seeburg_like_blob()).unwrap();
        assert_eq!(d.variant, SpeakerDataVariant::Tecnare);
        assert_eq!(d.fir_name, None, "`---` is the vendor's empty FIR name");
        assert_eq!(d.fir_taps.len(), FIR_MAX_TAPS);
        assert_eq!(d.fir_taps[0], 1.0);
        assert!(d.fir_bypassed);
        assert_eq!(d.eq.hp.filter_type, CrossoverFilterType::Butterworth18);
        assert!(d.eq.hp.active);
        assert_eq!(d.eq.hp.freq_hz, 297.0);
        assert_eq!(d.eq.bands.len(), 8);
        let b1 = &d.eq.bands[0];
        assert!(b1.active);
        assert_eq!((b1.gain_db as f32, b1.freq_hz as f32, b1.q as f32), (-4.0, 531.0, 3.4));
        assert!(d.eq.bands[5..].iter().all(|b| !b.active), "0xFF bands are off");
        assert!(!d.eq.lp.active);
        assert_eq!((d.volume_db, d.delay_ms), (18.0, 2.5));
        assert!(!d.phase_inverted);
        let rms = d.limiter.rms;
        assert!(rms.enabled && rms.auto);
        assert_eq!((rms.attack_ms, rms.release_multiplier, rms.threshold_vrms as f32), (25.0, 16.0, 48.99));
        let peak = d.limiter.peak;
        assert!(peak.enabled);
        assert_eq!((peak.hold_ms, peak.release_ms, peak.threshold_vp as f32), (50.0, 300.0, 89.44));
        assert!(!d.muted);
        assert_eq!(d.load_ohms, 16.0);
        assert_eq!(d.speaker_name.as_deref(), Some("PS1HI"));
    }

    #[test]
    fn decodes_117_and_rejects_other_sizes() {
        let blob = seeburg_like_blob();
        assert_eq!(decode_speaker_data(&blob[..LEN_117]).unwrap().variant, SpeakerDataVariant::V117);
        for n in [0, 157, 2216, 2252, 2294, 2400] {
            assert!(decode_speaker_data(&vec![0; n]).is_err(), "{n} bytes must be rejected");
        }
    }

    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        assert_eq!(hex_to_bytes("00ff10").unwrap(), [0, 255, 16]);
        assert!(hex_to_bytes("0f1").is_err() && hex_to_bytes("zz").is_err());
    }
}
