use super::*;

pub(super) fn row(group: &str, label: &str, project: String, live: String) -> FingerprintRow {
    let differs = project != live;
    FingerprintRow {
        group: group.to_string(),
        label: label.to_string(),
        project: Some(project),
        live: Some(live),
        differs,
        hashed: true,
    }
}

/// The hashed fields a push doesn't write, wherever the two sides disagree —
/// `max_vrms`, `max_vp`. Rendered under the plan so adopting the amp's
/// value is a visible consequence of pushing, not a silent edit.
pub fn adopted_rows(assignment: &AmpAssignment, snapshot: &ChannelConfigSnapshot) -> Vec<FingerprintRow> {
    let mut rows = Vec::new();
    for channel in &assignment.channels {
        let index = channel.channel_index;
        let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == index) else { continue };
        let group = format!("Out {}", output_letter(index));

        // Max voltages are only hashed while their stage is enabled, so they
        // can only force a mismatch there.
        let (rms, live_rms) = (&channel.limiter.rms, &config.limiter.rms);
        if (rms.enabled || live_rms.enabled) && differs(rms.max_vrms, live_rms.max_vrms, VOLT_STEPS) {
            rows.push(row(
                &group,
                "RMS limiter max",
                format!("{:.2} V", round_to_step(rms.max_vrms, VOLT_STEPS)),
                format!("{:.2} V", round_to_step(live_rms.max_vrms, VOLT_STEPS)),
            ));
        }
        let (peak, live_peak) = (&channel.limiter.peak, &config.limiter.peak);
        if (peak.enabled || live_peak.enabled) && differs(peak.max_vp, live_peak.max_vp, VOLT_STEPS) {
            rows.push(row(
                &group,
                "Peak limiter max",
                format!("{:.2} Vp", round_to_step(peak.max_vp, VOLT_STEPS)),
                format!("{:.2} Vp", round_to_step(live_peak.max_vp, VOLT_STEPS)),
            ));
        }
    }
    rows
}

/// Copies the two read-only device facts into `assignment`, at exactly the
/// steps the hash sees (the same rule `amp_merge.rs` follows). Called as part
/// of saving a push, so the project ends up describing the amp it is linked to
/// rather than an impossible one.
pub fn adopt_device_facts(assignment: &mut AmpAssignment, snapshot: &ChannelConfigSnapshot) {
    for channel in &mut assignment.channels {
        let Some(config) = snapshot.channels.iter().find(|c| c.channel_index == channel.channel_index) else {
            continue;
        };
        channel.limiter.rms.max_vrms = round_to_step(config.limiter.rms.max_vrms, VOLT_STEPS);
        channel.limiter.peak.max_vp = round_to_step(config.limiter.peak.max_vp, VOLT_STEPS);
    }
}

// ---------------------------------------------------------------------------
// Encoding — one planned action to its packet(s)
// ---------------------------------------------------------------------------

/// What a pushed candidate stores: `current` (the project amp as it is when the
/// push ends) with only what `edited` changed from `base` (the copy it was made
/// from) laid over it. A push runs for seconds; storing `edited` whole would
/// undo every edit that reached the project meanwhile — a pull, another
/// Workspace action. Values are compared field by field, arrays index by index
/// while all three are the same length (else `edited`'s array wins whole).
pub fn rebase_candidate(
    current: &AmpAssignment,
    base: &AmpAssignment,
    edited: &AmpAssignment,
) -> Result<AmpAssignment, serde_json::Error> {
    use serde_json::{to_value, Value};

    fn lay(current: &mut Value, base: &Value, edited: &Value) {
        if base == edited {
            return;
        }
        match (current, base, edited) {
            (Value::Object(c), Value::Object(b), Value::Object(e)) => {
                for (key, ev) in e {
                    match (c.get_mut(key), b.get(key)) {
                        (Some(cv), Some(bv)) => lay(cv, bv, ev),
                        _ => {
                            c.insert(key.clone(), ev.clone());
                        }
                    }
                }
                for key in b.keys().filter(|k| !e.contains_key(*k)) {
                    c.remove(key);
                }
            }
            (Value::Array(c), Value::Array(b), Value::Array(e)) if c.len() == b.len() && b.len() == e.len() => {
                for ((cv, bv), ev) in c.iter_mut().zip(b).zip(e) {
                    lay(cv, bv, ev);
                }
            }
            (c, _, e) => *c = e.clone(),
        }
    }

    let mut merged = to_value(current)?;
    lay(&mut merged, &to_value(base)?, &to_value(edited)?);
    serde_json::from_value(merged)
}
