"use client";

import { useEffect, useState } from "react";

const API = "/portfolio/api";

function Sprout({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path d="M8 12 V20 C8 28 14 33 20 33 C26 33 32 28 32 20 V12" stroke="#14100D" strokeWidth="3.6" strokeLinecap="round" fill="none" />
      <circle cx="20" cy="7" r="3.2" fill="#14100D" />
    </svg>
  );
}

// بوابة رمز الدخول — بثيم «نامي» الداكن
export default function PinGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "open" | "locked">("checking");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/auth/pin`)
      .then((r) => r.json())
      .then((d) => setState(d.ok ? "open" : "locked"))
      .catch(() => setState("open"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${API}/auth/pin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const d = await r.json();
      if (d.ok) setState("open");
      else setErr(d.error || "رمز غير صحيح");
    } catch {
      setErr("تعذّر الاتصال");
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") {
    return <p style={{ textAlign: "center", color: "#8A7862", fontSize: 14, padding: "64px 0" }}>يتحقق…</p>;
  }

  if (state === "locked") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "#0C0906" }}>
        <div style={{ width: "100%", maxWidth: 360, background: "#1E1813", border: "1px solid #33291F", borderRadius: 18, padding: "30px 26px", textAlign: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: "#F0A94B", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 26px rgba(240,169,75,.3)" }}>
              <Sprout size={32} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 22, letterSpacing: "-.5px", color: "#F2EADF" }}>نامي</div>
              <div style={{ fontSize: 11, color: "#8A7862", marginTop: 3 }}>ينمو مع محفظتك</div>
            </div>
          </div>
          <p style={{ fontSize: 13, color: "#8A7862", margin: "14px 0 16px" }}>هذه الصفحة محمية — أدخل رمز الدخول</p>
          <form onSubmit={submit}>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              dir="ltr"
              style={{ width: "100%", background: "#14100D", border: "1px solid #33291F", borderRadius: 11, padding: "12px 14px", textAlign: "center", fontSize: 20, letterSpacing: "0.3em", color: "#F2EADF", outline: "none" }}
            />
            {err && <p style={{ color: "#E0604A", fontSize: 12, marginTop: 10 }}>{err}</p>}
            <button
              type="submit"
              disabled={busy || !pin}
              style={{ width: "100%", marginTop: 14, padding: "12px", borderRadius: 11, border: "none", background: "#F0A94B", color: "#14100D", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: busy || !pin ? 0.5 : 1 }}
            >
              {busy ? "يتحقق…" : "دخول"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
