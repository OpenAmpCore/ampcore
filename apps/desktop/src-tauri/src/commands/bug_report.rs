//! Sends a bug report from the title bar's modal. The report lands in a private
//! inbox repo, and a workflow there moves it to `ampcore-reports`
//! (`tools/report-inbox/forward.yml`), so the token in this binary can reach
//! nothing but that inbox.
//!
//! A report that can't go out now (no internet at the venue, an expired token)
//! is kept in `pending-bug-reports.json` and retried from the background until
//! it can.
//!
//! The token stays on this side of the IPC bridge and no error names the
//! service: the user is only ever told a report goes to the developers.
//!
//! Issues can't carry files through the API, so screenshots travel as assets of
//! a draft release in the inbox, named in the body by an `ampcore-attachments`
//! marker. The workflow copies them next to the report and deletes them, and a
//! deleted asset leaves no history for the token to read back.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ampcore_core::data::common::new_id;
use ampcore_core::error::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::data::store::write_atomic;

const INBOX_URL: &str = "https://api.github.com/repos/OpenAmpCore/ampcore-reports-inbox/issues";
const RELEASES_URL: &str = "https://api.github.com/repos/OpenAmpCore/ampcore-reports-inbox/releases";
const UPLOADS_URL: &str = "https://uploads.github.com/repos/OpenAmpCore/ampcore-reports-inbox/releases";
const ATTACHMENT_RELEASE: &str = "attachments";
const TITLE_MAX_CHARS: usize = 200;
const DESCRIPTION_MAX_CHARS: usize = 8000;
const IMAGES_MAX: usize = 3;
const IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Its images live in the folder of the same name without the extension.
const QUEUE_FILE: &str = "pending-bug-reports.json";
const QUEUE_MAX_REPORTS: usize = 50;
const RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Serialises every read-modify-write of the queue file. Never held across a send.
static QUEUE_LOCK: Mutex<()> = Mutex::new(());

// ponytail: XOR only stops a plain string search and scrapers. Anyone with a
// debugger still gets the token, which is why it is limited to the inbox.
include!(concat!(env!("OUT_DIR"), "/report_token.rs"));

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PendingReport {
    title: String,
    /// Includes the footer, so a later send names the version that had the bug.
    body: String,
    /// File names in the image folder beside the queue file.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum BugReportOutcome {
    Sent,
    /// Couldn't go out now; the background retry delivers it.
    Saved,
}

#[derive(Debug, PartialEq, Eq)]
enum SendOutcome {
    Sent,
    RetryLater,
    Rejected(u16),
}

fn unmask(masked: &[u8], key: &[u8]) -> String {
    masked.iter().zip(key).map(|(b, k)| (b ^ k) as char).collect()
}

/// The OS's own TLS, named explicitly: the updater enables another backend in
/// this same `reqwest`, one that has no crypto provider of its own.
fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder().tls_backend_native().timeout(SEND_TIMEOUT).user_agent("AmpCore").build()
}

/// 401/403 are retried too: an expired token is cured by an update, and the
/// report shouldn't be lost before that arrives. Any other 4xx will never pass.
fn outcome_of_status(status: u16) -> SendOutcome {
    match status {
        200..=299 => SendOutcome::Sent,
        401 | 403 | 429 | 500..=599 => SendOutcome::RetryLater,
        other => SendOutcome::Rejected(other),
    }
}

/// Sends with the token and returns the response's JSON, or how the failure counts.
async fn call(request: reqwest::RequestBuilder) -> Result<serde_json::Value, SendOutcome> {
    let response = request
        .bearer_auth(unmask(TOKEN_MASKED, TOKEN_KEY))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| SendOutcome::RetryLater)?;
    match outcome_of_status(response.status().as_u16()) {
        SendOutcome::Sent => Ok(response.json().await.unwrap_or(serde_json::Value::Null)),
        other => Err(other),
    }
}

/// One long-lived draft release; drafts are invisible without write access.
async fn attachment_release(client: &reqwest::Client) -> Result<u64, SendOutcome> {
    let releases = call(client.get(format!("{RELEASES_URL}?per_page=100"))).await?;
    let existing = releases.as_array().into_iter().flatten().find(|r| {
        r["draft"].as_bool() == Some(true) && r["name"].as_str() == Some(ATTACHMENT_RELEASE)
    });
    let release = match existing {
        Some(release) => release.clone(),
        None => {
            let create = json!({ "tag_name": ATTACHMENT_RELEASE, "name": ATTACHMENT_RELEASE, "draft": true });
            call(client.post(RELEASES_URL).json(&create)).await?
        }
    };
    release["id"].as_u64().ok_or(SendOutcome::RetryLater)
}

