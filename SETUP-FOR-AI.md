# Sam Desktop App — Setup Guide for AI

This is a Tauri desktop app scaffold forked from NoraAI's desktop app, rebranded for Sam (All Spec Approvals).

## What's Already Done
- Tauri app with Rust backend + React frontend
- Three modes: Cloud (WebView to remote), Local (bundled backend), Bridge (headless)
- Native menu bar (Sam, Edit, View, Window, Help)
- SamBuddy — pixel art robot in corner with animations
- Auto-updater skeleton
- Shell command execution, Chrome CDP support
- Window hides to tray on close

## What You Need To Do

### 1. Install dependencies
```bash
cd sam-bridge
npm install
```

### 2. Update the branding
- Replace icon files in `src-tauri/icons/` with Sam's branding
- Update colors in `src/App.tsx` — currently uses NoraAI terracotta (#d97757). Change to Sam's brand colors.
- Update `src/NoraBuddy.tsx` — rename to `SamBuddy.tsx`, update the pixel art robot design/colors if needed

### 3. Set the cloud URL
The app connects to Brett's VPS. Update the default URL:
- `src/App.tsx` — the Cloud mode connects to whatever URL the user enters
- For Brett's setup: `https://187.77.144.238:3000` or whatever domain points to the SAM app

### 4. Wire the WebSocket bridge
The bridge protocol isn't implemented yet. You need:

**Server side (in SAM's Next.js app):**
```typescript
// src/app/api/ws/bridge/route.ts
// WebSocket endpoint that accepts bridge connections
// Receives browser commands, shell commands from SAM's AI
// Forwards them to the connected desktop app
```

**Client side (in sam-bridge):**
The `src/App.tsx` CloudMode already has a basic WebSocket stub. Wire it to:
1. Connect to `ws://{server}/api/ws/bridge?token={loginToken}`
2. Receive `{ type: "browser_command", command: "navigate", args: { url: "..." } }`
3. Execute via local Chrome CDP on port 9333
4. Send result back: `{ type: "browser_result", id: "...", result: {...} }`

### 5. Build
```bash
npx tauri build
```
Output: `src-tauri/target/release/bundle/dmg/Sam_0.1.0_aarch64.dmg` (Mac)

### 6. Auth flow
Currently the app just takes a URL. You should add:
- Email/password login screen
- Token stored in OS keychain via Tauri's secure storage
- Auto-reconnect on launch

## File Structure
```
sam-bridge/
├── src/                    ← React frontend
│   ├── main.tsx
│   ├── App.tsx             ← Mode selector, Cloud/Local/Bridge views
│   └── NoraBuddy.tsx       ← Floating robot assistant (rename to SamBuddy)
├── src-tauri/              ← Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs          ← Shell exec, Chrome, menus, updater, mode management
│   ├── Cargo.toml
│   ├── tauri.conf.json     ← App config, window, tray, updater
│   └── icons/              ← App icons (replace with Sam branding)
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Key Files to Modify
- `src/App.tsx` — main app logic, mode selection, WebSocket connection
- `src/NoraBuddy.tsx` → `src/SamBuddy.tsx` — the floating robot
- `src-tauri/src/lib.rs` — native capabilities, menus, process management
- `src-tauri/tauri.conf.json` — app name, identifier, window config, updater URL

## Don't Touch
- `src-tauri/Cargo.toml` — dependencies are correct
- `vite.config.ts` — build config is correct
- `tsconfig.json` — TypeScript config is correct
- Build scripts in package.json — working as-is
