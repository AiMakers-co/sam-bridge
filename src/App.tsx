import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface FoundToken {
  found: boolean;
  source?: string;
  tokenPreview?: string;
  hoursRemaining?: number;
  expired?: boolean;
  hasRefreshToken?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface ClaudeStatus {
  connected: boolean;
  expiresAt?: number;
  hoursRemaining?: number;
  isExpired?: boolean;
}

export default function App() {
  const [step, setStep] = useState<"loading" | "setup" | "found" | "connected">("loading");
  const [serverUrl, setServerUrl] = useState("https://sam.srv1471466.hstgr.cloud");
  const [bridgeToken, setBridgeToken] = useState("");
  const [foundToken, setFoundToken] = useState<FoundToken | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  // Check if already configured
  useEffect(() => {
    (async () => {
      try {
        const url = await invoke<string>("get_server_url");
        const token = await invoke<string>("get_bridge_token");
        if (url) setServerUrl(url);
        if (token) setBridgeToken(token);
        const s = await invoke<ClaudeStatus>("get_claude_status");
        setStatus(s);
        if (s.connected && !s.isExpired) {
          setStep("connected");
        } else {
          setStep("setup");
        }
      } catch {
        setStep("setup");
      }
    })();
  }, []);

  // Sync events
  useEffect(() => {
    const unsubs = [
      listen("token-synced", () => { setSyncMsg("Token synced"); refreshStatus(); setTimeout(() => setSyncMsg(""), 4000); }),
      listen("token-refreshed", () => { setSyncMsg("Token refreshed"); refreshStatus(); setTimeout(() => setSyncMsg(""), 4000); }),
      listen("token-sync-failed", (e) => { setSyncMsg(`Sync failed: ${e.payload}`); setTimeout(() => setSyncMsg(""), 8000); }),
    ];
    return () => { unsubs.forEach(p => p.then(u => u())); };
  }, []);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await invoke<ClaudeStatus>("get_claude_status")); } catch {}
  }, []);

  useEffect(() => { const iv = setInterval(refreshStatus, 60_000); return () => clearInterval(iv); }, [refreshStatus]);

  // Step 1: Search for token
  const handleSearch = async () => {
    if (!serverUrl.trim() || !bridgeToken.trim()) { setError("Both fields required"); return; }
    setLoading(true);
    setError("");
    try {
      await invoke("save_config", { serverUrl: serverUrl.trim(), bridgeToken: bridgeToken.trim() });
      const result = await invoke<FoundToken>("detect_claude_creds");
      setFoundToken(result);
      if (result.found) {
        setStep("found");
      } else {
        setError("No Claude credentials found on this computer. Install Claude Code and run 'claude auth login' first.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Sync the found token
  const handleSync = async () => {
    if (!foundToken?.accessToken) return;
    setLoading(true);
    setError("");
    try {
      await invoke("save_claude_creds", {
        accessToken: foundToken.accessToken,
        refreshToken: foundToken.refreshToken || "",
        expiresAt: foundToken.expiresAt || Date.now() + 8 * 3600 * 1000,
      });
      await refreshStatus();
      setStep("connected");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Refresh + sync
  const handleRefresh = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await invoke<any>("force_token_refresh");
      setSyncMsg(`Refreshed (${result.hoursRemaining}h remaining)`);
      await refreshStatus();
      setTimeout(() => setSyncMsg(""), 4000);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const handlePush = async () => {
    setLoading(true);
    try { await invoke<string>("push_token_now"); setSyncMsg("Synced"); setTimeout(() => setSyncMsg(""), 4000); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const handleRescan = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await invoke<FoundToken>("detect_claude_creds");
      setFoundToken(result);
      if (result.found) setStep("found");
      else setError("No credentials found");
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  if (step === "loading") return null;

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 400, width: "100%" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 12px", background: "linear-gradient(135deg, #42a5f5, #1565c0)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 18 }}>SA</span>
          </div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: "#111827", margin: 0 }}>Sam Bridge</h1>
          <p style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>Syncs your Claude credentials to the server</p>
        </div>

        {/* SETUP: Enter server + bridge token, search */}
        {step === "setup" && (
          <div style={card}>
            <label style={label}>Server URL</label>
            <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} style={input} placeholder="https://sam.srv1471466.hstgr.cloud" />

            <label style={{ ...label, marginTop: 12 }}>Bridge Token</label>
            <input value={bridgeToken} onChange={e => setBridgeToken(e.target.value)} style={input} placeholder="From Settings > Bridge" type="password" />

            {error && <div style={errBox}>{error}</div>}

            <button onClick={handleSearch} disabled={loading} style={primaryBtn}>
              {loading ? "Searching..." : "Search for Claude Token"}
            </button>

            <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 12, lineHeight: 1.6, textAlign: "center" }}>
              No token? <a href="https://claude.ai/login" target="_blank" rel="noopener" style={{ color: "#2563eb", textDecoration: "none" }}>Sign in to Claude</a>, then install <a href="https://docs.anthropic.com/en/docs/claude-code/overview" target="_blank" rel="noopener" style={{ color: "#2563eb", textDecoration: "none" }}>Claude Code</a> and run <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 3 }}>claude auth login</code>
            </p>
          </div>
        )}

        {/* FOUND: Show what was found, confirm sync */}
        {step === "found" && foundToken && (
          <div style={card}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 12 }}>
              Token Found
            </div>

            <div style={infoBox}>
              <div style={infoRow}><span style={infoLabel}>Source</span><span style={infoValue}>{foundToken.source}</span></div>
              <div style={infoRow}><span style={infoLabel}>Token</span><span style={{ ...infoValue, fontFamily: "monospace", fontSize: 11 }}>{foundToken.tokenPreview}</span></div>
              <div style={infoRow}>
                <span style={infoLabel}>Status</span>
                <span style={{ ...infoValue, color: foundToken.expired ? "#dc2626" : "#16a34a", fontWeight: 600 }}>
                  {foundToken.expired ? "Expired" : `Valid (${foundToken.hoursRemaining}h remaining)`}
                </span>
              </div>
              <div style={infoRow}><span style={infoLabel}>Refresh token</span><span style={infoValue}>{foundToken.hasRefreshToken ? "Yes" : "No"}</span></div>
            </div>

            {error && <div style={errBox}>{error}</div>}

            <button onClick={handleSync} disabled={loading} style={{ ...primaryBtn, background: "#16a34a" }}>
              {loading ? "Syncing..." : "Sync to Server"}
            </button>

            <button onClick={() => setStep("setup")} style={secondaryBtn}>Back</button>
          </div>
        )}

        {/* CONNECTED: Status + actions */}
        {step === "connected" && status && (
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: status.isExpired ? "#ef4444" : "#10b981" }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
                  {status.isExpired ? "Token Expired" : "Connected"}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>
                  {status.isExpired ? "Rescan or refresh to get a new token" : `${status.hoursRemaining}h remaining`}
                </div>
              </div>
            </div>

            {syncMsg && <div style={{ ...infoBox, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#15803d", padding: "8px 12px", fontSize: 12, marginBottom: 12 }}>{syncMsg}</div>}
            {error && <div style={errBox}>{error}</div>}

            <div style={{ ...infoBox, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#6b7280" }}>Server</div>
              <div style={{ fontSize: 12, color: "#111827", wordBreak: "break-all" }}>{serverUrl}</div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleRescan} disabled={loading} style={actionBtn}>Rescan</button>
              <button onClick={handleRefresh} disabled={loading} style={actionBtn}>Refresh</button>
              <button onClick={handlePush} disabled={loading} style={actionBtn}>Sync Now</button>
            </div>

            {status.isExpired && (
              <p style={{ fontSize: 11, color: "#6b7280", marginTop: 12, lineHeight: 1.6, textAlign: "center" }}>
                Token expired? <a href="https://claude.ai/login" target="_blank" rel="noopener" style={{ color: "#2563eb", textDecoration: "none" }}>Sign in to Claude</a> then run <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 3 }}>claude auth login</code> and click Rescan.
              </p>
            )}

            <button onClick={() => { invoke("disconnect_claude"); setStep("setup"); setStatus(null); }} style={{ ...secondaryBtn, color: "#dc2626", borderColor: "#fecaca" }}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: 20 };
const label: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4 };
const input: React.CSSProperties = { width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, outline: "none", boxSizing: "border-box" };
const primaryBtn: React.CSSProperties = { width: "100%", marginTop: 16, padding: "10px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = { width: "100%", marginTop: 8, padding: "8px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, color: "#374151", cursor: "pointer" };
const actionBtn: React.CSSProperties = { flex: 1, padding: "8px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", fontSize: 12, color: "#374151", cursor: "pointer", fontWeight: 500 };
const errBox: React.CSSProperties = { marginTop: 12, padding: "8px 12px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 12 };
const infoBox: React.CSSProperties = { padding: "12px", borderRadius: 8, background: "#f9fafb", border: "1px solid #f3f4f6", marginBottom: 4 };
const infoRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #f3f4f6" };
const infoLabel: React.CSSProperties = { fontSize: 11, color: "#6b7280", fontWeight: 500 };
const infoValue: React.CSSProperties = { fontSize: 12, color: "#111827", textAlign: "right", maxWidth: "65%", wordBreak: "break-all" };
