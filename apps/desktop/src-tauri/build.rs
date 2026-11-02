use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs, path::Path};

/// Writes the bug report token, XORed with a per-build key, for
/// `commands/bug_report.rs`. No token in the environment gives an empty one.
fn embed_report_token() {
    println!("cargo:rerun-if-env-changed=AMPCORE_REPORT_TOKEN");
    let token = env::var("AMPCORE_REPORT_TOKEN").unwrap_or_default();
    let mut state = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64);
    let key: Vec<u8> = token
        .bytes()
        .map(|_| {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 56) as u8
        })
        .collect();
    let masked: Vec<u8> = token.bytes().zip(&key).map(|(b, k)| b ^ k).collect();
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("report_token.rs");
    fs::write(out, format!("const TOKEN_MASKED: &[u8] = &{masked:?};\nconst TOKEN_KEY: &[u8] = &{key:?};\n")).unwrap();
}

fn main() {
    embed_report_token();
    tauri_build::build()
}
