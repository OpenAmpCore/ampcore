use super::*;

/// One compared setting of two fingerprints. Values are formatted at exactly
/// the precision the hash encodes, and a value the hash skips (bypassed band,
/// disabled limiter, inactive crosspoint, unused gain/Q) is shown as
/// "bypassed"/"off" — so two rows are equal exactly when they hash equal, and
/// the red highlights can never disagree with the lock.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintRow {
    /// "Amp", "In 1", "Out A", …
    pub group: String,
    pub label: String,
    /// `None` when this side has no such setting (e.g. a channel the other
    /// side lacks).
    pub project: Option<String>,
    pub live: Option<String>,
    pub differs: bool,
    /// `false` for status rows (standby, preset name, knob lock) and for
    /// backup priority (unverified — see the module doc comment): shown for
    /// context, never compared.
    pub hashed: bool,
}

pub(super) struct Entry {
    pub(super) group: String,
    pub(super) label: String,
    pub(super) value: String,
    pub(super) hashed: bool,
}

pub(super) fn push_entry(out: &mut Vec<Entry>, group: &str, label: impl Into<String>, value: impl Into<String>) {
    out.push(Entry { group: group.to_string(), label: label.into(), value: value.into(), hashed: true });
}

pub(super) fn push_status(out: &mut Vec<Entry>, label: &str, value: String) {
    out.push(Entry { group: "Status".to_string(), label: label.to_string(), value, hashed: false });
}

/// Like `push_entry`, but for a setting that's shown for context and never
/// compared — currently only `backup_priority` (see the module doc comment).
pub(super) fn push_info(out: &mut Vec<Entry>, group: &str, label: impl Into<String>, value: impl Into<String>) {
    out.push(Entry { group: group.to_string(), label: label.into(), value: value.into(), hashed: false });
}

pub(super) fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

pub(crate) fn format_crossover(slot: &CrossoverCanonical) -> String {
    if slot.active {
        format!("{:?} · {:.1} Hz", slot.filter_type, slot.freq_hz)
    } else {
        "off".to_string()
    }
}

pub(crate) fn format_band(band: &EqBandCanonical) -> String {
    if !band.active {
        return "bypassed".to_string();
    }
    let mut parts = vec![format!("{:?}", band.filter_type), format!("{:.1} Hz", band.freq_hz)];
    if let Some(gain) = band.gain_db {
        parts.push(format!("{:+.2} dB", gain));
    }
    if let Some(q) = band.q {
        parts.push(format!("Q {:.3}", q));
    }
    parts.join(" · ")
}

pub(super) fn eq_entries(out: &mut Vec<Entry>, group: &str, prefix: &str, eq: &EqCanonical) {
    push_entry(out, group, format!("{prefix} · HP"), format_crossover(&eq.hp));
    for (index, band) in eq.bands.iter().enumerate() {
        push_entry(out, group, format!("{prefix} · Band {}", index + 1), format_band(band));
    }
    push_entry(out, group, format!("{prefix} · LP"), format_crossover(&eq.lp));
}

