mod commands;
mod data;
mod live;
mod web_server;

use tauri::Manager;
use tauri_specta::{collect_commands, Builder};

use commands::amp_links::{
    projects_add_live_amp, projects_amp_edit_lock, projects_edit_amp, projects_link_amp, projects_merge_amp_from_live,
    projects_set_amp_live_disengaged, projects_unlink_amp, projects_validate_amp_link,
};
use commands::amp_push::{projects_plan_amp_push, projects_push_amp_to_live};
use commands::amp_models::{amp_models_archive, amp_models_create, amp_models_list, amp_models_update};
use commands::capability::{amp_capability_resolve, eq_response_curve};
use commands::device_links::{device_model_link_auto_match, device_model_link_get_all, device_model_link_set};
use commands::fingerprint::{
    fingerprint_live_device, fingerprint_live_devices, fingerprint_project,
    fingerprint_project_amp,
};
use commands::live_control::{
    live_control_fetch_bridge, live_control_fetch_channel_fir, live_control_fetch_presets, live_control_get_channel_config, live_control_get_presets,
    live_control_get_telemetry, live_control_list_devices, live_control_recall_preset, live_control_refresh_now,
    live_control_store_preset, live_control_get_bridge, live_control_set_matrix_crosspoint, live_control_set_channel_noise_gate,
    live_control_set_channel_limiter, live_control_copy_channel_section, live_control_paste_channel_section,
    live_control_set_channel_name, live_control_set_channel_source,
    live_control_set_output_bridge,
    live_control_set_channel_delay_in, live_control_set_channel_input_mute, live_control_set_channel_output,
    live_control_set_channel_phase_invert, live_control_set_channel_power_mode, live_control_set_crossover_slot,
    live_control_set_eq_band, live_control_set_fir_bypass, live_control_set_channel_fir_data, live_control_clear_channel_fir_data, fir_export_file,
    live_control_set_output_mute, live_control_start, live_control_stop, live_control_set_poll_subscription,
    live_control_set_rotary_lock, live_control_set_standby, live_control_set_device_name,
    live_control_set_source_trim, live_control_set_backup_priority,
};
use commands::projects::{
    projects_add_amp_assignment, projects_create, projects_delete, projects_get, projects_list,
    projects_remove_amp_assignment, projects_set_amp_device_name, projects_set_amp_model, projects_set_channel_delay_in,
    projects_set_channel_fir, projects_set_channel_fir_bypass, projects_set_channel_input_mute, projects_set_channel_limiter, projects_copy_channel_section,
    projects_paste_channel_section, projects_set_channel_name,
    projects_set_channel_noise_gate, projects_set_channel_ohms, projects_set_channel_output,
    projects_set_channel_output_mute, projects_set_channel_phase_invert, projects_set_channel_power_mode,
    projects_set_channel_source, projects_set_crossover_slot, projects_set_eq_band,
    projects_set_matrix_crosspoint, projects_set_output_bridge, projects_update,
    projects_set_source_trim, projects_set_backup_priority,
};
use commands::speakers::{
    projects_add_speaker, projects_remove_speaker, projects_rename_speaker, projects_set_speaker_position, projects_set_channel_speaker, speakers_apply, speakers_channel_states, speakers_delete, speakers_fit, speakers_import_profiles, speakers_list,
    speakers_save_from_outputs, speakers_update_details, speakers_update_from_output,
};
use ampcore_core::live::state::LiveDeviceState;
use data::store::ProjectDataState;
use web_server::{web_server_set, WebServerState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            projects_list,
            projects_get,
            projects_create,
            projects_update,
            projects_delete,
            projects_add_amp_assignment,
            projects_remove_amp_assignment,
            projects_set_amp_model,
            projects_set_amp_device_name,
            projects_set_channel_ohms,
            projects_set_channel_source,
            projects_set_source_trim,
            projects_set_backup_priority,
            projects_set_matrix_crosspoint,
            projects_set_channel_delay_in,
            projects_set_channel_input_mute,
            projects_set_channel_output,
            projects_set_crossover_slot,
            projects_set_eq_band,
            projects_set_channel_limiter,
            projects_copy_channel_section,
            projects_paste_channel_section,
            projects_set_channel_noise_gate,
            projects_set_channel_phase_invert,
            projects_set_channel_name,
            projects_set_channel_output_mute,
            projects_set_channel_fir_bypass,
            projects_set_channel_fir,
            projects_set_output_bridge,
            projects_set_channel_power_mode,
            projects_set_channel_speaker,
            projects_add_speaker,
            projects_rename_speaker,
            projects_remove_speaker,
            projects_set_speaker_position,
            speakers_apply,
            speakers_list,
            speakers_import_profiles,
            speakers_fit,
            speakers_update_details,
            speakers_delete,
            speakers_save_from_outputs,
            speakers_update_from_output,
            speakers_channel_states,
            amp_capability_resolve,
            eq_response_curve,
            amp_models_list,
            amp_models_create,
            amp_models_update,
            amp_models_archive,
            live_control_start,
            live_control_set_poll_subscription,
            live_control_stop,
            live_control_list_devices,
            live_control_get_telemetry,
            live_control_get_channel_config,
            live_control_refresh_now,
            live_control_fetch_presets,
            live_control_get_presets,
            live_control_recall_preset,
            live_control_store_preset,
            live_control_get_bridge,
            live_control_fetch_bridge,
            live_control_fetch_channel_fir,
            live_control_set_matrix_crosspoint,
            live_control_set_channel_noise_gate,
            live_control_set_channel_limiter,
            live_control_copy_channel_section,
            live_control_paste_channel_section,
            live_control_set_channel_name,
            live_control_set_channel_source,
            live_control_set_source_trim,
            live_control_set_backup_priority,
            live_control_set_output_bridge,
            live_control_set_output_mute,
            live_control_set_fir_bypass,
            live_control_set_channel_fir_data,
            live_control_clear_channel_fir_data,
            fir_export_file,
            live_control_set_channel_output,
            live_control_set_channel_delay_in,
            live_control_set_channel_input_mute,
            live_control_set_channel_phase_invert,
            live_control_set_channel_power_mode,
            live_control_set_eq_band,
            live_control_set_crossover_slot,
            device_model_link_auto_match,
            device_model_link_set,
            device_model_link_get_all,
            fingerprint_project_amp,
            fingerprint_project,
            fingerprint_live_device,
            fingerprint_live_devices,
            projects_validate_amp_link,
            projects_link_amp,
            projects_add_live_amp,
            projects_edit_amp,
            projects_unlink_amp,
            projects_set_amp_live_disengaged,
            projects_amp_edit_lock,
            projects_merge_amp_from_live,
            projects_plan_amp_push,
            projects_push_amp_to_live,
            live_control_set_rotary_lock,
            live_control_set_standby,
            live_control_set_device_name,
            web_server_set,
        ]);

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/lib/bindings.ts",
        )
        .expect("failed to export typescript bindings");

    tauri::Builder::default()
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let project_data = ProjectDataState::load(&app.handle().clone())
                .expect("failed to load project data store");
            app.manage(project_data);
            app.manage(LiveDeviceState::new());
            app.manage(WebServerState::default());
            Ok(())
        })
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
