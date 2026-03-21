use std::thread;
use std::time::Duration;
use tauri::{Manager, AppHandle, Emitter};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconEvent;

const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT: &str = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_THRESHOLD_SECS: u64 = 2 * 3600;
const CHECK_INTERVAL_SECS: u64 = 30 * 60;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct AppConfig {
    #[serde(default)] pub server_url: String,
    #[serde(default)] pub bridge_token: String,
    #[serde(default)] pub access_token: String,
    #[serde(default)] pub refresh_token: String,
    #[serde(default)] pub expires_at: u64,
}

// ── File-based config (no Keychain) ──

fn config_path() -> std::path::PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default()).join("Sam");
    std::fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

fn read_config() -> AppConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(config: &AppConfig) -> Result<(), String> {
    std::fs::write(config_path(), serde_json::to_string_pretty(config).unwrap_or_default())
        .map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

// ── Token refresh ──

fn refresh_token_blocking(refresh_token: &str) -> Result<(String, String, u64), String> {
    let client = reqwest::blocking::Client::new();
    let response = client.post(TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", OAUTH_CLIENT_ID)])
        .send().map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!("Refresh failed: {}", body));
    }

    let data: serde_json::Value = response.json().map_err(|e| e.to_string())?;
    Ok((
        data["access_token"].as_str().ok_or("Missing access_token")?.to_string(),
        data["refresh_token"].as_str().ok_or("Missing refresh_token")?.to_string(),
        now_ms() + data["expires_in"].as_u64().unwrap_or(28800) * 1000,
    ))
}

// ── Push token to server ──

fn push_token(config: &AppConfig) -> Result<(), String> {
    if config.server_url.is_empty() || config.bridge_token.is_empty() || config.access_token.is_empty() {
        return Err("Missing config".into());
    }
    let url = format!("{}/api/bridge/claude-token", config.server_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let response = client.post(&url)
        .header("Authorization", format!("Bearer {}", config.bridge_token))
        .json(&serde_json::json!({ "accessToken": config.access_token, "refreshToken": config.refresh_token, "expiresAt": config.expires_at }))
        .send().map_err(|e| format!("Push failed: {}", e))?;
    if response.status().is_success() { Ok(()) } else { Err(format!("Server rejected ({})", response.status())) }
}

// ── Auto-detect Claude CLI creds from file ──

struct FoundCreds {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    source: String,
}

fn detect_cli_creds() -> Option<FoundCreds> {
    // 1. Try macOS Keychain via `security` CLI (no password prompt)
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(creds) = extract_oauth(&json, "macOS Keychain (Claude Code-credentials)") {
                    return Some(creds);
                }
            }
        }
    }

    // 2. Try credential files (macOS + Linux + Windows paths)
    let mut paths = vec![];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".claude").join("credentials.json"));
        paths.push(home.join(".config").join("claude").join("credentials.json"));
    }
    if let Some(cfg) = dirs::config_dir() {
        // Windows: %APPDATA%\Claude Code\credentials.json
        paths.push(cfg.join("Claude Code").join("credentials.json"));
        // Windows alt: %APPDATA%\claude\credentials.json
        paths.push(cfg.join("claude").join("credentials.json"));
        // Windows alt: %APPDATA%\AnthropicClaude\credentials.json
        paths.push(cfg.join("AnthropicClaude").join("credentials.json"));
    }
    if let Some(local) = dirs::data_local_dir() {
        // Windows: %LOCALAPPDATA%\AnthropicClaude\credentials.json
        paths.push(local.join("AnthropicClaude").join("credentials.json"));
    }

    for path in &paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let source = format!("File: {}", path.display());
                if let Some(creds) = extract_oauth(&json, &source) {
                    return Some(creds);
                }
            }
        }
    }
    None
}

fn extract_oauth(json: &serde_json::Value, source: &str) -> Option<FoundCreds> {
    let access = json["claudeAiOauth"]["accessToken"].as_str()
        .or_else(|| json["accessToken"].as_str()).map(|s| s.to_string())?;
    let refresh = json["claudeAiOauth"]["refreshToken"].as_str()
        .or_else(|| json["refreshToken"].as_str()).map(|s| s.to_string()).unwrap_or_default();
    let expires = json["claudeAiOauth"]["expiresAt"].as_u64().unwrap_or(0);

    Some(FoundCreds { access_token: access, refresh_token: refresh, expires_at: expires, source: source.to_string() })
}

// ── Background sync loop ──

fn start_sync_loop(app: AppHandle) {
    thread::spawn(move || {
        // Initial push after 3s
        thread::sleep(Duration::from_secs(3));
        let config = read_config();
        if !config.access_token.is_empty() && !config.server_url.is_empty() {
            for attempt in 0u64..3 {
                if attempt > 0 { thread::sleep(Duration::from_secs(5)); }
                if push_token(&config).is_ok() {
                    let _ = app.emit("token-synced", config.expires_at);
                    break;
                }
            }
        }

        // Periodic loop
        loop {
            thread::sleep(Duration::from_secs(CHECK_INTERVAL_SECS));
            let mut config = read_config();
            if config.access_token.is_empty() || config.server_url.is_empty() { continue; }

            let remaining = config.expires_at.saturating_sub(now_ms()) / 1000;
            if remaining < REFRESH_THRESHOLD_SECS && !config.refresh_token.is_empty() {
                match refresh_token_blocking(&config.refresh_token) {
                    Ok((a, r, e)) => {
                        config.access_token = a;
                        config.refresh_token = r;
                        config.expires_at = e;
                        let _ = write_config(&config);
                        let _ = app.emit("token-refreshed", config.expires_at);
                    }
                    Err(e) => { let _ = app.emit("token-sync-failed", e); continue; }
                }
            }

            match push_token(&config) {
                Ok(()) => { let _ = app.emit("token-synced", config.expires_at); }
                Err(e) => { let _ = app.emit("token-sync-failed", e); }
            }
        }
    });
}

