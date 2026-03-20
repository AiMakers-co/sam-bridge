use std::process::{Command, Child};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, AppHandle, Emitter};
use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_keyring::KeyringExt;

// ── Constants ──────────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "Sam-Claude-OAuth";
const KEYRING_ACCOUNT: &str = "credentials";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT: &str = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_THRESHOLD_SECS: u64 = 2 * 3600; // refresh when < 2h remaining
const CHECK_INTERVAL_SECS: u64 = 30 * 60;     // check every 30 minutes

// ── Managed state ──────────────────────────────────────────────────────────

struct BackendProcess(Mutex<Option<Child>>);

/// Claude credentials stored in keyring
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ClaudeCreds {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64, // Unix ms
}

/// Bridge connection config
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct BridgeConfig {
    pub server_url: String,
    pub bridge_token: String,
}

// ── Keyring helpers ────────────────────────────────────────────────────────

fn read_creds_from_keyring(app: &AppHandle) -> Option<ClaudeCreds> {
    let keyring = app.keyring();
    let raw = keyring.get(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()??;
    serde_json::from_str(&raw).ok()
}

fn write_creds_to_keyring(app: &AppHandle, creds: &ClaudeCreds) -> Result<(), String> {
    let keyring = app.keyring();
    let json = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    keyring.set(KEYRING_SERVICE, KEYRING_ACCOUNT, &json).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_bridge_config_from_keyring(app: &AppHandle) -> Option<BridgeConfig> {
    let keyring = app.keyring();
    let raw = keyring.get("Sam-Bridge-Config", "default").ok()??;
    serde_json::from_str(&raw).ok()
}

fn write_bridge_config_to_keyring(app: &AppHandle, config: &BridgeConfig) -> Result<(), String> {
    let keyring = app.keyring();
    let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
    keyring.set("Sam-Bridge-Config", "default", &json).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Token refresh (blocking) ───────────────────────────────────────────────

fn refresh_token_blocking(refresh_token: &str) -> Result<ClaudeCreds, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", OAUTH_CLIENT_ID),
    ];

    let client = reqwest::blocking::Client::new();
    let response = client
        .post(TOKEN_ENDPOINT)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("Refresh failed ({}): {}", status, body));
    }

    let data: serde_json::Value = response.json().map_err(|e| e.to_string())?;

    let access_token = data["access_token"].as_str().ok_or("Missing access_token")?.to_string();
    let new_refresh = data["refresh_token"].as_str().ok_or("Missing refresh_token")?.to_string();
    let expires_in = data["expires_in"].as_u64().unwrap_or(28800);

    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
        + expires_in * 1000;

    Ok(ClaudeCreds { access_token, refresh_token: new_refresh, expires_at })
}

// ── Push token to server (blocking) ───────────────────────────────────────

fn push_token_to_server_blocking(server_url: &str, bridge_token: &str, creds: &ClaudeCreds) -> Result<(), String> {
    let url = format!("{}/api/bridge/claude-token", server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "accessToken": creds.access_token,
        "refreshToken": creds.refresh_token,
        "expiresAt": creds.expires_at,
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", bridge_token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("Network error pushing token: {}", e))?;

    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        Err(format!("Server rejected token ({}): {}", status, body))
    }
}

// ── Auto-detect Claude CLI credentials ────────────────────────────────────

fn read_claude_cli_creds() -> Option<ClaudeCreds> {
    let candidates: Vec<std::path::PathBuf> = {
        let mut paths = vec![];

        // Windows: %APPDATA%\Claude Code\ or %LOCALAPPDATA%\AnthropicClaude\
        if let Some(appdata) = dirs::config_dir() {
            paths.push(appdata.join("Claude Code").join("credentials.json"));
            paths.push(appdata.join("claude").join("credentials.json"));
            paths.push(appdata.join("AnthropicClaude").join("credentials.json"));
        }

        // macOS/Linux: ~/.config/claude/
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".config").join("claude").join("credentials.json"));
            paths.push(home.join(".claude").join("credentials.json"));
        }

        paths
    };

    for path in &candidates {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    let access = json["claudeAiOauth"]["accessToken"].as_str()
                        .or_else(|| json["access_token"].as_str())
                        .or_else(|| json["accessToken"].as_str())
                        .map(|s| s.to_string());

                    let refresh = json["claudeAiOauth"]["refreshToken"].as_str()
                        .or_else(|| json["refresh_token"].as_str())
                        .or_else(|| json["refreshToken"].as_str())
                        .map(|s| s.to_string());

                    let expires = json["claudeAiOauth"]["expiresAt"].as_u64()
                        .or_else(|| json["expires_at"].as_u64());

                    if let (Some(access), Some(refresh)) = (access, refresh) {
                        let expires_at = expires.unwrap_or_else(|| {
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64
                                + 8 * 3600 * 1000
                        });
                        return Some(ClaudeCreds { access_token: access, refresh_token: refresh, expires_at });
                    }
                }
            }
        }
    }
    None
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Background sync loop ───────────────────────────────────────────────────