/// Best effort: what's left behind the workflow never deletes.
async fn delete_assets(client: &reqwest::Client, ids: &[u64]) {
    for id in ids {
        let _ = call(client.delete(format!("{RELEASES_URL}/assets/{id}"))).await;
    }
}

/// A file that has gone missing is skipped, so it can't hold up the queue.
async fn upload_images(client: &reqwest::Client, images: &[String], dir: &Path) -> Result<Vec<u64>, SendOutcome> {
    let release = attachment_release(client).await?;
    let mut ids = Vec::new();
    for name in images {
        let Ok(bytes) = fs::read(dir.join(name)) else { continue };
        let content_type = if name.ends_with(".png") { "image/png" } else { "image/jpeg" };
        let uploaded = call(
            client
                .post(format!("{UPLOADS_URL}/{release}/assets?name={name}"))
                .timeout(UPLOAD_TIMEOUT)
                .header("Content-Type", content_type)
                .body(bytes),
        )
        .await
        .and_then(|asset| asset["id"].as_u64().ok_or(SendOutcome::RetryLater));
        match uploaded {
            Ok(id) => ids.push(id),
            Err(outcome) => {
                delete_assets(client, &ids).await;
                return Err(outcome);
            }
        }
    }
    Ok(ids)
}

fn attachment_marker(ids: &[u64]) -> String {
    let ids: Vec<String> = ids.iter().map(u64::to_string).collect();
    format!("\n<!-- ampcore-attachments: {} -->", ids.join(","))
}

async fn post_report(report: &PendingReport, image_dir: &Path) -> SendOutcome {
    let Ok(client) = client() else { return SendOutcome::RetryLater };
    let mut body = report.body.clone();
    let mut ids = Vec::new();
    if !report.images.is_empty() {
        match upload_images(&client, &report.images, image_dir).await {
            Ok(uploaded) => ids = uploaded,
            Err(outcome) => return outcome,
        }
        if !ids.is_empty() {
            body.push_str(&attachment_marker(&ids));
        }
    }
    let outcome = match call(client.post(INBOX_URL).json(&json!({ "title": report.title, "body": body }))).await {
        Ok(_) => SendOutcome::Sent,
        Err(outcome) => outcome,
    };
    if outcome != SendOutcome::Sent {
        delete_assets(&client, &ids).await;
    }
    outcome
}

/// The image's file extension, from its signature: only PNG and JPEG are taken.
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else {
        None
    }
}

fn decoded_images(images: &[String]) -> Result<Vec<(Vec<u8>, &'static str)>, AppError> {
    if images.len() > IMAGES_MAX {
        return Err(AppError::from(format!("A report can carry up to {IMAGES_MAX} pictures")));
    }
    let too_large = || AppError::from(format!("A picture is limited to {} MB", IMAGE_MAX_BYTES / (1024 * 1024)));
    images
        .iter()
        .map(|image| {
            if image.len() > IMAGE_MAX_BYTES / 3 * 4 + 4 {
                return Err(too_large());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(image)
                .map_err(|_| AppError::from("A picture couldn't be read"))?;
            if bytes.len() > IMAGE_MAX_BYTES {
                return Err(too_large());
            }
            let ext = image_extension(&bytes).ok_or_else(|| AppError::from("Pictures must be PNG or JPEG"))?;
            Ok((bytes, ext))
        })
        .collect()
}

fn image_dir(queue: &Path) -> PathBuf {
    queue.with_extension("")
}

fn save_images(dir: &Path, images: &[(Vec<u8>, &'static str)]) -> Result<Vec<String>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    images
        .iter()
        .map(|(bytes, ext)| {
            let name = format!("{}.{ext}", new_id());
            fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
            Ok(name)
        })
        .collect()
}

fn remove_images(dir: &Path, names: &[String]) {
    for name in names {
        let _ = fs::remove_file(dir.join(name));
    }
}

fn validated(title: &str, description: &str) -> Result<(String, String), AppError> {
    let (title, description) = (title.trim(), description.trim());
    if title.is_empty() || description.is_empty() {
        return Err(AppError::from("Please enter a title and a description"));
    }
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(AppError::from(format!("The title is limited to {TITLE_MAX_CHARS} characters")));
    }
    if description.chars().count() > DESCRIPTION_MAX_CHARS {
        return Err(AppError::from(format!("The description is limited to {DESCRIPTION_MAX_CHARS} characters")));
    }
    Ok((title.to_string(), description.to_string()))
}

fn queue_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(QUEUE_FILE))
}