// ── Commands ──

#[tauri::command]
fn get_server_url() -> String { read_config().server_url }

#[tauri::command]
fn get_bridge_token() -> String { read_config().bridge_token }

#[tauri::command]
fn save_config(server_url: String, bridge_token: Option<String>) -> Result<(), String> {
    let mut config = read_config();
    config.server_url = server_url;
    if let Some(t) = bridge_token { config.bridge_token = t; }
    write_config(&config)
}

#[tauri::command]
fn get_claude_status() -> serde_json::Value {
    let config = read_config();
    if config.access_token.is_empty() {
        return serde_json::json!({ "connected": false, "hasServerConfig": !config.server_url.is_empty() });
    }
    let now = now_ms();
    let hrs = if config.expires_at > now { ((config.expires_at - now) as f64 / 3_600_000.0 * 10.0).round() / 10.0 } else { 0.0 };
    serde_json::json!({ "connected": true, "hasServerConfig": !config.server_url.is_empty(), "expiresAt": config.expires_at, "hoursRemaining": hrs, "isExpired": config.expires_at < now })
}

#[tauri::command]
fn detect_claude_creds() -> Result<serde_json::Value, String> {
    match detect_cli_creds() {
        Some(creds) => {
            let now = now_ms();
            let expired = creds.expires_at < now;
            let hrs = if !expired { ((creds.expires_at - now) as f64 / 3_600_000.0 * 10.0).round() / 10.0 } else { 0.0 };
            let token_preview = if creds.access_token.len() > 20 {
                format!("{}...{}", &creds.access_token[..15], &creds.access_token[creds.access_token.len()-4..])
            } else { creds.access_token.clone() };

            // Don't save yet — just report what was found
            Ok(serde_json::json!({
                "found": true,
                "source": creds.source,
                "tokenPreview": token_preview,
                "hoursRemaining": hrs,
                "expired": expired,
                "hasRefreshToken": !creds.refresh_token.is_empty(),
                // Pass the actual tokens back so the UI can trigger save
                "accessToken": creds.access_token,
                "refreshToken": creds.refresh_token,
                "expiresAt": creds.expires_at,
            }))
        }
        None => Ok(serde_json::json!({ "found": false })),
    }
}

#[tauri::command]
fn save_claude_creds(access_token: String, refresh_token: String, expires_at: u64) -> Result<String, String> {
    let mut config = read_config();
    config.access_token = access_token;
    config.refresh_token = refresh_token;
    config.expires_at = expires_at;
    write_config(&config)?;
    match push_token(&config) {
        Ok(()) => Ok("Saved and synced".into()),
        Err(_) => Ok("Saved locally".into()),
    }
}

#[tauri::command]
fn force_token_refresh() -> Result<serde_json::Value, String> {
    let mut config = read_config();
    if config.refresh_token.is_empty() { return Err("No refresh token".into()); }
    let (a, r, e) = refresh_token_blocking(&config.refresh_token)?;
    config.access_token = a;
    config.refresh_token = r;
    config.expires_at = e;
    write_config(&config)?;
    let synced = push_token(&config).is_ok();
    let hrs = ((e.saturating_sub(now_ms())) as f64 / 3_600_000.0 * 10.0).round() / 10.0;
    Ok(serde_json::json!({ "success": true, "hoursRemaining": hrs, "serverSynced": synced }))
}

#[tauri::command]
fn push_token_now() -> Result<String, String> {
    let config = read_config();
    push_token(&config)?;
    Ok("Synced".into())
}

#[tauri::command]
fn disconnect_claude() -> Result<(), String> {
    let mut config = read_config();
    config.access_token.clear();
    config.refresh_token.clear();
    config.expires_at = 0;
    write_config(&config)
}

// ── App ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            get_server_url, get_bridge_token, save_config,
            get_claude_status, detect_claude_creds, save_claude_creds,
            force_token_refresh, push_token_now, disconnect_claude,
        ])
        .setup(|app| {
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).item(&show).separator().item(&quit).build()?;

            if let Some(tray) = app.tray_by_id("main") {
                tray.set_menu(Some(menu))?;
                let h = app.handle().clone();
                tray.on_menu_event(move |_app, event| {
                    match event.id().0.as_str() {
                        "show" => { if let Some(w) = h.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); } }
                        "quit" => std::process::exit(0),
                        _ => {}
                    }
                });
                let h2 = app.handle().clone();
                tray.on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(w) = h2.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                    }
                });
            }

            if let Some(w) = app.get_webview_window("main") {
                let wc = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = wc.hide();
                    }
                });
            }

            start_sync_loop(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sam Bridge");
}