fn start_token_sync_loop(app: AppHandle) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(CHECK_INTERVAL_SECS));

            let creds = match read_creds_from_keyring(&app) {
                Some(c) => c,
                None => continue,
            };

            let config = match read_bridge_config_from_keyring(&app) {
                Some(c) => c,
                None => continue,
            };

            let remaining_secs = creds.expires_at.saturating_sub(now_ms()) / 1000;

            let creds_to_push = if remaining_secs < REFRESH_THRESHOLD_SECS {
                match refresh_token_blocking(&creds.refresh_token) {
                    Ok(new_creds) => {
                        let _ = write_creds_to_keyring(&app, &new_creds);
                        let _ = app.emit("token-refreshed", new_creds.expires_at);
                        new_creds
                    }
                    Err(e) => {
                        eprintln!("[token-sync] Refresh failed: {}", e);
                        let _ = app.emit("token-refresh-failed", e);
                        continue;
                    }
                }
            } else {
                creds
            };

            match push_token_to_server_blocking(&config.server_url, &config.bridge_token, &creds_to_push) {
                Ok(()) => { let _ = app.emit("token-synced", creds_to_push.expires_at); }
                Err(e) => {
                    eprintln!("[token-sync] Push failed: {}", e);
                    let _ = app.emit("token-sync-failed", e);
                }
            }
        }
    });
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn save_claude_creds(
    app: AppHandle,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
) -> Result<String, String> {
    let creds = ClaudeCreds { access_token, refresh_token, expires_at };
    write_creds_to_keyring(&app, &creds)?;

    if let Some(config) = read_bridge_config_from_keyring(&app) {
        match push_token_to_server_blocking(&config.server_url, &config.bridge_token, &creds) {
            Ok(()) => return Ok("Credentials saved and synced to server".to_string()),
            Err(e) => eprintln!("[save_claude_creds] Push failed (will retry): {}", e),
        }
    }

    Ok("Credentials saved locally".to_string())
}

#[tauri::command]
fn save_bridge_config(app: AppHandle, server_url: String, bridge_token: String) -> Result<(), String> {
    write_bridge_config_to_keyring(&app, &BridgeConfig { server_url, bridge_token })
}

#[tauri::command]
fn get_claude_status(app: AppHandle) -> serde_json::Value {
    let creds = read_creds_from_keyring(&app);
    let config = read_bridge_config_from_keyring(&app);
    let now = now_ms();

    match creds {
        Some(c) => {
            let hours_remaining = if c.expires_at > now {
                ((c.expires_at - now) as f64 / 3_600_000.0 * 10.0).round() / 10.0
            } else {
                0.0
            };
            serde_json::json!({
                "connected": true,
                "hasServerConfig": config.is_some(),
                "expiresAt": c.expires_at,
                "hoursRemaining": hours_remaining,
                "isExpired": c.expires_at < now,
                "needsRefresh": c.expires_at < now + REFRESH_THRESHOLD_SECS * 1000,
            })
        }
        None => serde_json::json!({ "connected": false, "hasServerConfig": config.is_some() }),
    }
}

