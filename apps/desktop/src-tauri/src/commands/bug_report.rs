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

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ampcore_core::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::data::store::write_atomic;

const INBOX_URL: &str = "https://api.github.com/repos/OpenAmpCore/ampcore-reports-inbox/issues";
const TITLE_MAX_CHARS: usize = 200;
const DESCRIPTION_MAX_CHARS: usize = 8000;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
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

async fn post_report(report: &PendingReport) -> SendOutcome {
    let Ok(client) = client() else { return SendOutcome::RetryLater };
    let response = client
        .post(INBOX_URL)
        .bearer_auth(unmask(TOKEN_MASKED, TOKEN_KEY))
        .header("Accept", "application/vnd.github+json")
        .json(&json!({ "title": report.title, "body": report.body }))
        .send()
        .await;
    match response {
        Ok(response) => outcome_of_status(response.status().as_u16()),
        Err(_) => SendOutcome::RetryLater,
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
    while let Some(report) = first_pending(path)? {
        if post_report(&report).await == SendOutcome::RetryLater {
            break;
        }
        remove_pending(path, &report)?;
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
pub async fn bug_report_send(app: AppHandle, title: String, description: String) -> Result<BugReportOutcome, AppError> {
    let (title, description) = validated(&title, &description)?;
    if TOKEN_MASKED.is_empty() {
        return Err(AppError::from("Bug reports aren't available in this build"));
    }
    let body = format!(
        "{description}\n\n---\nAmpCore {}\n{} {}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    let report = PendingReport { title, body };

    match post_report(&report).await {
        SendOutcome::Sent => Ok(BugReportOutcome::Sent),
        SendOutcome::Rejected(status) => {
            Err(AppError::from(format!("The report couldn't be sent (error {status})")))
        }
        SendOutcome::RetryLater => {
            queue_path(&app)
                .and_then(|path| enqueue(&path, report))
                .map_err(|_| AppError::from("The report couldn't be sent or saved"))?;
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
        PendingReport { title: title.to_string(), body: "body".to_string() }
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
