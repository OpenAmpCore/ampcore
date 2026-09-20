//! Whether a project amp may be edited offline right now. A project amp that
//! is linked to an online network amp is locked while the two fingerprints
//! disagree (or can't be compared yet) — editing the plan would only widen a
//! gap between plan and hardware that nothing can resolve yet. Unlinked and
//! offline amps are always editable, as is one the user has manually
//! disengaged from its amp (`AmpAssignment.live_disengaged`) — that override
//! is the deliberate way out of a lock, and out of a live session.

use serde::Serialize;
use specta::Type;

use super::amp_model::AmpModelCatalogEntry;
use super::device_link::DeviceModelLink;
use super::fingerprint::{
    compare_fingerprints, fingerprint_live_device, fingerprint_project_amp, AmpFingerprint, FingerprintRow,
};
use super::project::{AmpAssignment, Project};
use crate::live::cvr::bridge::DeviceBridgeSnapshot;
use crate::live::cvr::channel_config::ChannelConfigSnapshot;
use crate::live::state::DiscoveredDevice;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AmpEditLockState {
    /// No MAC on the assignment — editable.
    Unlinked,
    /// Linked, but the network amp isn't discovered or is offline — editable.
    Offline,
    /// Online, but no FC=27 settings snapshot has arrived yet — locked.
    Checking,
    /// Amp hashes are equal — editable.
    Matches,
    /// Amp hashes differ — locked.
    Mismatch,
    /// A fingerprint couldn't be fully computed — locked.
    Unreadable,
    /// Online and readable, but the user has deliberately stepped out of the
    /// live session (`AmpAssignment.live_disengaged`) — editable, and nothing
    /// is written to the amp. Only ever resolved against a *reachable* amp:
    /// an unlinked or offline amp keeps its own state, since that is the
    /// honest reason it is editable.
    Disengaged,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AmpEditLock {
    pub state: AmpEditLockState,
    pub locked: bool,
    /// The linked network amp, when it is currently discovered.
    pub device_id: Option<String>,
    /// The amp's front-panel knob lock from its latest FC=27 snapshot.
    /// Informational only — it never affects `locked`.
    pub rotary_locked: Option<bool>,
    /// The amp's standby state from the same snapshot, and whether it is
    /// refusing standby writes. Carried here for exactly the reason
    /// `rotary_locked` is: these are amp-level controls a project amp's
    /// configure view offers whenever its linked amp is online, and this lock
    /// is that view's only channel to the live snapshot. Informational only —
    /// neither ever affects `locked`.
    pub standby: Option<bool>,
    pub standby_locked: Option<bool>,
    pub project: Option<AmpFingerprint>,
    pub live: Option<AmpFingerprint>,
    pub rows: Vec<FingerprintRow>,
    /// Why a fingerprint couldn't be computed, prefixed with its side.
    pub unreadable: Vec<String>,
}

/// What the live store currently knows about the linked network amp.
pub struct LiveAmpReading {
    pub device: DiscoveredDevice,
    pub snapshot: Option<ChannelConfigSnapshot>,
    pub bridge: Option<DeviceBridgeSnapshot>,
}

pub fn resolve_edit_lock(
    project: &Project,
    assignment: &AmpAssignment,
    models: &[AmpModelCatalogEntry],
    links: &[DeviceModelLink],
    reading: Option<&LiveAmpReading>,
) -> AmpEditLock {
    let mut lock = resolve_engaged_lock(project, assignment, models, links, reading);

    // Applied over the finished verdict rather than short-circuiting the
    // resolution: `rows`/`project`/`live` stay populated, so the comparison
    // still opens while disengaged and can show how far the plan has drifted
    // — which is the information needed before re-engaging. Only the state
    // and the lock itself are overridden.
    //
    // Unlinked and offline amps keep their own state so their own banner
    // shows: disengaging, losing the amp, and getting it back must land on
    // Offline and then back on Disengaged, not on Disengaged throughout.
    if assignment.live_disengaged
        && !matches!(
            lock.state,
            AmpEditLockState::Unlinked | AmpEditLockState::Offline
        )
    {
        lock.state = AmpEditLockState::Disengaged;
        lock.locked = false;
    }

    lock
}

/// The ordinary verdict, as if `live_disengaged` were never set.
fn resolve_engaged_lock(
    project: &Project,
    assignment: &AmpAssignment,
    models: &[AmpModelCatalogEntry],
    links: &[DeviceModelLink],
    reading: Option<&LiveAmpReading>,
) -> AmpEditLock {
    let mut lock = AmpEditLock {
        state: AmpEditLockState::Unlinked,
        locked: false,
        device_id: reading.map(|r| r.device.id.clone()),
        rotary_locked: reading.and_then(|r| r.snapshot.as_ref()).and_then(|s| s.rotary_locked),
        standby: reading.and_then(|r| r.snapshot.as_ref()).and_then(|s| s.standby),
        standby_locked: reading.and_then(|r| r.snapshot.as_ref()).and_then(|s| s.standby_locked),
        project: None,
        live: None,
        rows: Vec::new(),
        unreadable: Vec::new(),
    };

    if assignment.mac.is_none() {
        return lock;
    }
    let Some(reading) = reading.filter(|r| r.device.online) else {
        lock.state = AmpEditLockState::Offline;
        return lock;
    };

    let project_fp = fingerprint_project_amp(project, assignment, models);
    let Some(snapshot) = &reading.snapshot else {
        lock.state = AmpEditLockState::Checking;
        lock.locked = true;
        lock.project = Some(project_fp);
        return lock;
    };
    let live_fp = fingerprint_live_device(&reading.device, snapshot, reading.bridge.as_ref(), models, links);

    lock.unreadable = project_fp
        .missing
        .iter()
        .map(|m| format!("Project: {m}"))
        .chain(live_fp.missing.iter().map(|m| format!("Amp: {m}")))
        .collect();
    lock.state = if !lock.unreadable.is_empty() {
        AmpEditLockState::Unreadable
    } else if project_fp.amp_hash == live_fp.amp_hash {
        AmpEditLockState::Matches
    } else {
        AmpEditLockState::Mismatch
    };
    lock.locked = lock.state != AmpEditLockState::Matches;
    lock.rows = compare_fingerprints(&project_fp, &live_fp);
    lock.project = Some(project_fp);
    lock.live = Some(live_fp);
    lock
}
