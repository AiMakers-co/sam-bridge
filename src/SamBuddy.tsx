import { useState, useEffect, useRef, useCallback } from "react";

// Same 12x12 pixel robot grids as SamAI's RobotAvatar
const DESIGN = [
  '....33......',
  '....11......',
  '...1111.....',
  '..111111....',
  '..1WW1WW....',
  '..111S11....',
  '...2222.....',
  '..322232....',
  '...2222.....',
  '...2..2.....',
  '...2..2.....',
  '...M..M.....',
];

const PALETTE = {
  '1': '#e8a88f', '2': '#b35a3a', '3': '#fbbf24',
  W: '#ffffff', S: '#1a1a2e', M: '#8a8a8a',
};

// Eye positions in the grid (row, col pairs for W pixels)
const EYE_PIXELS = [
  [4, 3], [4, 4], // left eye
  [4, 6], [4, 7], // right eye
];

// Arm pixels (row, col for '2' pixels on sides)
const LEFT_ARM = [[7, 2]];
const RIGHT_ARM = [[7, 7]];

interface BuddyProps {
  status: "connected" | "disconnected" | "connecting";
  message?: string;
  onCollapseToMenuBar?: () => void;
}

export default function SamBuddy({ status, message, onCollapseToMenuBar }: BuddyProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [waving, setWaving] = useState(false);
  const [bobOffset, setBobOffset] = useState(0);
  const [greeting, setGreeting] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const frameRef = useRef(0);

  const SIZE = 96;
  const PIXEL = SIZE / 12;

  // Draw the robot
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, SIZE, SIZE);

    for (let y = 0; y < DESIGN.length; y++) {
      for (let x = 0; x < DESIGN[y].length; x++) {
        const ch = DESIGN[y][x];
        if (ch === "." || ch === " ") continue;

        // Blinking — replace eye pixels with body color
        if (blinking && EYE_PIXELS.some(([ey, ex]) => ey === y && ex === x)) {
          ctx.fillStyle = PALETTE["1"];
        } else {
          ctx.fillStyle = (PALETTE as any)[ch] || "#ccc";
        }

        // Waving — shift right arm up
        let drawY = y;
        if (waving && RIGHT_ARM.some(([ay, ax]) => ay === y && ax === x)) {
          drawY = y - 1;
        }

        ctx.fillRect(x * PIXEL, drawY * PIXEL + bobOffset, PIXEL, PIXEL);
      }
    }

    // Antenna glow when connected
    if (status === "connected") {
      const glowIntensity = 0.3 + Math.sin(frameRef.current * 0.05) * 0.2;
      ctx.fillStyle = `rgba(251, 191, 36, ${glowIntensity})`;
      ctx.beginPath();
      ctx.arc(4.5 * PIXEL, 0.5 * PIXEL + bobOffset, PIXEL * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Status dot
    ctx.fillStyle = status === "connected" ? "#10b981" : status === "connecting" ? "#f59e0b" : "#ef4444";
    ctx.beginPath();
    ctx.arc(SIZE - 8, SIZE - 8, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#faf6f0";
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [blinking, waving, bobOffset, status]);

  // Idle bob animation
  useEffect(() => {
    let animId: number;
    const animate = () => {
      frameRef.current++;
      setBobOffset(Math.sin(frameRef.current * 0.03) * 2);
      animId = requestAnimationFrame(animate);
    };
    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, []);

  // Random blink
  useEffect(() => {
    const interval = setInterval(() => {
      setBlinking(true);
      setTimeout(() => setBlinking(false), 150);
    }, 3000 + Math.random() * 4000);
    return () => clearInterval(interval);
  }, []);

  // Wave on hover
  useEffect(() => {
    if (hovering) {
      setWaving(true);
      const timer = setTimeout(() => setWaving(false), 600);
      return () => clearTimeout(timer);
    }
  }, [hovering]);

  // Redraw on state change
  useEffect(() => { draw(); }, [draw]);

  // Greeting messages
  useEffect(() => {
    if (expanded) {
      const greetings = [
        "Hey! What can I help with?",
        "I'm here if you need me.",
        "All systems running smoothly.",
        "Ready when you are.",
      ];
      setGreeting(greetings[Math.floor(Math.random() * greetings.length)]);
    }
  }, [expanded]);

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 9999,
      display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8,
    }}>
      {/* Speech bubble */}
      {expanded && (
        <div style={{
          background: "#fff", borderRadius: 16, padding: "14px 18px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.12)", maxWidth: 260,
          border: "1px solid #f0e6d6",
          animation: "bubbleIn 0.2s ease-out",
        }}>
          <p style={{ fontSize: 13, color: "#374151", margin: 0, lineHeight: 1.5 }}>
            {message || greeting}
          </p>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: status === "connected" ? "#10b981" : "#ef4444",
            }} />
            <span style={{ fontSize: 11, color: "#9ca3af" }}>
              {status === "connected" ? "Connected" : status === "connecting" ? "Connecting..." : "Disconnected"}
            </span>
          </div>
          {/* Triangle pointer */}
          <div style={{
            position: "absolute", bottom: -6, right: 30,
            width: 12, height: 12, background: "#fff",
            transform: "rotate(45deg)", borderRight: "1px solid #f0e6d6",
            borderBottom: "1px solid #f0e6d6",
          }} />
        </div>
      )}

      {/* Context menu */}
      {showMenu && (
        <div style={{
          background: "#fff", borderRadius: 10, padding: 4,
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)", border: "1px solid #e5e7eb",
          minWidth: 160, animation: "bubbleIn 0.15s ease-out",
        }}>
          {[
            { label: "Collapse to Menu Bar", icon: "↗", action: () => { setShowMenu(false); onCollapseToMenuBar?.(); } },
            { label: "Settings", icon: "⚙", action: () => { setShowMenu(false); } },
            { label: expanded ? "Hide Chat" : "Show Chat", icon: "💬", action: () => { setShowMenu(false); setExpanded(!expanded); } },
          ].map(item => (
            <button key={item.label} onClick={item.action} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%",
              padding: "8px 12px", border: "none", background: "transparent",
              borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#374151",
              textAlign: "left",
            }}
              onMouseEnter={e => (e.currentTarget.style.background = "#f3f4f6")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Robot */}
      <div
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => { e.preventDefault(); setShowMenu(!showMenu); }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => { setHovering(false); setTimeout(() => setShowMenu(false), 2000); }}
        style={{
          cursor: "pointer",
          transition: "transform 0.2s ease",
          transform: hovering ? "scale(1.1)" : "scale(1)",
          filter: hovering ? "drop-shadow(0 4px 12px rgba(217,119,87,0.3))" : "drop-shadow(0 2px 8px rgba(0,0,0,0.1))",
        }}
      >
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          style={{
            width: SIZE, height: SIZE,
            imageRendering: "pixelated",
            borderRadius: 20,
            background: "linear-gradient(135deg, #faf6f0, #f0e6d6)",
            padding: 8,
          }}
        />
      </div>

      <style>{`
        @keyframes bubbleIn {
          from { opacity: 0; transform: translateY(8px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
