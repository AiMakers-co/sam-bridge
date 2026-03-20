# Sam Desktop

The full SamAI experience as a native desktop app for Mac and Windows.

## Three Modes

**Cloud** — Connects to your `{slug}.specapprovals.com` instance. Lightweight WebView + bridge for local machine access.

**Local** — Runs the entire SamAI backend on your machine. No cloud, no data leaves your computer. Needs Node.js 20+ installed.

**Bridge** — Headless tray icon. Connects your machine to your cloud instance so AI employees can control your browser and access local files.

## Development

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

Outputs:
- macOS: `src-tauri/target/release/bundle/dmg/Sam_0.1.0_aarch64.dmg`
- Windows: `src-tauri/target/release/bundle/msi/Sam_0.1.0_x64_en-US.msi`

## Auto-Updates

Built-in via Tauri updater plugin. Checks `specapprovals.com/api/releases/` on startup. Users get updates automatically.

## Architecture

```
Sam Desktop App
├── Tauri (Rust)
│   ├── Window management + system tray
│   ├── Node.js sidecar (local mode)
│   ├── Shell command execution (bridge)
│   ├── Chrome CDP proxy (bridge)
│   └── Auto-updater
├── React Frontend
│   ├── Mode selector (first launch)
│   ├── Cloud mode (iframe to remote)
│   └── Local mode (iframe to localhost:4100)
└── SamAI Backend (sidecar, local mode only)
    └── Same codebase as the web version
```
