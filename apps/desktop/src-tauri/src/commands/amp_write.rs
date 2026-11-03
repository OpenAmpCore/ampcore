//! The one way a change reaches a project amp, and through it the linked amp.
//! Every amp-changing project command goes through `save_or_push`, so every
//! caller — an editor, the Workspace, a batch over several amps — gets the
//! same rule without knowing about links, locks or sessions:
//!
//! - unlinked, offline or disengaged: the change is saved as the plan;
//! - online and matching, or followed (`AmpEditLock.following`): the change is
//!   pushed and stored once the amp holds it — a followed amp that has moved
//!   on is pulled first, so only this change goes out;
//! - online and differing, not followed: refused, as the edit lock says.
//!
//! Load (`ohms`) is local, never written or hashed, so it is saved directly.

use tauri::{AppHandle, State};

use ampcore_core::data::amp_model::AmpModelCatalogEntry;
use ampcore_core::data::capability::cvr::{cvr_param_ranges, CvrFirmwareCapability};
use ampcore_core::data::edit_lock::AmpEditLockState;
use ampcore_core::data::project::{AmpAssignment, Project};
use ampcore_core::data::validation::AmpLimits;
use ampcore_core::error::AppError;
use ampcore_core::live::state::LiveDeviceState;
use crate::data::store::{assignment, assignment_mut, commit, project, project_mut, ProjectDataState};

use super::amp_links::{amp_lock, pull_from_live, read_linked_amp};
use super::amp_push::{push_assignment, Candidate};

/// What an assignment's values are checked against: its planned firmware's
/// ranges and its model's rated voltage. CVR is the only protocol, so the
/// ranges don't need the model itself.
pub(crate) fn assignment_limits(models: &[AmpModelCatalogEntry], assignment: &AmpAssignment) -> AmpLimits {
    AmpLimits {
        ranges: cvr_param_ranges(&CvrFirmwareCapability::from_version(assignment.firmware_version.as_deref())),
        rated_rms_voltage: assignment
            .amp_model_id
            .as_deref()
            .and_then(|id| models.iter().find(|m| m.id == id))
            .and_then(|m| m.topology.rated_rms_voltage),
    }
}

/// The project-only edit: lock → find project → find assignment → `edit` →
/// touch → save → emit `project:updated`. An error from `edit` aborts before
/// anything is saved. `edit` gets the assignment's limits, so a setter can
/// refuse a value before storing it. Only for what never reaches an amp —
/// anything else goes through `save_or_push`.
pub(crate) fn edit_plan(
    app: &AppHandle,
    state: &State<'_, ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
    edit: impl FnOnce(&mut AmpAssignment, &AmpLimits) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    let mut guard = state.lock()?;
    let inner = &mut *guard;
    let project = project_mut(&mut inner.projects, project_id)?;
    let assignment = assignment_mut(project, assignment_id)?;
    let limits = assignment_limits(&inner.amp_models, assignment);
    edit(assignment, &limits)?;
    commit(app, &inner.data_dir, project)
}

/// A copy of the project amp as stored now, with its limits.
fn candidate_of(
    state: &State<'_, ProjectDataState>,
    project_id: &str,
    assignment_id: &str,
) -> Result<(AmpAssignment, AmpLimits), AppError> {
    let inner = state.lock()?;
    let assignment = assignment(project(&inner.projects, project_id)?, assignment_id)?.clone();
    let limits = assignment_limits(&inner.amp_models, &assignment);
    Ok((assignment, limits))
}

/// Applies `edit` to the project amp, routed as the module doc says. A push
/// edits a copy and stores it once the amp holds it (as a `Candidate`, so
/// what changed meanwhile is kept). `what` names the change in the failure
/// text ("the speaker").
pub(crate) async fn save_or_push(
    app: &AppHandle,
    state: &State<'_, ProjectDataState>,
    live: &State<'_, LiveDeviceState>,
    project_id: String,
    assignment_id: String,
    what: &str,
    edit: impl FnOnce(&mut AmpAssignment, &AmpLimits) -> Result<(), AppError>,
) -> Result<Project, AppError> {
    let (base, _) = candidate_of(state, &project_id, &assignment_id)?;
    let reachable = match base.mac.as_deref().filter(|_| !base.live_disengaged) {
        Some(mac) => read_linked_amp(live, mac)?.is_some_and(|r| r.device.online),
        None => false,
    };
    if !reachable {
        return edit_plan(app, state, &project_id, &assignment_id, edit);
    }

    let lock = amp_lock(state, live, &project_id, &assignment_id)?;
    match lock.state {
        AmpEditLockState::Matches => {}
        AmpEditLockState::Mismatch if lock.following => {
            let pulled = pull_from_live(app, state, live, &project_id, &assignment_id)?;
            if !pulled.merged {
                return Err(AppError::from(
                    "The project couldn't take over the amp's latest settings, so it stopped following the amp. Use the comparison to match them again.",
                ));
            }
        }
        AmpEditLockState::Checking | AmpEditLockState::Unreadable => {
            return Err(AppError::from("The amp's settings are still being read. Try again in a moment."));
        }
        AmpEditLockState::Mismatch => {
            return Err(AppError::from("Locked — the offline amp differs from the online amp."));
        }
        // Lost or disengaged since the check above.
        AmpEditLockState::Unlinked | AmpEditLockState::Offline | AmpEditLockState::Disengaged => {
            return edit_plan(app, state, &project_id, &assignment_id, edit);
        }
    }

    let (base, limits) = candidate_of(state, &project_id, &assignment_id)?;
    let mut edited = base.clone();
    edit(&mut edited, &limits)?;
    let result = push_assignment(app, state, live, project_id, assignment_id, Some(Candidate { base, edited })).await?;
    if result.pushed {
        return result.project.ok_or_else(|| AppError::from("the push returned no project"));
    }
    let differing: Vec<String> =
        result.remaining.iter().filter(|r| r.differs).map(|r| format!("{} · {}", r.group, r.label)).collect();
    Err(AppError::from(match (result.failed_stage_label, result.error) {
        (Some(stage), Some(error)) => {
            format!("The amp stopped answering while {stage} was written. Check its connection and apply again. ({error})")
        }
        _ => format!("The amp doesn't hold {what} after writing it. Still differing: {}", differing.join(", ")),
    }))
}
