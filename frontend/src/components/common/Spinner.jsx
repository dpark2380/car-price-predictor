import React from "react";

export default function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, gap: 12 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-loading)", animation: "pulse 1s infinite" }} />
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-loading)", animation: "pulse 1s 0.2s infinite" }} />
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-loading)", animation: "pulse 1s 0.4s infinite" }} />
    </div>
  );
}