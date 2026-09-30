//! FC=57 (`SpeakerData`) blobs and the vendor's `.sl` speaker files that
//! carry them. Ground-truthed against Hagen's clone
//! (`lib/parse-speaker-data.ts`, `app/api/library/import-sl/route.ts`) and
//! his `.sl` exports; the vendor's own struct is `Speaker_data.cs`.
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

/// A vendor `.sl` file: a 254-byte text header, then one FC=57 blob per way.
#[derive(Debug, Clone)]
pub struct SlFile {
    pub brand: String,
    pub family: String,
    pub model: String,
    /// Split from the header's `|`-separated field. Not guaranteed to have
    /// one label per way — the vendor doesn't enforce it.
    pub way_labels: Vec<String>,
    pub notes: String,
    /// Raw blobs, all the same size. Decode each with `decode_speaker_data`.
    pub ways: Vec<Vec<u8>>,
}

const SL_HEADER_LEN: usize = 254;
const SL_MAX_WAYS: usize = 8;

pub fn parse_sl(bytes: &[u8]) -> Result<SlFile, String> {
    if bytes.len() <= SL_HEADER_LEN {
        return Err(format!("too short for a .sl file ({} bytes)", bytes.len()));
    }
    let text = |off, len| ascii_n(bytes, off, len).unwrap_or_default();
    let way_count = i32::from_le_bytes(bytes[250..254].try_into().unwrap());
    if !(1..=SL_MAX_WAYS as i32).contains(&way_count) {
        return Err(format!("way count {way_count} is outside 1..={SL_MAX_WAYS}"));
    }
    let data = &bytes[SL_HEADER_LEN..];
    if data.len() % way_count as usize != 0 {
        return Err(format!("{} data bytes don't split into {way_count} ways", data.len()));
    }
    Ok(SlFile {
        brand: text(0, 40),
        family: text(40, 40),
        model: text(80, 40),
        way_labels: text(120, 50).split('|').map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect(),
        notes: text(170, 80),
        ways: data.chunks(data.len() / way_count as usize).map(<[u8]>::to_vec).collect(),
    })
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

    /// A Tecnare blob with the values Hagen's `Seeburg_PS1_Hi.sl` decodes to.
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

    fn sl(way_count: i32, labels: &str, ways: &[Vec<u8>]) -> Vec<u8> {
        let mut h = vec![0u8; SL_HEADER_LEN];
        put_str(&mut h, 0, "Seeburg");
        put_str(&mut h, 40, "PS1");
        put_str(&mut h, 80, "Hi");
        put_str(&mut h, 120, labels);
        put_str(&mut h, 170, "Notes");
        h[250..254].copy_from_slice(&way_count.to_le_bytes());
        ways.iter().for_each(|w| h.extend_from_slice(w));
        h
    }

    #[test]
    fn parses_sl_header_and_ways() {
        let blob = seeburg_like_blob();
        let f = parse_sl(&sl(2, "MF/HF|Sub-Low", &[blob.clone(), blob.clone()])).unwrap();
        assert_eq!((f.brand.as_str(), f.family.as_str(), f.model.as_str(), f.notes.as_str()), ("Seeburg", "PS1", "Hi", "Notes"));
        assert_eq!(f.way_labels, ["MF/HF", "Sub-Low"], "labels split on `|` only");
        assert_eq!(f.ways.len(), 2);
        assert!(f.ways.iter().all(|w| w == &blob));
    }

    #[test]
    fn rejects_bad_sl() {
        let blob = seeburg_like_blob();
        assert!(parse_sl(&[0; SL_HEADER_LEN]).is_err(), "header only");
        assert!(parse_sl(&sl(0, "", &[blob.clone()])).is_err(), "zero ways");
        assert!(parse_sl(&sl(9, "", &[blob.clone()])).is_err(), "too many ways");
        let mut odd = sl(2, "", &[blob.clone(), blob]);
        odd.pop();
        assert!(parse_sl(&odd).is_err(), "data not divisible by way count");
    }

    /// Ground truth against Hagen's real exports, which aren't in the repo.
    /// Run with `cargo test -p ampcore-core -- --ignored hagen`.
    #[test]
    #[ignore]
    fn hagen_sl_files() {
        let dir = std::path::Path::new(r"C:\Users\Pascal\Downloads\hagen configs");
        let mut count = 0;
        for entry in std::fs::read_dir(dir).expect("hagen configs folder") {
            let path = entry.unwrap().path();
            let f = parse_sl(&std::fs::read(&path).unwrap()).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            for way in &f.ways {
                decode_speaker_data(way).unwrap_or_else(|e| panic!("{path:?}: {e}"));
            }
            count += 1;
        }
        assert!(count > 0);

        let f = parse_sl(&std::fs::read(dir.join("Seeburg_PS1_Hi.sl")).unwrap()).unwrap();
        assert_eq!((f.brand.as_str(), f.family.as_str(), f.model.as_str()), ("Seeburg", "PS1", "Hi"));
        let d = decode_speaker_data(&f.ways[0]).unwrap();
        assert_eq!((d.volume_db, d.delay_ms, d.load_ohms), (18.0, 2.5, 16.0));
        assert_eq!(d.eq.bands.iter().filter(|b| b.active).count(), 5);
        assert_eq!(d.speaker_name.as_deref(), Some("PS1HI"));
    }
}