/// Every hashed setting of a fingerprint as display entries, in a stable
/// order: amp identity and bridging, then inputs (numbered), then outputs
/// (lettered).
pub(super) fn hashed_entries(fp: &AmpFingerprint) -> Vec<Entry> {
    let mut out = Vec::new();
    let identity = &fp.identity;
    push_entry(&mut out, "Amp", "Model", identity.model.clone().unwrap_or_else(|| "—".to_string()));
    push_entry(&mut out, "Amp", "Output channels", identity.channel_count.to_string());
    push_entry(&mut out, "Amp", "Firmware", identity.firmware_family.clone().unwrap_or_else(|| "—".to_string()));
    let settings = &fp.settings;
    let device_name = if settings.device_name.is_empty() { "(unset)".to_string() } else { settings.device_name.clone() };
    push_entry(&mut out, "Amp", "Device name", device_name);
    for (pair, bridged) in fp.bridged_pairs.iter().enumerate() {
        let leader = (pair * 2) as u32;
        let value = match bridged {
            Some(true) => "bridged",
            Some(false) => "off",
            None => "not reported",
        };
        push_entry(&mut out, "Amp", format!("Bridge {}/{}", output_letter(leader), output_letter(leader + 1)), value);
    }

    let mut channels: Vec<&ChannelFingerprint> = fp.channels.iter().collect();
    channels.sort_by_key(|c| c.channel_index);

    for channel in &channels {
        let group = format!("In {}", channel.channel_index + 1);
        let fields = &channel.amp_fields;
        let source = match fields.source {
            Some(source) => format!("{:?} {}", source.kind, source.index + 1),
            None => "unreadable".to_string(),
        };
        push_entry(&mut out, &group, "Source", source);
        eq_entries(&mut out, &group, "Input EQ", &fields.input_eq);
        push_entry(&mut out, &group, "Input delay", format!("{:.2} ms", fields.delay_in_ms));
        let gate = match (fields.noise_gate_enabled, fields.noise_gate_threshold_dbu) {
            (true, Some(threshold)) => format!("on · {threshold:+.0} dBu"),
            (enabled, _) => on_off(enabled).to_string(),
        };
        push_entry(&mut out, &group, "Noise gate", gate);
        let name = if fields.input_name.is_empty() { "(default)".to_string() } else { fields.input_name.clone() };
        push_entry(&mut out, &group, "Name", name);
        push_entry(&mut out, &group, "Mute", on_off(fields.input_muted));
        let trims = &fields.source_trims;
        for (label, trim) in [("Analog trim", trims.analog), ("Dante trim", trims.dante)] {
            push_entry(&mut out, &group, label, format!("{:+.2} dB · {:.2} ms", trim.trim_db, trim.delay_ms));
        }
        let priority = &fields.backup_priority;
        let priority_value = if priority.enabled {
            format!(
                "first code {} · second code {} · threshold {} dB",
                priority.first, priority.second, priority.threshold_db
            )
        } else {
            "off".to_string()
        };
        push_info(&mut out, &group, "Backup priority", priority_value);
    }

    for channel in &channels {
        let group = format!("Out {}", channel.label);
        let fields = &channel.amp_fields;
        let speaker = &channel.speaker;
        for cp in &fields.matrix_crosspoints {
            let value = if cp.active { format!("{:+.2} dB", cp.gain_db) } else { "off".to_string() };
            push_entry(&mut out, &group, format!("Matrix · In {}", cp.source_index + 1), value);
        }
        push_entry(&mut out, &group, "Trim", format!("{:+.2} dB", fields.output_trim_db));
        push_entry(&mut out, &group, "Volume", format!("{:+.2} dB", fields.output_volume_db));
        push_entry(&mut out, &group, "Mute", on_off(fields.output_muted));
        let name =
            if fields.output_name_base.is_empty() { "(default)".to_string() } else { fields.output_name_base.clone() };
        push_entry(&mut out, &group, "Name", name);
        eq_entries(&mut out, &group, "Output EQ", &speaker.output_eq);
        let rms = &speaker.rms_limiter;
        let rms_value = if rms.enabled {
            format!(
                "{:.2} Vrms · {:.0} ms attack · ×{:.0} release · auto {} · max {:.2} V",
                rms.threshold_vrms,
                rms.attack_ms,
                rms.release_multiplier,
                on_off(rms.auto),
                rms.max_vrms
            )
        } else {
            "off".to_string()
        };
        push_entry(&mut out, &group, "RMS limiter", rms_value);
        let peak = &speaker.peak_limiter;
        let peak_value = if peak.enabled {
            format!(
                "{:.2} Vp · {:.0} ms hold · {:.0} ms release · max {:.2} Vp",
                peak.threshold_vp, peak.hold_ms, peak.release_ms, peak.max_vp
            )
        } else {
            "off".to_string()
        };
        push_entry(&mut out, &group, "Peak limiter", peak_value);
        push_entry(&mut out, &group, "Output delay", format!("{:.2} ms", speaker.delay_out_ms));
        push_entry(&mut out, &group, "Polarity", if speaker.phase_inverted { "inverted" } else { "normal" });
        let power_mode = speaker.power_mode.map(|m| format!("{m:?}")).unwrap_or_else(|| "unreadable".to_string());
        push_entry(&mut out, &group, "Power mode", power_mode);
        push_entry(&mut out, &group, "FIR", if speaker.fir_bypassed { "bypassed" } else { "active" });
        let fir = channel.fir.as_ref();
        push_entry(&mut out, &group, "FIR filter", fir.map_or("not read yet".to_string(), |f| f.summary.clone()));
        // The name is a label an amp may not even report — see the module doc.
        push_info(&mut out, &group, "FIR name", fir.and_then(|f| f.name.clone()).unwrap_or_else(|| "—".to_string()));
    }

    if fp.origin.kind == FingerprintSource::Online {
        let status = &fp.status;
        let flag = |value: Option<bool>, on: &str, off: &str| match value {
            Some(true) => on.to_string(),
            Some(false) => off.to_string(),
            None => "—".to_string(),
        };
        let standby_text = match (status.standby, status.standby_locked) {
            (Some(true), Some(true)) => "standby (locked out)".to_string(),
            (value, _) => flag(value, "standby", "on"),
        };
        push_status(&mut out, "Standby", standby_text);
        push_status(&mut out, "Preset", status.preset_name.clone().unwrap_or_else(|| "—".to_string()));
        push_status(&mut out, "Front panel lock", flag(status.rotary_locked, "locked", "unlocked"));
    }

    out
}

/// Side-by-side rows for a project and a live fingerprint. Rows follow the
/// project's order; settings only the live side has are appended. If the amp
/// hashes differ but no row does, one explicit "Amp hash" row is added — a
/// lock must never appear without a visible reason.
pub fn compare_fingerprints(project: &AmpFingerprint, live: &AmpFingerprint) -> Vec<FingerprintRow> {
    let mut live_entries: Vec<Option<Entry>> = hashed_entries(live).into_iter().map(Some).collect();
    let mut rows = Vec::new();

    for entry in hashed_entries(project) {
        let live_value = live_entries
            .iter_mut()
            .find(|e| e.as_ref().is_some_and(|e| e.group == entry.group && e.label == entry.label))
            .and_then(Option::take)
            .map(|e| e.value);
        let differs = entry.hashed && live_value.as_deref() != Some(entry.value.as_str());
        rows.push(FingerprintRow {
            group: entry.group,
            label: entry.label,
            project: Some(entry.value),
            live: live_value,
            differs,
            hashed: entry.hashed,
        });
    }
    for entry in live_entries.into_iter().flatten() {
        rows.push(FingerprintRow {
            group: entry.group,
            label: entry.label,
            project: None,
            live: Some(entry.value),
            differs: entry.hashed,
            hashed: entry.hashed,
        });
    }

    let hashes_differ = project.amp_hash.is_some() && live.amp_hash.is_some() && project.amp_hash != live.amp_hash;
    if hashes_differ && !rows.iter().any(|r| r.differs) {
        rows.push(FingerprintRow {
            group: "Amp".to_string(),
            label: "Amp hash".to_string(),
            project: project.amp_hash.clone(),
            live: live.amp_hash.clone(),
            differs: true,
            hashed: true,
        });
    }
    rows
}

// ---------------------------------------------------------------------------
// Hash functions
// ---------------------------------------------------------------------------