/// A file that can't be parsed is set aside rather than deleted, and can't block
/// later reports.
fn load_queue(path: &Path) -> Result<Vec<PendingReport>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    match serde_json::from_str(&text) {
        Ok(queue) => Ok(queue),
        Err(_) => {
            fs::rename(path, path.with_extension("json.bad")).map_err(|e| e.to_string())?;
            Ok(Vec::new())
        }
    }
}

fn save_queue(path: &Path, queue: &[PendingReport]) -> Result<(), String> {
    write_atomic(path, serde_json::to_string_pretty(queue).map_err(|e| e.to_string())?.as_bytes())
}

fn enqueue(path: &Path, report: PendingReport) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut queue = load_queue(path)?;
    if queue.len() >= QUEUE_MAX_REPORTS {
        return Err("too many saved reports".to_string());
    }
    queue.push(report);
    save_queue(path, &queue)
}

fn first_pending(path: &Path) -> Result<Option<PendingReport>, String> {
    let _guard = QUEUE_LOCK.lock().map_err(|e| e.to_string())?;
    Ok(load_queue(path)?.into_iter().next())
}

fn remove_pending(path: &Path, report: &PendingReport) -> Result<(), String> {
    let _guard = QUEUE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut queue = load_queue(path)?;
    if let Some(index) = queue.iter().position(|r| r == report) {
        queue.remove(index);
    }
    save_queue(path, &queue)
}

/// Sends oldest first, stopping at the first report that has to wait: the next
/// one would only wait as well.
async fn flush_queue(path: &Path) -> Result<(), String> {
    let dir = image_dir(path);
    while let Some(report) = first_pending(path)? {
        if post_report(&report, &dir).await == SendOutcome::RetryLater {
            break;
        }
        remove_pending(path, &report)?;
        remove_images(&dir, &report.images);
    }
    Ok(())
}

/// Tries the queue at startup and then periodically, silently: the user was
/// already told the report will go out on its own.
pub fn start_bug_report_retry(app: &AppHandle) {
    if TOKEN_MASKED.is_empty() {
        return;
    }
    let Ok(path) = queue_path(app) else { return };
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = flush_queue(&path).await {
                eprintln!("bug report retry: {e}");
            }
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
    });
}

