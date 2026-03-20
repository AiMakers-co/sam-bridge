import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import SamBuddy from "./SamBuddy";

type Mode = "setup" | "cloud" | "local" | "bridge";

function ModeSelector({ onSelect }: { onSelect: (mode: Mode, url?: string) => void }) {
  const [url, setUrl] = useState("https://sam.srv1471466.hstgr.cloud");

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f7ff", padding: 24 }}>
      <div style={{ maxWidth: 440, width: "100%" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 20, margin: "0 auto 16px",
            background: "linear-gradient(135deg, #42a5f5, #1976d2, #1565c0)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: "#fff", fontWeight: 700, fontSize: 26 }}>SA</span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: 0 }}>Welcome to Sam</h1>
          <p style={{ fontSize: 13, color: "#6b7280", marginTop: 6 }}>How would you like to use Sam?</p>
        </div>

        {/* Cloud option */}
        <button
          onClick={() => {
            if (url.trim()) onSelect("cloud", url.trim());
          }}
          style={{
            width: "100%", textAlign: "left", padding: 20, borderRadius: 14,
            border: "1px solid #e3f2fd", background: "#fff", cursor: "pointer",
            marginBottom: 12, display: "flex", gap: 16, alignItems: "flex-start",
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: "linear-gradient(135deg, #2196f3, #1565c0)",
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <span style={{ color: "#fff", fontSize: 20 }}>&#9729;</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>Connect to Cloud</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              Connect to your All Spec Approvals workspace. Sam runs on your server.
            </div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="https://sam.srv1471466.hstgr.cloud"
              style={{
                width: "100%", marginTop: 10, padding: "8px 12px", borderRadius: 8,
                border: "1px solid #e3f2fd", fontSize: 12, outline: "none",
              }}
            />
          </div>
        </button>

        {/* Local option */}
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
            <span style={{ color: "#42a5f5", fontSize: 20 }}>&#9881;</span>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>Run Locally</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              Everything runs on your machine. No cloud, no data leaves your computer. Full privacy.
            </div>
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 6 }}>
              Requires Node.js 20+ and a Claude API key or subscription
            </div>
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
      <iframe
        src={url}
        style={{ width: "100%", height: "100%", border: "none" }}
        title="Sam"
      />
      <SamBuddy status="connected" onCollapseToMenuBar={handleCollapse} />
    </div>
  );
}

function LocalMode({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f0f7ff", padding: 24 }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16, marginBottom: 20,
        background: "linear-gradient(135deg, #1a1a2e, #16213e)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ color: "#42a5f5", fontSize: 20 }}>&#9881;</span>
      </div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: "#111827", margin: "0 0 8px" }}>Local Mode</h2>
      <p style={{ fontSize: 13, color: "#6b7280", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        Local mode bundles the full Sam backend on your machine. This feature is coming soon.
      </p>
      <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, marginTop: 12, lineHeight: 1.6 }}>
        In the meantime, use <strong>Cloud mode</strong> to connect to your workspace — same features, hosted for you.
      </p>
      <button
        onClick={onBack}
        style={{
          marginTop: 24, padding: "10px 28px", borderRadius: 10, border: "none",
          background: "linear-gradient(135deg, #2196f3, #1565c0)", color: "#fff",
          fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}
      >
        Back to Setup
      </button>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("setup");
  const [cloudUrl, setCloudUrl] = useState("");
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

  const handleModeSelect = async (newMode: Mode, url?: string) => {
    try {
      await invoke("set_mode", { mode: newMode, url: url || null });
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
    case "cloud":
      return cloudUrl ? <CloudMode url={cloudUrl} /> : <ModeSelector onSelect={handleModeSelect} />;
    case "local":
      return <LocalMode onBack={() => { handleModeSelect("setup"); }} />;
    case "bridge":
      return <LocalMode onBack={() => { handleModeSelect("setup"); }} />;
    default:
      return <ModeSelector onSelect={handleModeSelect} />;
  }
}
