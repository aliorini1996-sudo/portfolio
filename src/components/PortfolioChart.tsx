"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const API = "/portfolio/api";
const CHART_H = 172;

type Pt = { t: number; v: number };

const RANGES = [
  { key: "1d", label: "يوم واحد" },
  { key: "5d", label: "5 أيام" },
  { key: "1m", label: "شهر" },
  { key: "6m", label: "6 أشهر" },
  { key: "1y", label: "سنة" },
  { key: "max", label: "الأقصى" },
] as const;

const GREEN = "#5FCB95";
const RED = "#E0604A";

function fmtV(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// وقت الرياض (UTC+3) بصيغة مناسبة للنطاق
function fmtTime(ms: number, range: string): string {
  const d = new Date(ms + 3 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = d.getUTCHours();
  const h12 = ((h + 11) % 12) + 1;
  const hm = `${pad(h12)}:${pad(d.getUTCMinutes())} ${h < 12 ? "ص" : "م"}`;
  const md = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
  if (range === "1d") return hm;
  if (range === "5d") return `${md} ${hm}`;
  if (range === "1m" || range === "6m") return md;
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

export default function PortfolioChart() {
  const [range, setRange] = useState<string>("1d");
  const [points, setPoints] = useState<Pt[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    setHover(null);
    fetch(`${API}/binance/portfolio-history?range=${range}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (d?.error) setErr(d.error);
        setPoints(Array.isArray(d?.points) ? d.points : []);
      })
      .catch(() => live && setErr("تعذّر جلب تاريخ المحفظة"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [range]);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    const pad = (hi - lo || hi || 1) * 0.08;
    lo -= pad;
    hi += pad;
    const n = points.length;
    const x = (i: number) => (i / (n - 1)) * 1000;
    const y = (v: number) => ((hi - v) / (hi - lo)) * 100;
    let line = "";
    for (let i = 0; i < n; i++) line += (i === 0 ? "M" : "L") + x(i).toFixed(2) + " " + y(points[i].v).toFixed(2) + " ";
    line = line.trim();
    const fill = line + ` L1000 100 L0 100 Z`;
    const up = points[n - 1].v >= points[0].v;
    return { n, x, y, lo, hi, line, fill, up };
  }, [points]);

  const color = geo?.up ? GREEN : RED;
  const cur = hover != null && points[hover] ? points[hover] : null;
  const first = points[0]?.v;
  const shownV = cur ? cur.v : points[points.length - 1]?.v;
  const diff = first != null && shownV != null ? shownV - first : 0;
  const diffPct = first ? (diff / first) * 100 : 0;

  function onMove(e: React.PointerEvent) {
    if (!geo || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(frac * (geo.n - 1)));
  }

  return (
    <div style={{ marginTop: 6 }}>
      {/* تبويبات النطاق */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", marginBottom: 12 }}>
        {RANGES.map((rg) => {
          const on = rg.key === range;
          return (
            <button
              key={rg.key}
              onClick={() => setRange(rg.key)}
              style={{
                appearance: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: on ? 700 : 500,
                color: on ? "#14100D" : "#A8927A",
                background: on ? "#F0A94B" : "transparent",
                padding: "5px 11px",
                borderRadius: 8,
                fontFamily: "inherit",
                transition: "background .15s, color .15s",
              }}
            >
              {rg.label}
            </button>
          );
        })}
      </div>

      {/* شارة القيمة عند المؤشر + التغيّر خلال النطاق */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minHeight: 22 }}>
        {cur ? (
          <>
            <span className="mono" style={{ fontWeight: 700, fontSize: 16, color: "#F2EADF" }}>{fmtV(cur.v)}</span>
            <span style={{ fontSize: 11.5, color: "#8A7862" }}>{fmtTime(cur.t, range)}</span>
          </>
        ) : (
          points.length >= 2 && (
            <span style={{ fontSize: 12, color: diff >= 0 ? GREEN : RED, fontWeight: 600 }}>
              {diff >= 0 ? "▲" : "▼"} {diff >= 0 ? "+" : ""}{fmtV(diff)} ({diffPct >= 0 ? "+" : ""}{diffPct.toFixed(2)}%) خلال هذه الفترة
            </span>
          )
        )}
      </div>

      {/* الرسم التفاعلي */}
      <div
        ref={wrapRef}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        style={{ position: "relative", height: CHART_H, marginTop: 8, touchAction: "none", cursor: "crosshair" }}
      >
        {loading ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A7862", fontSize: 12 }}>
            …جارٍ تحميل تاريخ المحفظة
          </div>
        ) : !geo ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#8A7862", fontSize: 12, textAlign: "center", padding: "0 20px" }}>
            {err ? err : "لا يوجد تاريخ كافٍ لعرض المنحنى بعد — يظهر مع تنوّع الحيازات وتوفّر بياناتها."}
          </div>
        ) : (
          <>
            {/* خطوط شبكية أفقية + محور القيمة */}
            {[0, 1, 2, 3].map((k) => {
              const v = geo.hi - ((geo.hi - geo.lo) * k) / 3;
              const topPct = (k / 3) * 100;
              return (
                <div key={k} style={{ position: "absolute", left: 0, right: 0, top: `${topPct}%`, borderTop: "1px dashed #241C14", pointerEvents: "none" }}>
                  <span className="mono" style={{ position: "absolute", left: 0, top: -7, fontSize: 9.5, color: "#6E5C48", background: "#0E0B08", padding: "0 3px" }}>
                    {fmtV(v)}
                  </span>
                </div>
              );
            })}

            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block", overflow: "visible" }}>
              <defs>
                <linearGradient id="pcg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={color} stopOpacity="0.24" />
                  <stop offset="1" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={geo.fill} fill="url(#pcg)" />
              <path d={geo.line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              {hover != null && (
                <line x1={geo.x(hover)} y1="0" x2={geo.x(hover)} y2="100" stroke="#C9B7A2" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              )}
            </svg>

            {/* نقطة المؤشر (HTML كي تبقى دائرية) */}
            {hover != null && points[hover] && (
              <div
                style={{
                  position: "absolute",
                  left: `${(hover / (geo.n - 1)) * 100}%`,
                  top: `${geo.y(points[hover].v)}%`,
                  width: 11,
                  height: 11,
                  marginLeft: -5.5,
                  marginTop: -5.5,
                  borderRadius: "50%",
                  background: color,
                  border: "2px solid #14100D",
                  boxShadow: `0 0 0 3px ${color}33`,
                  pointerEvents: "none",
                }}
              />
            )}

            {/* تلميحة القيمة + الوقت الدقيق */}
            {cur && (
              <div
                style={{
                  position: "absolute",
                  left: `${Math.min(84, Math.max(16, (hover! / (geo.n - 1)) * 100))}%`,
                  top: 2,
                  transform: "translateX(-50%)",
                  background: "#211A13",
                  border: "1px solid #3A2E22",
                  borderRadius: 9,
                  padding: "6px 10px",
                  pointerEvents: "none",
                  whiteSpace: "nowrap",
                  boxShadow: "0 6px 18px rgba(0,0,0,.4)",
                  textAlign: "center",
                }}
              >
                <div className="mono" style={{ fontWeight: 700, fontSize: 13, color: "#F2EADF" }}>{fmtV(cur.v)}</div>
                <div style={{ fontSize: 10, color: "#A8927A", marginTop: 1 }}>{fmtTime(cur.t, range)}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* محور الزمن — بداية/وسط/نهاية */}
      {geo && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 9.5, color: "#6E5C48" }}>
          <span>{fmtTime(points[0].t, range)}</span>
          <span>{fmtTime(points[Math.floor(points.length / 2)].t, range)}</span>
          <span>{fmtTime(points[points.length - 1].t, range)}</span>
        </div>
      )}
    </div>
  );
}
