//! CVR firmware 1.1.9 FC=27 (SYNC_DATA) response -> per-channel DSP config.
//!
//! 1.1.9 is the vendor's `SynData_Whole119`: the complete 1.1.8 payload
//! (`SynData_Tecnare118`, parsed by `channel_config_v118`), then
//! `NoiseGates: sbyte[4]` (output gate threshold in dBu, one per channel),
//! then 451 padding bytes. The vendor's `RD_44.setSynData_Whole119` composes
//! it the same way. Measured on a DSP-3004D `…106119`: 2232 + 455 = 2687.
//!
//! The 1.1.8 trailer's `Gains[4]` (f32 dB per channel) is read here, not in
//! `channel_config_v118`: only 1.1.9 firmware fills and uses it.

use super::channel_config::ChannelConfigSnapshot;
use super::channel_config_v118::{f32_le, TRAILER_SIZE_V118};

const EXTENSION: usize = 4 + 451;

pub fn parse_channel_config(body: &[u8], output_channels: u32) -> Option<ChannelConfigSnapshot> {
    let v118_len = body.len().checked_sub(EXTENSION)?;
    let mut snapshot = super::channel_config_v118::parse_channel_config(&body[..v118_len], output_channels)?;
    let gains = v118_len - TRAILER_SIZE_V118 + 156;
    for channel in &mut snapshot.channels {
        let ch = channel.channel_index as usize;
        channel.noise_gate_threshold_dbu = Some(body[v118_len + ch] as i8);
        // 36.0 on all four channels of a 1.1.9 DSP-2004.
        channel.amp_gain_db = Some(f32_le(body, gains + ch * 4)).filter(|g| *g > 0.0);
    }
    Some(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::channel_config_v118::BYTES_PER_CHANNEL;

    #[test]
    fn wraps_the_1_1_8_payload_and_reads_gate_thresholds() {
        let v118_len = 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118;
        let mut body = vec![1u8; v118_len + EXTENSION];
        body[4 * BYTES_PER_CHANNEL + 133] = 0; // ch1 muted, in the 1.1.8 trailer
        body[v118_len..v118_len + 4].copy_from_slice(&[-40i8 as u8, -70i8 as u8, 0, 5]);

        let snapshot = parse_channel_config(&body, 4).unwrap();
        assert_eq!(snapshot.channels.iter().map(|c| c.input_muted).collect::<Vec<_>>(), [false, true, false, false]);
        assert_eq!(
            snapshot.channels.iter().map(|c| c.noise_gate_threshold_dbu).collect::<Vec<_>>(),
            [Some(-40), Some(-70), Some(0), Some(5)]
        );

        assert!(parse_channel_config(&body[..v118_len], 4).is_none(), "a 1.1.8-sized payload is not 1.1.9");
    }

    #[test]
    fn amp_gain_is_read_per_channel_from_the_trailer() {
        let gains = 4 * BYTES_PER_CHANNEL + 156;
        let mut body = vec![0u8; 4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118 + EXTENSION];
        body[gains..gains + 4].copy_from_slice(&36.0f32.to_le_bytes());
        body[gains + 4..gains + 8].copy_from_slice(&31.5f32.to_le_bytes());
        // Channel 2 left at 0.0, channel 3 negative: neither is a gain.
        body[gains + 12..gains + 16].copy_from_slice(&(-6.0f32).to_le_bytes());
        let snapshot = parse_channel_config(&body, 4).unwrap();
        assert_eq!(
            snapshot.channels.iter().map(|c| c.amp_gain_db).collect::<Vec<_>>(),
            [Some(36.0), Some(31.5), None, None]
        );
        // 1.1.8 firmware never fills these bytes, so its parser ignores them.
        let v118 = super::super::channel_config_v118::parse_channel_config(&body[..4 * BYTES_PER_CHANNEL + TRAILER_SIZE_V118], 4).unwrap();
        assert!(v118.channels.iter().all(|c| c.amp_gain_db.is_none()));
    }
}