#[tauri::command]
#[specta::specta]
/// `images` are base64 PNG or JPEG files. They are written to the queue's image
/// folder first, so sending now and sending later read them the same way.
pub async fn bug_report_send(
    app: AppHandle,
    title: String,
    description: String,
    images: Vec<String>,
) -> Result<BugReportOutcome, AppError> {
    let (title, description) = validated(&title, &description)?;
    let images = decoded_images(&images)?;
    if TOKEN_MASKED.is_empty() {
        return Err(AppError::from("Bug reports aren't available in this build"));
    }
    let body = format!(
        "{description}\n\n---\nAmpCore {}\n{} {}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    let path = queue_path(&app).map_err(|_| AppError::from("The report couldn't be prepared"))?;
    let dir = image_dir(&path);
    let images = save_images(&dir, &images).map_err(|_| AppError::from("The pictures couldn't be prepared"))?;
    let report = PendingReport { title, body, images };

    let outcome = post_report(&report, &dir).await;
    if outcome != SendOutcome::RetryLater {
        remove_images(&dir, &report.images);
    }
    match outcome {
        SendOutcome::Sent => Ok(BugReportOutcome::Sent),
        SendOutcome::Rejected(status) => {
            Err(AppError::from(format!("The report couldn't be sent (error {status})")))
        }
        SendOutcome::RetryLater => {
            let images = report.images.clone();
            enqueue(&path, report).map_err(|_| {
                remove_images(&dir, &images);
                AppError::from("The report couldn't be sent or saved")
            })?;
            Ok(BugReportOutcome::Saved)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ampcore_core::data::common::new_id;

    fn queue_file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ampcore-bug-report-test-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(QUEUE_FILE)
    }

    fn report(title: &str) -> PendingReport {
        PendingReport { title: title.to_string(), body: "body".to_string(), images: Vec::new() }
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn images_are_checked_by_count_size_and_signature() {
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        let jpg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        let decoded = decoded_images(&[b64(&png), b64(&jpg)]).unwrap();
        assert_eq!(decoded, vec![(png.clone(), "png"), (jpg, "jpg")]);
        assert!(decoded_images(&vec![b64(&png); IMAGES_MAX + 1]).is_err());
        assert!(decoded_images(&[b64(b"GIF89a")]).is_err());
        assert!(decoded_images(&["not base64!".to_string()]).is_err());
        let mut big = png;
        big.resize(IMAGE_MAX_BYTES + 1, 0);
        assert!(decoded_images(&[b64(&big)]).is_err());
    }

    #[test]
    fn a_queue_from_before_images_still_loads() {
        let path = queue_file();
        fs::write(&path, r#"[{"title":"a","body":"body"}]"#).unwrap();
        assert_eq!(load_queue(&path).unwrap(), vec![report("a")]);
    }

    #[test]
    fn saved_images_land_beside_the_queue_and_are_removed() {
        let dir = image_dir(&queue_file());
        let names = save_images(&dir, &[(vec![1, 2], "png")]).unwrap();
        assert!(names[0].ends_with(".png"));
        assert_eq!(fs::read(dir.join(&names[0])).unwrap(), vec![1, 2]);
        remove_images(&dir, &names);
        assert!(!dir.join(&names[0]).exists());
    }

    #[test]
    fn marker_lists_asset_ids() {
        assert_eq!(attachment_marker(&[1, 22]), "\n<!-- ampcore-attachments: 1,22 -->");
    }

    /// Needs internet. An anonymous POST is refused without creating anything,
    /// so a status of 401 or 404 proves TLS and the request path work.
    #[tokio::test]
    #[ignore]
    async fn inbox_is_reachable() {
        let status = client().unwrap().post(INBOX_URL).json(&json!({})).send().await.unwrap().status().as_u16();
        assert!(status == 401 || status == 404, "{status}");
    }

    #[test]
    fn unmask_reverses_the_xor() {
        let key = [7u8, 200, 13, 91];
        let masked: Vec<u8> = b"ab_1".iter().zip(&key).map(|(b, k)| b ^ k).collect();
        assert_eq!(unmask(&masked, &key), "ab_1");
    }

    #[test]
    fn validation_trims_and_limits() {
        assert_eq!(validated(" t ", " d ").unwrap(), ("t".to_string(), "d".to_string()));
        assert!(validated("  ", "d").is_err());
        assert!(validated("t", "").is_err());
        assert!(validated(&"t".repeat(TITLE_MAX_CHARS + 1), "d").is_err());
        assert!(validated("t", &"d".repeat(DESCRIPTION_MAX_CHARS + 1)).is_err());
        assert!(validated(&"ü".repeat(TITLE_MAX_CHARS), "d").is_ok());
    }

    #[test]
    fn status_decides_whether_a_report_is_kept() {
        assert_eq!(outcome_of_status(201), SendOutcome::Sent);
        for status in [401, 403, 429, 500, 503] {
            assert_eq!(outcome_of_status(status), SendOutcome::RetryLater, "{status}");
        }
        for status in [400, 404, 410, 422] {
            assert_eq!(outcome_of_status(status), SendOutcome::Rejected(status), "{status}");
        }
    }

    #[test]
    fn queue_keeps_order_and_removes_by_report() {
        let path = queue_file();
        assert_eq!(first_pending(&path).unwrap(), None);
        enqueue(&path, report("a")).unwrap();
        enqueue(&path, report("b")).unwrap();
        assert_eq!(first_pending(&path).unwrap(), Some(report("a")));
        remove_pending(&path, &report("a")).unwrap();
        assert_eq!(first_pending(&path).unwrap(), Some(report("b")));
        remove_pending(&path, &report("b")).unwrap();
        assert_eq!(first_pending(&path).unwrap(), None);
    }

    #[test]
    fn queue_refuses_past_its_cap() {
        let path = queue_file();
        for i in 0..QUEUE_MAX_REPORTS {
            enqueue(&path, report(&i.to_string())).unwrap();
        }
        assert!(enqueue(&path, report("over")).is_err());
        assert_eq!(load_queue(&path).unwrap().len(), QUEUE_MAX_REPORTS);
    }

    #[test]
    fn a_corrupt_queue_is_set_aside() {
        let path = queue_file();
        fs::write(&path, "not json").unwrap();
        enqueue(&path, report("a")).unwrap();
        assert_eq!(load_queue(&path).unwrap(), vec![report("a")]);
        assert_eq!(fs::read_to_string(path.with_extension("json.bad")).unwrap(), "not json");
    }
}
