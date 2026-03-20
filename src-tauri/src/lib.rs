use std::process::{Command, Child};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, AppHandle};
use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri_plugin_updater::UpdaterExt;

/// Managed state for the Node.js backend process
struct BackendProcess(Mutex<Option<Child>>);

/// Start the bundled Node.js backend as a sidecar
fn start_backend(app: &AppHandle) -> Result<Child, String> {
    // Resolve the sidecar binary path
    // In dev: use the samai project's dist/index.js directly
    // In production: bundled as a sidecar
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("No resource dir: {}", e))?;

    let backend_entry = resource_dir.join("backend").join("index.js");

    // Find node binary
    let node = which_node().ok_or("Node.js not found. Install Node.js 20+ to use Sam Local.")?;

    // Data directory — OS-appropriate
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
    // Check common locations
    for path in &["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"] {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    // Try PATH
    Command::new("which").arg("node").output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Wait for the backend to be ready
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

/// Execute a shell command (for bridge mode)
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

/// Check Chrome CDP
#[tauri::command]
fn check_chrome(port: u16) -> bool {
    reqwest::blocking::get(format!("http://localhost:{}/json/version", port))
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Get the app mode from saved config
#[tauri::command]
fn get_mode() -> String {
    let config_path = dirs::config_dir()
        .map(|d| d.join("Sam").join("mode.json"));
    if let Some(path) = config_path {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                return json["mode"].as_str().unwrap_or("setup").to_string();
            }
        }
    }
    "setup".to_string()
}

/// Save the app mode
#[tauri::command]
fn set_mode(mode: String, url: Option<String>) -> Result<(), String> {
    let config_dir = dirs::config_dir()
        .map(|d| d.join("Sam"))
        .ok_or("No config dir")?;
    std::fs::create_dir_all(&config_dir).ok();

    let config = serde_json::json!({
        "mode": mode,
        "url": url.unwrap_or_default(),
    });
    std::fs::write(config_dir.join("mode.json"), config.to_string())
        .map_err(|e| format!("Failed to save: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_shell, check_chrome, get_mode, set_mode
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Native menu bar
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
                .item(&app_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            // Handle menu events
            let menu_handle = handle.clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                match id {
                    "preferences" => {
                        if let Some(w) = menu_handle.get_webview_window("main") {
                            let _ = w.eval("window.location.hash = '#settings'");
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "switch_mode" => {
                        // Reset mode to trigger setup screen
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
                    "docs" => {
                        let _ = open::that("https://docs.samclawd.com");
                    }
                    "support" => {
                        let _ = open::that("mailto:support@samclawd.com");
                    }
                    "website" => {
                        let _ = open::that("https://samclawd.com");
                    }
                    _ => {}
                }
            });

            // Check if we're in local mode — if so, start the backend
            let mode = get_mode();
            if mode == "local" {
                let backend_handle = handle.clone();
                thread::spawn(move || {
                    match start_backend(&backend_handle) {
                        Ok(child) => {
                            let state = backend_handle.state::<BackendProcess>();
                            *state.0.lock().unwrap() = Some(child);

                            if wait_for_backend(4100, 30) {
                                // Navigate window to local backend
                                if let Some(window) = backend_handle.get_webview_window("main") {
                                    let _ = window.eval("window.location.href = 'http://localhost:4100'");
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("Backend start failed: {}", e);
                        }
                    }
                });
            }

            // Keep app in tray when window closed
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                }
            });

            // Auto-update check on startup (non-blocking)
            let update_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let updater = match update_handle.updater_builder().build() {
                    Ok(u) => u,
                    Err(_) => return,
                };
                if let Ok(Some(update)) = updater.check().await {
                    let _ = update.download_and_install(
                        |_downloaded, _total| {},
                        || {},
                    ).await;
                }
            });

            Ok(())
        })
        .on_window_event(|_app, event| {
            // Cleanup backend process on quit
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
