//! CVR firmware 1.1.9 FC=27 (SYNC_DATA) response -> per-channel DSP config.
//!
//! 1.1.9 is the vendor's `SynData_Whole119`: the complete 1.1.8 payload
//! (`SynData_Tecnare118`, parsed by `channel_config_v118`), then
//! `NoiseGates: sbyte[4]` (output gate threshold in dBu, one per channel),
//! then 451 padding bytes. The vendor's `RD_44.setSynData_Whole119` composes
//! it the same way. Measured on a DSP-3004D `…106119`: 2232 + 455 = 2687.

use super::channel_config::ChannelConfigSnapshot;

const EXTENSION: usize = 4 + 451;

pub fn parse_channel_config(body: &[u8], output_channels: u32) -> Option<ChannelConfigSnapshot> {
    let v118_len = body.len().checked_sub(EXTENSION)?;
    let mut snapshot = super::channel_config_v118::parse_channel_config(&body[..v118_len], output_channels)?;
    for channel in &mut snapshot.channels {
        channel.noise_gate_threshold_dbu = Some(body[v118_len + channel.channel_index as usize] as i8);
    }
    Some(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::channel_config_v118::{BYTES_PER_CHANNEL, TRAILER_SIZE_V118};

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
}
