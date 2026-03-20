import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SamBuddy from "./SamBuddy";

type Mode = "setup" | "cloud" | "local" | "bridge" | "connect-claude";

interface ClaudeStatus {
  connected: boolean;
  hasServerConfig: boolean;
  expiresAt?: number;
  hoursRemaining?: number;
  isExpired?: boolean;
  needsRefresh?: boolean;
}

// ── Claude Account Setup Screen ────────────────────────────────────────────

function ClaudeSetupScreen({
  onDone,
  onBack,
  serverUrl,
  bridgeToken,
}: {
  onDone: () => void;
  onBack: () => void;
  serverUrl: string;
  bridgeToken: string;
}) {
  const [step, setStep] = useState<"detect" | "manual" | "done">("detect");
  const [status, setStatus] = useState<string>("Checking for Claude credentials...");
  const [error, setError] = useState<string>("");
  const [manualToken, setManualToken] = useState("");
  const [manualRefresh, setManualRefresh] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { autoDetect(); }, []);

  async function autoDetect() {
    setLoading(true);
    setError("");
    setStatus("Looking for Claude CLI credentials...");
    try {
      await invoke("save_bridge_config", { serverUrl, bridgeToken });
      const result = await invoke<{ found: boolean; hoursRemaining?: number }>("detect_claude_creds");
      if (result.found) {
        setStatus(`Claude credentials found! (${result.hoursRemaining}h remaining)`);
        await invoke("push_token_now");
        setStep("done");
      } else {
        setStatus("No Claude CLI credentials found automatically.");
        setStep("manual");
      }
    } catch (e) {
      setError(String(e));
      setStep("manual");
    } finally {
      setLoading(false);
    }
  }

  async function saveManual() {
    if (!manualToken.trim() || !manualRefresh.trim()) {
      setError("Both tokens are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await invoke("save_bridge_config", { serverUrl, bridgeToken });
      const expiresAt = Date.now() + 8 * 3600 * 1000;
      const result = await invoke<string>("save_claude_creds", {
        accessToken: manualToken.trim(),
        refreshToken: manualRefresh.trim(),
        expiresAt,
      });
      setStatus(result);
      setStep("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (step === "done") {
    return (
      <div style={styles.center}>
        <div style={{ ...styles.iconBox, background: "linear-gradient(135deg, #22c55e, #16a34a)" }}>
          <span style={{ color: "#fff", fontSize: 28 }}>✓</span>
        </div>
        <h2 style={styles.heading}>Claude Connected</h2>
        <p style={styles.sub}>{status}</p>
        <p style={{ ...styles.sub, marginTop: 8, color: "#6b7280" }}>
          Sam will automatically refresh your token every 30 minutes and keep the server in sync.
        </p>
        <button onClick={onDone} style={styles.primaryBtn}>Continue to Sam →</button>
      </div>
    );
  }

  if (step === "manual") {
    return (
      <div style={styles.center}>
        <div style={{ ...styles.iconBox, background: "linear-gradient(135deg, #f59e0b, #d97706)" }}>
          <span style={{ color: "#fff", fontSize: 24 }}>🔑</span>
        </div>
        <h2 style={styles.heading}>Connect Claude Account</h2>
        <p style={styles.sub}>
          Enter your Claude OAuth tokens. Stored securely in Windows Credential Manager.
        </p>

        <div style={{
          background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10,
          padding: 16, marginBottom: 20, textAlign: "left", maxWidth: 400, width: "100%",
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#0369a1", marginBottom: 8 }}>How to get your tokens:</div>
          <ol style={{ fontSize: 12, color: "#374151", paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
            <li>Install Claude Code: <code style={{ background: "#e0f2fe", padding: "1px 4px", borderRadius: 3 }}>npm install -g @anthropic-ai/claude-code</code></li>
            <li>Run: <code style={{ background: "#e0f2fe", padding: "1px 4px", borderRadius: 3 }}>claude auth login</code></li>
            <li>Sign in with your Claude account in the browser</li>
            <li>Open: <code style={{ background: "#e0f2fe", padding: "1px 4px", borderRadius: 3 }}>%APPDATA%\Claude Code\credentials.json</code></li>
            <li>Copy <code style={{ background: "#e0f2fe", padding: "1px 4px", borderRadius: 3 }}>accessToken</code> and <code style={{ background: "#e0f2fe", padding: "1px 4px", borderRadius: 3 }}>refreshToken</code></li>
          </ol>
        </div>

        <div style={{ width: "100%", maxWidth: 400 }}>
          <label style={styles.label}>Access Token (sk-ant-oat01-...)</label>
          <input
            value={manualToken}
            onChange={(e) => setManualToken(e.target.value)}
            placeholder="sk-ant-oat01-..."
            style={styles.input}
            type="password"
          />
          <label style={{ ...styles.label, marginTop: 12 }}>Refresh Token</label>
          <input
            value={manualRefresh}
            onChange={(e) => setManualRefresh(e.target.value)}
            placeholder="Paste refresh token..."
            style={styles.input}
            type="password"
          />
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={onBack} style={styles.secondaryBtn} disabled={loading}>Back</button>
          <button onClick={saveManual} style={styles.primaryBtn} disabled={loading}>
            {loading ? "Saving..." : "Connect"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.center}>
      <div style={{ ...styles.iconBox, background: "linear-gradient(135deg, #6366f1, #4f46e5)" }}>
        <span style={{ color: "#fff", fontSize: 24 }}>🔍</span>
      </div>
      <h2 style={styles.heading}>Connecting Claude Account</h2>
      <p style={styles.sub}>{status}</p>
      {loading && <div style={{ color: "#6b7280", fontSize: 12, marginTop: 8 }}>Please wait...</div>}
      {error && (
        <>
          <div style={styles.error}>{error}</div>
          <button onClick={() => setStep("manual")} style={styles.primaryBtn}>Enter Tokens Manually</button>
        </>
      )}
    </div>
  );
}

// ── Bridge Status Indicator ────────────────────────────────────────────────

function BridgeStatus() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [syncMsg, setSyncMsg] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<ClaudeStatus>("get_claude_status");
      setStatus(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const unsubs = [
      listen("token-synced", () => { setSyncMsg("✓ Token synced"); setTimeout(() => setSyncMsg(""), 4000); refresh(); }),
      listen("token-refreshed", () => { setSyncMsg("✓ Token refreshed"); setTimeout(() => setSyncMsg(""), 4000); refresh(); }),
      listen("token-sync-failed", (e) => { setSyncMsg(`⚠ ${e.payload}`); setTimeout(() => setSyncMsg(""), 8000); }),
      listen("token-refresh-failed", (e) => { setSyncMsg(`⚠ Refresh failed: ${e.payload}`); setTimeout(() => setSyncMsg(""), 8000); }),
    ];
    return () => { unsubs.forEach(p => p.then(u => u())); };
  }, [refresh]);

  if (!status) return null;

  const isOk = status.connected && !status.isExpired;
  const color = isOk ? "#16a34a" : status.connected ? "#d97706" : "#dc2626";

  return (
    <div style={{
      position: "fixed", bottom: 12, right: 12, zIndex: 999,
      background: "#fff", border: `1px solid ${color}20`, borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: "8px 12px", fontSize: 11,
      boxShadow: "0 2px 8px rgba(0,0,0,0.08)", maxWidth: 220,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: "#374151" }}>
          {isOk ? `Claude OK (${status.hoursRemaining}h)` : status.connected ? "Token expiring" : "Not connected"}
        </span>
      </div>
      {syncMsg && <div style={{ marginTop: 4, color: "#6b7280" }}>{syncMsg}</div>}
    </div>
  );
}

// ── Mode Selector ──────────────────────────────────────────────────────────

function ModeSelector({ onSelect }: { onSelect: (mode: Mode, url?: string, bridgeToken?: string) => void }) {
  const [url, setUrl] = useState("https://sam.srv1471466.hstgr.cloud");
  const [bridgeToken, setBridgeToken] = useState(() => localStorage.getItem("sam-bridge-token") || "");
  const [tokenError, setTokenError] = useState(false);

  const handleConnect = () => {
    if (!url.trim()) return;
    if (!bridgeToken.trim()) {
      setTokenError(true);
      return;
    }
    setTokenError(false);
    onSelect("connect-claude", url.trim(), bridgeToken.trim());
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f7ff", padding: 24 }}>
      <div style={{ maxWidth: 440, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 20, margin: "0 auto 16px",
            background: "linear-gradient(135deg, #42a5f5, #1976d2, #1565c0)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 26 }}>SA</span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>Welcome to Sam</h1>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>Connect to your All Spec Approvals workspace.</p>
        </div>

        <div style={{
          background: "#fff", borderRadius: 14, border: "1px solid #e3f2fd",
          padding: 20, marginBottom: 12,
        }}>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: "linear-gradient(135deg, #2196f3, #1565c0)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ color: "#fff", fontSize: 20 }}>☁</span>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>Connect to Cloud</div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                Sam runs on your server. Your computer stays in sync.
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4 }}>
              Workspace URL
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://sam.srv1471466.hstgr.cloud"
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #e3f2fd", fontSize: 12, outline: "none", boxSizing: "border-box" as const }}
            />
          </div>

          <div style={{ marginBottom: tokenError ? 6 : 16 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4 }}>
              Bridge Token <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <input
              value={bridgeToken}
              onChange={(e) => { setBridgeToken(e.target.value); localStorage.setItem("sam-bridge-token", e.target.value); if (tokenError) setTokenError(false); }}
              placeholder="Paste your bridge token..."
              type="password"
              style={{
                width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 12, outline: "none",
                boxSizing: "border-box" as const,
                border: tokenError ? "1px solid #fca5a5" : "1px solid #e3f2fd",
                background: tokenError ? "#fff5f5" : "#fff",
              }}
            />
          </div>

          {tokenError && (
            <div style={{
              marginBottom: 14, padding: "8px 12px", borderRadius: 8,
              background: "#fef2f2", border: "1px solid #fecaca",
              fontSize: 11, color: "#dc2626",
            }}>
              Bridge token required. Go to <strong>Sam → Settings → Bridge</strong> and click <strong>Generate Token</strong>, then paste it here.
            </div>
          )}

          <button
            onClick={handleConnect}
            style={{
              width: "100%", padding: "11px 20px", borderRadius: 10, border: "none",
              background: "linear-gradient(135deg, #2196f3, #1565c0)", color: "#fff",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            Connect →
          </button>
        </div>

        <button
          onClick={() => onSelect("local")}
          style={{
            width: "100%", textAlign: "left", padding: 20, borderRadius: 14,
            border: "1px solid #e3f2fd", background: "#fff", cursor: "pointer",
            marginBottom: 12, display: "flex", gap: 16, alignItems: "flex-start",
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "linear-gradient(135deg, #1a1a2e, #16213e)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <span style={{ color: "#42a5f5", fontSize: 20 }}>⚙</span>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>Run Locally</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              Everything on your machine. No cloud, full privacy.
            </div>
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 6 }}>Requires Node.js 20+ and a Claude account</div>
          </div>
        </button>

        <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 16 }}>
          You can change this later in Settings
        </p>
      </div>
    </div>
  );
}

function CloudMode({ url }: { url: string }) {
  const handleCollapse = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch {}
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <iframe src={url} style={{ width: "100%", height: "100%", border: "none" }} title="Sam" />
      <BridgeStatus />
      <SamBuddy status="connected" onCollapseToMenuBar={handleCollapse} />
    </div>
  );
}

function LocalMode({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ ...styles.center, minHeight: "100vh" }}>
      <div style={{ ...styles.iconBox, background: "linear-gradient(135deg, #1a1a2e, #16213e)" }}>
        <span style={{ color: "#42a5f5", fontSize: 20 }}>⚙</span>
      </div>
      <h2 style={styles.heading}>Local Mode</h2>
      <p style={styles.sub}>Local mode is coming soon. Use Cloud mode in the meantime.</p>
      <button onClick={onBack} style={styles.primaryBtn}>Back to Setup</button>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  center: {
    minHeight: "100vh", display: "flex", flexDirection: "column" as const,
    alignItems: "center", justifyContent: "center",
    background: "#f0f7ff", padding: 24, textAlign: "center" as const,
  },
  iconBox: {
    width: 56, height: 56, borderRadius: 16, marginBottom: 20,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  heading: { fontSize: 18, fontWeight: 700, color: "#111827", margin: "0 0 8px" },
  sub: { fontSize: 13, color: "#6b7280", maxWidth: 380, lineHeight: 1.6, margin: 0 },
  label: { display: "block" as const, fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4, textAlign: "left" as const },
  input: {
    width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #e5e7eb",
    fontSize: 13, outline: "none", boxSizing: "border-box" as const, display: "block" as const,
  },
  primaryBtn: {
    marginTop: 16, padding: "10px 28px", borderRadius: 10, border: "none",
    background: "linear-gradient(135deg, #2196f3, #1565c0)", color: "#fff",
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  secondaryBtn: {
    marginTop: 16, padding: "10px 20px", borderRadius: 10, cursor: "pointer",
    border: "1px solid #e5e7eb", background: "#fff", fontSize: 13, color: "#374151",
  },
  error: {
    marginTop: 12, padding: "8px 12px", borderRadius: 8,
    background: "#fef2f2", border: "1px solid #fecaca",
    color: "#dc2626", fontSize: 12, maxWidth: 400, width: "100%",
  },
};

// ── Root App ───────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode] = useState<Mode>("setup");
  const [cloudUrl, setCloudUrl] = useState("");
  const [pendingUrl, setPendingUrl] = useState("");
  const [pendingBridgeToken, setPendingBridgeToken] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<string>("get_mode").then((savedMode) => {
      if (savedMode === "cloud" || savedMode === "local" || savedMode === "bridge") {
        setMode(savedMode as Mode);
        try {
          const config = JSON.parse(localStorage.getItem("sam-config") || "{}");
          if (config.url) setCloudUrl(config.url);
        } catch {}
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleModeSelect = async (newMode: Mode, url?: string, bridgeToken?: string) => {
    if (newMode === "connect-claude") {
      setPendingUrl(url || "");
      setPendingBridgeToken(bridgeToken || "");
      setMode("connect-claude");
      return;
    }

    try {
      await invoke("set_mode", { mode: newMode === "connect-claude" ? "cloud" : newMode, url: url || null });
    } catch {}

    if (url) {
      setCloudUrl(url);
      localStorage.setItem("sam-config", JSON.stringify({ url }));
    }
    setMode(newMode);
  };

  if (loading) return null;

  switch (mode) {
    case "setup":
      return <ModeSelector onSelect={handleModeSelect} />;

    case "connect-claude":
      return (
        <ClaudeSetupScreen
          serverUrl={pendingUrl}
          bridgeToken={pendingBridgeToken}
          onDone={async () => {
            await invoke("set_mode", { mode: "cloud", url: pendingUrl });
            setCloudUrl(pendingUrl);
            localStorage.setItem("sam-config", JSON.stringify({ url: pendingUrl }));
            setMode("cloud");
          }}
          onBack={() => setMode("setup")}
        />
      );

    case "cloud":
      return cloudUrl ? <CloudMode url={cloudUrl} /> : <ModeSelector onSelect={handleModeSelect} />;

    case "local":
      return <LocalMode onBack={() => { invoke("set_mode", { mode: "setup", url: null }); setMode("setup"); }} />;

    case "bridge":
      return cloudUrl ? <CloudMode url={cloudUrl} /> : <ModeSelector onSelect={handleModeSelect} />;

    default:
      return <ModeSelector onSelect={handleModeSelect} />;
  }
}