#[tauri::command]
fn detect_claude_creds(app: AppHandle) -> Result<serde_json::Value, String> {
    match read_claude_cli_creds() {
        Some(creds) => {
            write_creds_to_keyring(&app, &creds)?;
            let now = now_ms();
            let hours = ((creds.expires_at.saturating_sub(now)) as f64 / 3_600_000.0 * 10.0).round() / 10.0;
            Ok(serde_json::json!({ "found": true, "expiresAt": creds.expires_at, "hoursRemaining": hours }))
        }
        None => Ok(serde_json::json!({ "found": false })),
    }
}

#[tauri::command]
fn force_token_refresh(app: AppHandle) -> Result<serde_json::Value, String> {
    let creds = read_creds_from_keyring(&app)
        .ok_or("No credentials stored. Connect Claude account first.")?;

    let new_creds = refresh_token_blocking(&creds.refresh_token)
        .map_err(|e| format!("Refresh failed: {}", e))?;

    write_creds_to_keyring(&app, &new_creds)?;

    let now = now_ms();
    let hours = ((new_creds.expires_at.saturating_sub(now)) as f64 / 3_600_000.0 * 10.0).round() / 10.0;

    let server_synced = if let Some(config) = read_bridge_config_from_keyring(&app) {
        push_token_to_server_blocking(&config.server_url, &config.bridge_token, &new_creds).is_ok()
    } else {
        false
    };

    Ok(serde_json::json!({
        "success": true,
        "expiresAt": new_creds.expires_at,
        "hoursRemaining": hours,
        "serverSynced": server_synced,
    }))
}

#[tauri::command]
fn push_token_now(app: AppHandle) -> Result<String, String> {
    let creds = read_creds_from_keyring(&app)
        .ok_or("No credentials. Connect Claude account first.")?;
    let config = read_bridge_config_from_keyring(&app)
        .ok_or("No server config. Complete setup first.")?;

    push_token_to_server_blocking(&config.server_url, &config.bridge_token, &creds)
        .map_err(|e| e.to_string())?;

    Ok("Token synced to server".to_string())
}

#[tauri::command]
fn disconnect_claude(app: AppHandle) -> Result<(), String> {
    let keyring = app.keyring();
    let _ = keyring.delete(KEYRING_SERVICE, KEYRING_ACCOUNT);
    Ok(())
}

// ── Existing commands ──────────────────────────────────────────────────────

fn start_backend(app: &AppHandle) -> Result<Child, String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("No resource dir: {}", e))?;
    let backend_entry = resource_dir.join("backend").join("index.js");
    let node = which_node().ok_or("Node.js not found. Install Node.js 20+ to use Sam Local.")?;
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?;
    std::fs::create_dir_all(&data_dir).ok();

    let child = Command::new(&node)
        .arg(&backend_entry)
        .env("DATA_DIR", data_dir.join("store").to_str().unwrap_or(""))
        .env("GROUPS_DIR", data_dir.join("groups").to_str().unwrap_or(""))
        .env("LOGS_DIR", data_dir.join("logs").to_str().unwrap_or(""))
        .env("PORT", "4100")
        .env("NODE_ENV", "production")
        .spawn()
        .map_err(|e| format!("Failed to start backend: {}", e))?;

    Ok(child)
}

fn which_node() -> Option<String> {
    for path in &["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"] {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    Command::new("which").arg("node").output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn wait_for_backend(port: u16, timeout_secs: u64) -> bool {
    let url = format!("http://localhost:{}/api/admin/status", port);
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(timeout_secs) {
        if reqwest::blocking::get(&url).map(|r| r.status().is_success()).unwrap_or(false) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

#[tauri::command]
fn run_shell(command: String) -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", &command]).output()
    } else {
        Command::new("sh").args(["-c", &command]).output()
    };
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            if out.status.success() { Ok(stdout) } else { Err(stderr) }
        }
        Err(e) => Err(format!("Failed: {}", e)),
    }
}

#[tauri::command]
fn check_chrome(port: u16) -> bool {
    reqwest::blocking::get(format!("http://localhost:{}/json/version", port))
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
fn get_mode() -> String {
    let config_path = dirs::config_dir().map(|d| d.join("Sam").join("mode.json"));
    if let Some(path) = config_path {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                return json["mode"].as_str().unwrap_or("setup").to_string();
            }
        }
    }
    "setup".to_string()
}

