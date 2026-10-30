//! Sends a bug report from the title bar's modal. The report lands in a private
//! inbox repo, and a workflow there moves it to `ampcore-reports`
//! (`tools/report-inbox/forward.yml`), so the token in this binary can reach
//! nothing but that inbox.
//!
//! The token stays on this side of the IPC bridge and no error names the
//! service: the user is only ever told a report goes to the developers.

use std::time::Duration;

use ampcore_core::error::AppError;
use serde_json::json;
use tauri::AppHandle;

const INBOX_URL: &str = "https://api.github.com/repos/OpenAmpCore/ampcore-reports-inbox/issues";
const TITLE_MAX_CHARS: usize = 200;
const DESCRIPTION_MAX_CHARS: usize = 8000;
const SEND_TIMEOUT: Duration = Duration::from_secs(15);

// ponytail: XOR only stops a plain string search and scrapers. Anyone with a
// debugger still gets the token, which is why it is limited to the inbox.
include!(concat!(env!("OUT_DIR"), "/report_token.rs"));

fn unmask(masked: &[u8], key: &[u8]) -> String {
    masked.iter().zip(key).map(|(b, k)| (b ^ k) as char).collect()
}

/// The OS's own TLS, named explicitly: the updater enables another backend in
/// this same `reqwest`, one that has no crypto provider of its own.
fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder().tls_backend_native().timeout(SEND_TIMEOUT).user_agent("AmpCore").build()
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

#[tauri::command]
#[specta::specta]
pub async fn bug_report_send(app: AppHandle, title: String, description: String) -> Result<(), AppError> {
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

    let client = client().map_err(|_| AppError::from("The report couldn't be sent"))?;
    let response = client
        .post(INBOX_URL)
        .bearer_auth(unmask(TOKEN_MASKED, TOKEN_KEY))
        .header("Accept", "application/vnd.github+json")
        .json(&json!({ "title": title, "body": body }))
        .send()
        .await
        .map_err(|_| AppError::from("The report couldn't be sent. Check the internet connection."))?;
    if !response.status().is_success() {
        return Err(AppError::from(format!("The report couldn't be sent (error {})", response.status().as_u16())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