#[tauri::command]
fn set_mode(mode: String, url: Option<String>) -> Result<(), String> {
    let config_dir = dirs::config_dir().map(|d| d.join("Sam")).ok_or("No config dir")?;
    std::fs::create_dir_all(&config_dir).ok();
    let config = serde_json::json!({ "mode": mode, "url": url.unwrap_or_default() });
    std::fs::write(config_dir.join("mode.json"), config.to_string())
        .map_err(|e| format!("Failed to save: {}", e))
}

// ── App entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_keyring::init())
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_shell, check_chrome, get_mode, set_mode,
            save_claude_creds, save_bridge_config, get_claude_status,
            detect_claude_creds, force_token_refresh, push_token_now, disconnect_claude,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let app_menu = SubmenuBuilder::new(app, "Sam")
                .item(&PredefinedMenuItem::about(app, Some("About Sam"), None)?)
                .separator()
                .item(&MenuItemBuilder::with_id("preferences", "Settings").accelerator("CmdOrCtrl+,").build(app)?)
                .item(&MenuItemBuilder::with_id("check_updates", "Check for Updates...").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("switch_mode", "Switch Mode...").build(app)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?)
                .item(&MenuItemBuilder::with_id("dev_tools", "Developer Tools").accelerator("CmdOrCtrl+Alt+I").build(app)?)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&MenuItemBuilder::with_id("docs", "Documentation").build(app)?)
                .item(&MenuItemBuilder::with_id("support", "Contact Support").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("website", "Visit samclawd.com").build(app)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu).item(&edit_menu).item(&view_menu)
                .item(&window_menu).item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            let menu_handle = handle.clone();
            app.on_menu_event(move |_app, event| {
                match event.id().0.as_str() {
                    "preferences" => {
                        if let Some(w) = menu_handle.get_webview_window("main") {
                            let _ = w.eval("window.location.hash = '#settings'");
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "switch_mode" => {
                        let _ = set_mode("setup".into(), None);
                        if let Some(w) = menu_handle.get_webview_window("main") {
                            let _ = w.eval("window.location.reload()");
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "reload" => {
                        if let Some(w) = menu_handle.get_webview_window("main") {
                            let _ = w.eval("window.location.reload()");
                        }
                    }
                    "docs" => { let _ = open::that("https://docs.samclawd.com"); }
                    "support" => { let _ = open::that("mailto:support@samclawd.com"); }
                    "website" => { let _ = open::that("https://samclawd.com"); }
                    _ => {}
                }
            });

            // Start local backend if in local mode
            let mode = get_mode();
            if mode == "local" {
                let backend_handle = handle.clone();
                thread::spawn(move || {
                    match start_backend(&backend_handle) {
                        Ok(child) => {
                            let state = backend_handle.state::<BackendProcess>();
                            *state.0.lock().unwrap() = Some(child);
                            if wait_for_backend(4100, 30) {
                                if let Some(w) = backend_handle.get_webview_window("main") {
                                    let _ = w.eval("window.location.href = 'http://localhost:4100'");
                                }
                            }
                        }
                        Err(e) => eprintln!("Backend start failed: {}", e),
                    }
                });
            }

            // Start background token sync loop
            start_token_sync_loop(handle.clone());

            // Push current token to server on startup (3s delay to let app settle)
            {
                let startup_handle = handle.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(3));
                    if let (Some(creds), Some(config)) = (
                        read_creds_from_keyring(&startup_handle),
                        read_bridge_config_from_keyring(&startup_handle),
                    ) {
                        match push_token_to_server_blocking(&config.server_url, &config.bridge_token, &creds) {
                            Ok(()) => { let _ = startup_handle.emit("token-synced", creds.expires_at); }
                            Err(e) => {
                                eprintln!("[startup] Token push failed: {}", e);
                                let _ = startup_handle.emit("token-sync-failed", e);
                            }
                        }
                    }
                });
            }

            // Hide to tray on close
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                }
            });

            // Auto-update check
            let update_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if let Ok(updater) = update_handle.updater_builder().build() {
                    if let Ok(Some(update)) = updater.check().await {
                        let _ = update.download_and_install(|_, _| {}, || {}).await;
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|_app, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = _app.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sam");
}
