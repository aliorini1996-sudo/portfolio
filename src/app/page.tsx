"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PinGate from "@/components/PinGate";
import PortfolioChart from "@/components/PortfolioChart";

const API = "/portfolio/api";
const COIN_SYMS: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  BNB: "BNBUSDT",
  SOL: "SOLUSDT",
};
const COINS = ["BTC", "ETH", "BNB", "SOL"] as const;
type CoinKey = (typeof COINS)[number];
type Page = "home" | "wallet" | "bot" | "log" | "settings";

// ===== أدوات مساعدة =====
function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
function rsi14(cl: number[], p = 14): number | null {
  if (cl.length <= p) return null;
  let g = 0,
    l = 0;
  for (let i = 1; i <= p; i++) {
    const d = cl[i] - cl[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / p,
    al = l / p;
  for (let i = p + 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : Math.round(100 - 100 / (1 + ag / al));
}
function buildCandles(kl: Candle[], extra: number[] = [], W = 820, H = 240, pad = 12, volBand = 46) {
  const nil = { candles: [], vols: [], y: (_: number) => 0, xOf: (_: number) => 0, ok: false };
  if (!kl.length) return nil;
  const ex = extra.filter((x) => x && isFinite(x));
  let max = Math.max(...kl.map((c) => c.h), ...ex);
  let min = Math.min(...kl.map((c) => c.l), ...ex);
  const span = max - min || 1;
  max += span * 0.05;
  min -= span * 0.05;
  const n = kl.length,
    cw = (W - pad * 2) / n,
    bw = cw * 0.6;
  const priceTop = pad,
    priceBot = H - pad - volBand;
  const xOf = (i: number) => pad + cw * i + cw / 2;
  const y = (v: number) => priceTop + ((max - v) / (max - min)) * (priceBot - priceTop);
  const candles = kl.map((d, i) => {
    const cx = xOf(i),
      up = d.c >= d.o;
    return {
      x: +(cx - bw / 2).toFixed(1),
      bw: +bw.toFixed(1),
      wx: +cx.toFixed(1),
      wy1: +y(d.h).toFixed(1),
      wy2: +y(d.l).toFixed(1),
      by: +y(Math.max(d.o, d.c)).toFixed(1),
      bh: +Math.max(1.5, Math.abs(y(d.o) - y(d.c))).toFixed(1),
      color: up ? "#4CB782" : "#E0604A",
    };
  });
  const maxVol = Math.max(...kl.map((c) => c.v || 0)) || 1;
  const vTop = H - pad - volBand;
  const vols = kl.map((d, i) => {
    const vh = ((d.v || 0) / maxVol) * volBand;
    return { x: +(xOf(i) - bw / 2).toFixed(1), w: +bw.toFixed(1), y: +(H - pad - vh).toFixed(1), h: +Math.max(0.5, vh).toFixed(1), up: d.c >= d.o };
  });
  void vTop;
  return { candles, vols, y, xOf, ok: true };
}
function emaArr(v: number[], p: number): (number | null)[] {
  const k = 2 / (p + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < v.length; i++) {
    if (i < p - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) s += v[j];
      prev = s / p;
    } else prev = v[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function rsiArr(v: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0,
    l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / p,
    al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function macdArr(v: number[]) {
  const e12 = emaArr(v, 12),
    e26 = emaArr(v, 26);
  const macd = v.map((_, i) => (e12[i] != null && e26[i] != null ? (e12[i] as number) - (e26[i] as number) : null));
  const def = macd.filter((x): x is number => x != null);
  const sig = emaArr(def, 9);
  const signal: (number | null)[] = new Array(v.length).fill(null);
  let di = 0;
  for (let i = 0; i < v.length; i++) {
    if (macd[i] != null) {
      signal[i] = sig[di];
      di++;
    }
  }
  const hist = macd.map((x, i) => (x != null && signal[i] != null ? x - (signal[i] as number) : null));
  return { macd, signal, hist };
}
function pathFrom(pts: ({ x: number; y: number } | null)[]): string {
  let d = "",
    started = false;
  for (const p of pts) {
    if (!p) {
      started = false;
      continue;
    }
    d += (started ? " L" : " M") + p.x.toFixed(1) + "," + p.y.toFixed(1);
    started = true;
  }
  return d.trim();
}

const COIN_COLORS: Record<string, string> = {
  USDT: "#4CB782",
  USDC: "#4CB782",
  FDUSD: "#4CB782",
  SOL: "#56A9CE",
  BNB: "#F0A94B",
  ETH: "#A78BE8",
  BTC: "#E8825C",
};
const dotColor = (s: string) => COIN_COLORS[s] || "#B49BE0";

// ===== الشعار (برعم نامٍ) =====
function Sprout({ size = 26, stroke = "#F0A94B", berry = "#E8825C" }: { size?: number; stroke?: string; berry?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path d="M8 12 V20 C8 28 14 33 20 33 C26 33 32 28 32 20 V12" stroke={stroke} strokeWidth="3.6" strokeLinecap="round" fill="none" />
      <circle cx="20" cy="7" r="3.2" fill={berry} />
    </svg>
  );
}

interface BotState {
  enabled: boolean;
  perTradeUsdt: number;
  dailyCapUsdt: number;
  dailySpent: number;
  minConfidence: number;
  strategy: string;
  positions: { symbol: string; entry: number; stopLoss: number; target: number; qty: number; reason: string }[];
  trades: { pnlPct: number | null; pnlUsdt: number | null }[];
  log: { t: string; level: string; msg: string }[];
  lessons: { t: string; text: string }[];
  lastRunAt: string | null;
}
interface Pnl {
  totalUsdt?: number;
  stableUsdt?: number;
  change24h?: { usdt: number; pct: number };
  assets?: { asset: string; valueUsdt: number; pct24h: number | null }[];
  bot?: { positions: { symbol: string; entry: number; current: number; plUsdt: number; plPct: number }[]; unrealizedUsdt: number };
  daily?: { todayRealized: number; todayClosed: number; monthRealized: number; avgHoldMin: number };
}
interface Bal {
  asset: string;
  free: number;
  total: number;
  usdt: number;
}

export default function HomePage() {
  return (
    <PinGate>
      <Nami />
    </PinGate>
  );
}

function Nami() {
  const [page, setPage] = useState<Page>("home");
  const [coin, setCoin] = useState<CoinKey>("BTC");
  const [bot, setBot] = useState<BotState | null>(null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [bals, setBals] = useState<Bal[]>([]);
  const [totalUsdt, setTotalUsdt] = useState<number | null>(null);
  const [kl, setKl] = useState<Candle[]>([]);
  const [quotes, setQuotes] = useState<Record<string, { price: number; ch: number }>>({});
  const [fng, setFng] = useState<{ value: number; label: string } | null>(null);
  const [msgs, setMsgs] = useState<{ who: "nami" | "user"; text: string }[]>([
    { who: "nami", text: "أهلاً — أنا نامي. أراقب أسواقك على مدار الساعة وأضارب بانضباط وفق استراتيجية مقفلة. اسألني عن أي عملة أو سيناريو أو قرار." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [perTrade, setPerTrade] = useState("20");
  const [dailyBudget, setDailyBudget] = useState("80");
  const [strategy, setStrategy] = useState("");
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [note, setNote] = useState("");
  const [w, setW] = useState(1200);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const settingsInit = useRef(false); // هل هُيّئت حقول الإعدادات؟ (لتهيئة واحدة لا تتكرّر)

  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const wide = w >= 900;

  // تحميل الحالة (حساب + أرباح + بوت)
  const loadAll = useCallback(async () => {
    try {
      const [aR, pR, sR] = await Promise.all([
        fetch(`${API}/binance/account`).then((r) => r.json()),
        fetch(`${API}/binance/pnl`).then((r) => r.json()),
        fetch(`${API}/binance/autopilot/status`).then((r) => r.json()),
      ]);
      if (aR?.balances) {
        setBals(aR.balances);
        setTotalUsdt(aR.totalUsdt ?? null);
      }
      if (pR?.configured !== false) setPnl(pR);
      if (sR?.state) {
        setBot(sR.state);
        // تهيئة حقول الإعدادات مرة واحدة فقط — لا يدهسها كل تحديث دوري (يمنع ضياع إدخالك)
        if (!settingsInit.current) {
          setPerTrade(String(sR.state.perTradeUsdt ?? 0));
          setDailyBudget(String(sR.state.dailyCapUsdt ?? 0));
          setStrategy(sR.state.strategy ?? "");
          settingsInit.current = true;
        }
      }
    } catch {
      /* تجاهل */
    }
  }, []);
  useEffect(() => {
    loadAll();
    const iv = setInterval(loadAll, 30_000);
    return () => clearInterval(iv);
  }, [loadAll]);

  // نبض احتياطي من المتصفّح: يشغّل دورة فحص كل 5 دقائق ما دامت اللوحة مفتوحة
  // (Vercel Hobby لا يدعم كروناً متكرراً؛ هذا يبقي البوت حيّاً عند مشاهدتك)
  useEffect(() => {
    const ping = () =>
      fetch(`${API}/binance/autopilot/tick`, { method: "POST" })
        .then(() => loadAll())
        .catch(() => {});
    const kick = setTimeout(ping, 8000); // دورة أولى بعد التحميل
    const iv = setInterval(ping, 5 * 60 * 1000);
    return () => {
      clearTimeout(kick);
      clearInterval(iv);
    };
  }, [loadAll]);

  // أسعار العملات الأربع (لمحة السوق + رأس الشارت)
  const loadQuotes = useCallback(async () => {
    const out: Record<string, { price: number; ch: number }> = {};
    await Promise.all(
      COINS.map(async (c) => {
        try {
          const d = await fetch(`${API}/binance/quote?symbol=${COIN_SYMS[c]}`).then((r) => r.json());
          if (d?.price) out[c] = { price: d.price, ch: d.changePercent ?? 0 };
        } catch {
          /* تجاهل */
        }
      })
    );
    setQuotes(out);
  }, []);
  useEffect(() => {
    loadQuotes();
    const iv = setInterval(loadQuotes, 20_000);
    return () => clearInterval(iv);
  }, [loadQuotes]);

  // شموع العملة المختارة
  useEffect(() => {
    let live = true;
    fetch(`${API}/binance/klines?symbol=${COIN_SYMS[coin]}&interval=1h&limit=48`)
      .then((r) => r.json())
      .then((d) => {
        if (live && d?.candles) setKl(d.candles);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [coin]);

  // مؤشر الخوف والطمع
  useEffect(() => {
    fetch("https://api.alternative.me/fng/?limit=1")
      .then((r) => r.json())
      .then((d) => {
        const x = d?.data?.[0];
        if (x) setFng({ value: +x.value, label: x.value_classification });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  const running = bot?.enabled ?? false;

  // ===== أفعال =====
  const post = async (path: string, body?: object) => {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  const toggleBot = async () => {
    const d = await post("/binance/autopilot/settings", { enabled: !running });
    if (d?.state) setBot((b) => (b ? { ...b, enabled: d.state.enabled } : b));
  };
  const runCycle = async () => {
    setNote("يفحص السوق…");
    const d = await post("/binance/autopilot/tick");
    setNote(d?.actions?.length ? d.actions.join(" • ") : d?.reason || "دورة تمّت — لا إجراءات");
    loadAll();
  };
  const saveRisk = async () => {
    const pt = parseFloat(perTrade);
    const dc = parseFloat(dailyBudget);
    const body: Record<string, number> = {};
    if (Number.isFinite(pt) && (pt === 0 || pt >= 10)) body.perTradeUsdt = pt;
    if (Number.isFinite(dc) && (dc === 0 || dc >= 10)) body.dailyCapUsdt = dc;
    if (!("perTradeUsdt" in body) && !("dailyCapUsdt" in body)) {
      setNote("القيمة يجب أن تكون 0 (بلا حد) أو 10 فأكثر");
      return;
    }
    const d = await post("/binance/autopilot/settings", body);
    if (d?.state) {
      // اعرض القيم من ردّ الحفظ الموثوق (لا نعيد قراءة Blob القديم فوراً)
      setBot((b) => (b ? { ...b, ...d.state } : d.state));
      setPerTrade(String(d.state.perTradeUsdt ?? 0));
      setDailyBudget(String(d.state.dailyCapUsdt ?? 0));
      setNote("✓ حُفظت الإعدادات");
    } else setNote(d?.error || "تعذّر الحفظ");
  };
  const saveStrategy = async () => {
    setSavingStrategy(true);
    setNote("");
    try {
      const d = await post("/binance/autopilot/settings", { strategy });
      if (d?.state) {
        setBot((b) => (b ? { ...b, strategy: d.state.strategy } : d.state));
        setStrategy(d.state.strategy ?? "");
        setNote("✓ حُفظ الدستور");
      } else setNote(d?.error || "تعذّر الحفظ");
    } catch (e) {
      setNote(String(e));
    } finally {
      setSavingStrategy(false);
    }
  };

  const setConf = async (level: number) => {
    const mc = level === 0 ? 0 : level === 1 ? 55 : 75;
    const d = await post("/binance/autopilot/settings", { minConfidence: mc });
    if (d?.state) setBot((b) => (b ? { ...b, minConfidence: d.state.minConfidence } : b));
  };
  const liquidate = async () => {
    if (!confirm("تصفية شاملة: يبيع نامي كل عملاتك سوقاً ويبدأ من جديد. متابعة؟")) return;
    setNote("يصفّي…");
    const d = await post("/binance/autopilot/liquidate");
    setNote(d?.error || `تمّت التصفية — بيع ${d?.soldCount ?? 0} أصل`);
    loadAll();
  };
  const sendChat = async () => {
    const t = chatInput.trim();
    if (!t || chatBusy) return;
    setChatInput("");
    setMsgs((m) => [...m, { who: "user", text: t }]);
    setChatBusy(true);
    try {
      const hist = [...msgs, { who: "user" as const, text: t }].map((m) => ({
        role: m.who === "nami" ? "assistant" : "user",
        content: m.text,
      }));
      const d = await post("/binance/chat", { messages: hist });
      setMsgs((m) => [...m, { who: "nami", text: d?.reply || d?.error || "…" }]);
    } catch (e) {
      setMsgs((m) => [...m, { who: "nami", text: String(e) }]);
    } finally {
      setChatBusy(false);
    }
  };

  // ===== مشتقّات العرض =====
  const posForCoin = bot?.positions.find((p) => p.symbol === COIN_SYMS[coin]);
  const chart = useMemo(
    () => buildCandles(kl, posForCoin ? [posForCoin.target, posForCoin.stopLoss] : []),
    [kl, posForCoin]
  );
  const coinRsi = useMemo(() => rsi14(kl.map((c) => c.c)), [kl]);
  const q = quotes[coin];
  const coinPrice = q ? fmt(q.price, q.price < 1 ? 4 : 2) : "—";
  const coinChange = q ? `${q.ch >= 0 ? "+" : ""}${q.ch.toFixed(2)}%` : "—";
  const winRate = useMemo(() => {
    const scored = (bot?.trades || []).filter((t) => t.pnlPct != null);
    if (!scored.length) return 0;
    return Math.round((scored.filter((t) => (t.pnlPct as number) > 0).length / scored.length) * 100);
  }, [bot]);
  const netRealized = (bot?.trades || []).reduce((a, t) => a + (t.pnlUsdt || 0), 0);
  const wins = (bot?.trades || []).filter((t) => (t.pnlPct ?? 0) > 0).length;
  const losses = (bot?.trades || []).filter((t) => t.pnlPct != null && (t.pnlPct as number) <= 0).length;

  const positions =
    bot?.positions.map((p) => {
      const cur = pnl?.bot?.positions.find((x) => x.symbol === p.symbol);
      const plPct = cur ? cur.plPct : 0;
      return {
        pair: p.symbol,
        entry: fmt(p.entry, p.entry < 1 ? 4 : 2),
        target: fmt(p.target, p.target < 1 ? 4 : 2),
        stop: fmt(p.stopLoss, p.stopLoss < 1 ? 4 : 2),
        pnl: `${plPct >= 0 ? "+" : ""}${plPct.toFixed(2)}%`,
        up: plPct >= 0,
      };
    }) || [];

  const holdings = (() => {
    const items = bals
      .filter((b) => b.usdt >= 0.5 || ["USDT", "USDC", "FDUSD"].includes(b.asset))
      .sort((a, b) => b.usdt - a.usdt);
    const tot = items.reduce((s, b) => s + b.usdt, 0) || 1;
    return items.map((b) => {
      const stable = ["USDT", "USDC", "FDUSD", "BUSD"].includes(b.asset);
      const a = pnl?.assets?.find((x) => x.asset === b.asset);
      const ch = stable ? "0.00%" : a?.pct24h != null ? `${a.pct24h >= 0 ? "+" : ""}${a.pct24h.toFixed(2)}%` : "—";
      return {
        sym: b.asset,
        amount: fmt(b.total, 6),
        value: fmt(b.usdt, 2),
        ch,
        chColor: ch === "0.00%" || ch === "—" ? "#8A7862" : ch.startsWith("-") ? "#E0604A" : "#5FCB95",
        color: dotColor(b.asset),
        pct: (b.usdt / tot) * 100,
      };
    });
  })();

  const decisionLog = (bot?.log || []).map((l) => ({
    time: new Date(l.t).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }),
    dot: l.level === "trade" ? "#4CB782" : l.level === "error" ? "#E0604A" : "#7A6650",
    text: l.msg,
  }));

  const titles: Record<Page, [string, string]> = {
    home: ["الرئيسية", "نظرة نموّ محفظتك اليوم"],
    wallet: ["المحفظة", "أرصدتك وتوزيعك ومراكزك"],
    bot: ["نامي — البوت", "حدّث نامي واسأله عن السوق"],
    log: ["سجلّ القرارات", "كل خطوة يتّخذها نامي — ويتعلّم منها"],
    settings: ["الإعدادات", "حدود المخاطرة واستراتيجية نامي"],
  };

  const dailyPnl = pnl?.daily?.todayRealized ?? 0;
  const change24 = pnl?.change24h?.usdt ?? 0;
  const unreal = pnl?.bot?.unrealizedUsdt ?? 0;
  // مقاييس بطاقة «حالة نامي»
  const totalForPct = pnl?.totalUsdt || 0;
  const todayPct = totalForPct > 0 ? (dailyPnl / totalForPct) * 100 : 0;
  const monthPct = totalForPct > 0 ? ((pnl?.daily?.monthRealized ?? 0) / totalForPct) * 100 : 0;
  const avgHoldMin = pnl?.daily?.avgHoldMin ?? 0;
  const fmtDuration = (min: number) => {
    if (!min) return "—";
    if (min < 60) return `${min} د`;
    const h = Math.floor(min / 60),
      m = min % 60;
    return m ? `${h}س ${m}د` : `${h} س`;
  };
  const green = "#5FCB95",
    red = "#E0604A";

  // ===== عناصر مشتركة =====
  const navItem = (p: Page, label: string, icon: React.ReactNode) => {
    const a = page === p;
    return (
      <div
        onClick={() => setPage(p)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "10px 12px",
          borderRadius: 11,
          cursor: "pointer",
          transition: ".15s",
          fontWeight: a ? 600 : 500,
          fontSize: 12.5,
          background: a ? "rgba(240,169,75,.14)" : "transparent",
          color: a ? "#F0A94B" : "#9A8B7A",
        }}
      >
        {icon}
        {label}
      </div>
    );
  };
  const ico = (d: string, extra?: React.ReactNode) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      {extra}
    </svg>
  );
  const Switch = () => (
    <span
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        position: "relative",
        transition: ".2s",
        background: running ? "#4CB782" : "#3A2E22",
        display: "inline-block",
        flex: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: running ? 3 : undefined,
          right: running ? undefined : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          transition: ".2s",
          boxShadow: "0 1px 3px rgba(0,0,0,.35)",
        }}
      />
    </span>
  );
  const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    background: "#1E1813",
    border: "1px solid #33291F",
    borderRadius: 18,
    ...extra,
  });
  const kpi = (label: string, value: string, color = "#F2EADF") => (
    <div style={card({ padding: "16px 18px" })}>
      <div style={{ fontSize: 11, color: "#8A7862" }}>{label}</div>
      <div className="mono" style={{ fontWeight: 600, fontSize: 21, marginTop: 5, color }}>
        {value}
      </div>
    </div>
  );
  const posTable = (title: string) => (
    <div style={card({ padding: "20px 22px" })}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: "#F2EADF" }}>{title}</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr 1fr 1fr .8fr",
          gap: 8,
          padding: "0 4px 10px",
          borderBottom: "1px solid #2A2018",
          fontWeight: 500,
          fontSize: 11,
          color: "#8A7862",
        }}
      >
        <span>الزوج</span>
        <span>دخول</span>
        <span style={{ color: "#5FCB95" }}>هدف</span>
        <span style={{ color: "#E0604A" }}>وقف</span>
        <span style={{ textAlign: "end" }}>ربح/خسارة</span>
      </div>
      {positions.length === 0 && <div style={{ padding: "16px 4px", color: "#8A7862", fontSize: 12 }}>لا مراكز مفتوحة.</div>}
      {positions.map((p) => (
        <div
          key={p.pair}
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 1fr 1fr 1fr .8fr",
            gap: 8,
            padding: "12px 4px",
            borderBottom: "1px solid #221A13",
            alignItems: "center",
          }}
        >
          <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#F2EADF" }}>{p.pair}</span>
          <span className="mono" style={{ fontSize: 12, color: "#B8A794" }}>{p.entry}</span>
          <span className="mono" style={{ fontSize: 12, color: "#5FCB95" }}>{p.target}</span>
          <span className="mono" style={{ fontSize: 12, color: "#E0604A" }}>{p.stop}</span>
          <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: p.up ? "#5FCB95" : "#E0604A", textAlign: "end" }}>{p.pnl}</span>
        </div>
      ))}
    </div>
  );

  // ===== الشريط الجانبي =====
  const sidebar = (
    <aside
      style={{
        width: 236,
        flex: "none",
        background: "#1A130E",
        borderInlineEnd: "1px solid #2A2018",
        padding: "22px 16px",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        height: "100vh",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 6px 20px" }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 13,
            background: "#221A13",
            border: "1px solid #3A2E22",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 22px rgba(240,169,75,.18)",
          }}
        >
          <Sprout size={26} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 20, letterSpacing: "-.5px", color: "#F2EADF" }}>نامي</div>
          <div style={{ fontWeight: 400, fontSize: 10, color: "#8A7862", marginTop: 3 }}>ينمو مع محفظتك</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {navItem("home", "الرئيسية", ico("M3 11l9-7 9 7", <path d="M5 10v9h14v-9" />))}
        {navItem("wallet", "المحفظة", ico("M3 10h18", <><rect x="3" y="6" width="18" height="13" rx="2" /><circle cx="17" cy="14" r="1" /></>))}
        {navItem(
          "bot",
          "نامي — البوت",
          ico("M12 20v-8", <><path d="M12 12c-4 0-6-3-6-6 4 0 6 3 6 6z" /><path d="M12 14c3.5 0 5-2.5 5-5-3 0-5 2-5 5z" /></>)
        )}
        {navItem("log", "سجلّ القرارات", ico("M8 6h12M8 12h12M8 18h12", <><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>))}
        {navItem("settings", "الإعدادات", ico("M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2", <circle cx="12" cy="12" r="3" />))}
      </div>
      <div style={{ marginTop: "auto", background: "#0E0B08", border: "1px solid #2A2018", borderRadius: 13, padding: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: running ? "#4CB782" : "#E0604A", animation: "livepulse 2s infinite" }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 11, color: "#F2EADF" }}>{running ? "نامي يعمل" : "نامي متوقّف"}</div>
            <div style={{ fontWeight: 400, fontSize: 9, color: "#8A7862" }}>Binance مربوط</div>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 10, color: "#7A6650" }}>
          آخر دورة {bot?.lastRunAt ? new Date(bot.lastRunAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" }) : "—"}
        </div>
      </div>
    </aside>
  );

  // شريط تنقّل سفلي للجوال
  const bottomNav = (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "#1A130E",
        borderTop: "1px solid #2A2018",
        display: "flex",
        justifyContent: "space-around",
        padding: "8px 4px",
        zIndex: 20,
      }}
    >
      {([
        ["home", "الرئيسية", "M3 11l9-7 9 7"],
        ["wallet", "المحفظة", "M3 10h18"],
        ["bot", "نامي", "M12 20v-8"],
        ["log", "السجل", "M8 6h12M8 12h12M8 18h12"],
        ["settings", "إعدادات", "M12 2v3"],
      ] as [Page, string, string][]).map(([p, label, d]) => (
        <div key={p} onClick={() => setPage(p)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: page === p ? "#F0A94B" : "#9A8B7A", cursor: "pointer" }}>
          {ico(d)}
          <span style={{ fontSize: 9 }}>{label}</span>
        </div>
      ))}
    </div>
  );

  const g2 = (a: string) => (wide ? a : "1fr");

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1440, margin: "0 auto", background: "#14100D" }}>
      {wide && sidebar}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", paddingBottom: wide ? 0 : 64 }}>
        {/* الترويسة */}
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: wide ? "18px 30px" : "14px 16px",
            borderBottom: "1px solid #2A2018",
            background: "#14100D",
            position: "sticky",
            top: 0,
            zIndex: 5,
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: wide ? 18 : 15, color: "#F2EADF" }}>{titles[page][0]}</div>
            <div style={{ fontWeight: 400, fontSize: 11, color: "#8A7862", marginTop: 2 }}>{titles[page][1]}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ textAlign: "end" }}>
              <div style={{ fontSize: 10, color: "#8A7862" }}>قيمة المحفظة</div>
              <div className="mono" style={{ fontWeight: 600, fontSize: 15, color: "#F2EADF" }}>
                {fmt(totalUsdt, 2)} <span style={{ fontSize: 10, color: "#7A6650" }}>USDT</span>
              </div>
            </div>
            <div
              onClick={toggleBot}
              style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", userSelect: "none", background: "#1E1813", border: "1px solid #33291F", padding: "7px 12px", borderRadius: 11 }}
            >
              <span style={{ fontWeight: 600, fontSize: 11, color: running ? "#5FCB95" : "#E0604A" }}>{running ? "يعمل" : "متوقّف"}</span>
              <Switch />
            </div>
          </div>
        </header>

        <div style={{ padding: wide ? "26px 30px 44px" : "18px 16px 30px", flex: 1 }}>
          {/* ================= HOME ================= */}
          {page === "home" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "fadein .4s ease" }}>
              <div style={{ display: "grid", gridTemplateColumns: g2("1.5fr 1fr"), gap: 18 }}>
                <div style={card({ padding: "22px 24px" })}>
                  <div style={{ fontSize: 12, color: "#8A7862" }}>قيمة محفظتك الآن</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 5 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 42, lineHeight: 1, letterSpacing: "-1px", color: "#F2EADF" }}>{fmt(totalUsdt, 2)}</span>
                    <span style={{ fontWeight: 600, fontSize: 15, color: "#7A6650" }}>USDT</span>
                  </div>
                  <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 7, background: change24 >= 0 ? "rgba(76,183,130,.15)" : "rgba(224,96,74,.15)", padding: "6px 12px", borderRadius: 999 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={change24 >= 0 ? "#5FCB95" : "#E0604A"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d={change24 >= 0 ? "M5 15l7-7 7 7" : "M5 9l7 7 7-7"} />
                    </svg>
                    <span style={{ color: change24 >= 0 ? "#5FCB95" : "#E0604A", fontWeight: 600, fontSize: 12.5 }}>
                      {change24 >= 0 ? "نمَت" : "تراجعت"} {change24 >= 0 ? "+" : ""}{fmt(change24, 2)} اليوم ({pnl?.change24h ? `${pnl.change24h.pct >= 0 ? "+" : ""}${pnl.change24h.pct.toFixed(1)}%` : "—"})
                    </span>
                  </div>
                  <PortfolioChart />
                </div>
                <div style={{ background: "#0E0B08", border: "1px solid #2A2018", borderRadius: 18, padding: 20, display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: "#F0A94B", display: "flex", alignItems: "center", justifyContent: "center", animation: "floaty 3.5s ease-in-out infinite" }}>
                      <Sprout size={24} stroke="#14100D" berry="#14100D" />
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>حالة نامي</div>
                      <div style={{ fontWeight: 400, fontSize: 10, color: "#5FCB95" }}>{running ? "نامي يعمل" : "متوقّف"} · بيانات حيّة</div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 16, marginBottom: "auto" }}>
                    {[
                      ["ربح/خسارة اليوم", `${todayPct >= 0 ? "+" : ""}${todayPct.toFixed(2)}%`, todayPct >= 0 ? green : red],
                      ["ربح/خسارة الشهر", `${monthPct >= 0 ? "+" : ""}${monthPct.toFixed(2)}%`, monthPct >= 0 ? green : red],
                      ["متوسط وقت الصفقة", fmtDuration(avgHoldMin), "#F2EADF"],
                      ["المراكز المفتوحة", String(bot?.positions.length ?? 0), "#F2EADF"],
                    ].map(([l, v, c], i) => (
                      <div key={i} style={{ background: "rgba(255,255,255,.04)", borderRadius: 11, padding: "13px 12px" }}>
                        <div style={{ fontSize: 10, color: "#8A7862" }}>{l}</div>
                        <div className="mono" style={{ fontWeight: 600, fontSize: 16, marginTop: 4, color: c as string }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(4,1fr)" : "1fr 1fr", gap: 14 }}>
                {kpi("سيولة مستقرّة", fmt(pnl?.stableUsdt, 2))}
                {kpi("ربح/خسارة 24س", `${change24 >= 0 ? "+" : ""}${fmt(change24, 2)}`, change24 >= 0 ? "#5FCB95" : "#E0604A")}
                {kpi("غير محقّق", `${unreal >= 0 ? "+" : ""}${fmt(unreal, 2)}`, unreal >= 0 ? "#5FCB95" : "#E0604A")}
                {kpi("نسبة النجاح", `${winRate}%`, "#F0A94B")}
              </div>

              {chartCard()}
              {posTable("مراكز فتحها نامي (" + positions.length + ")")}
            </div>
          )}

          {/* ================= WALLET ================= */}
          {page === "wallet" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "fadein .4s ease" }}>
              <div style={{ display: "grid", gridTemplateColumns: g2("1fr 1.4fr"), gap: 18 }}>
                <div style={{ background: "#0E0B08", border: "1px solid #2A2018", borderRadius: 18, padding: 22 }}>
                  <div style={{ fontSize: 12, color: "#8A7862" }}>إجمالي القيمة التقديرية</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 38, lineHeight: 1, color: "#F2EADF" }}>{fmt(totalUsdt, 2)}</span>
                    <span style={{ fontWeight: 600, fontSize: 14, color: "#7A6650" }}>USDT</span>
                  </div>
                  <div style={{ marginTop: 20 }}>
                    <div style={{ fontSize: 11, color: "#8A7862", marginBottom: 8 }}>التوزيع</div>
                    <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", gap: 2 }}>
                      {holdings.map((h) => (
                        <span key={h.sym} style={{ width: `${h.pct}%`, height: "100%", background: h.color, borderRadius: 2 }} />
                      ))}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                      {holdings.map((h) => (
                        <span key={h.sym} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "#B8A794" }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", background: h.color, display: "inline-block", flex: "none" }} />
                          {h.sym}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div style={card({ padding: "20px 22px" })}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: "#F2EADF" }}>أرصدتي</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr .9fr", gap: 8, padding: "0 2px 10px", borderBottom: "1px solid #2A2018", fontWeight: 500, fontSize: 11, color: "#8A7862" }}>
                    <span>العملة</span>
                    <span>المتاح</span>
                    <span>القيمة USDT</span>
                    <span style={{ textAlign: "end" }}>24س</span>
                  </div>
                  {holdings.map((h) => (
                    <div key={h.sym} style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr .9fr", gap: 8, padding: "12px 2px", borderBottom: "1px solid #221A13", alignItems: "center" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: h.color, display: "inline-block", flex: "none" }} />
                        <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#F2EADF" }}>{h.sym}</span>
                      </span>
                      <span className="mono" style={{ fontSize: 12, color: "#B8A794" }}>{h.amount}</span>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#F2EADF" }}>{h.value}</span>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12, textAlign: "end", color: h.chColor }}>{h.ch}</span>
                    </div>
                  ))}
                </div>
              </div>
              {posTable("المراكز المفتوحة تفصيلاً")}
            </div>
          )}

          {/* ================= BOT ================= */}
          {page === "bot" && (
            <div style={{ display: "grid", gridTemplateColumns: g2("1.6fr 1fr"), gap: 18, animation: "fadein .4s ease" }}>
              <div style={card({ display: "flex", flexDirection: "column", height: wide ? 600 : 460 })}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 20px", borderBottom: "1px solid #2A2018" }}>
                  <div style={{ width: 38, height: 38, borderRadius: 12, background: "#F0A94B", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Sprout size={22} stroke="#14100D" berry="#14100D" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>نامي يحلّل السوق</div>
                    <div style={{ fontWeight: 400, fontSize: 10, color: "#5FCB95" }}>● بيانات حيّة</div>
                  </div>
                  <span
                    onClick={() => setMsgs([{ who: "nami", text: "مسحتُ المحادثة. اسألني عن أي عملة أو سيناريو أو قرار." }])}
                    style={{ fontWeight: 500, fontSize: 11, color: "#F0A94B", background: "rgba(240,169,75,.12)", padding: "5px 11px", borderRadius: 8, cursor: "pointer" }}
                  >
                    مسح المحادثة
                  </span>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
                  {msgs.map((m, i) =>
                    m.who === "nami" ? (
                      <div key={i} style={{ alignSelf: "flex-start", maxWidth: "82%", background: "#26201A", borderRadius: 14, borderTopRightRadius: 4, padding: "12px 14px", fontSize: 12.5, lineHeight: 1.75, color: "#D8C8B4", animation: "fadein .3s ease", whiteSpace: "pre-wrap" }}>
                        {m.text}
                      </div>
                    ) : (
                      <div key={i} style={{ alignSelf: "flex-end", maxWidth: "82%", background: "#F0A94B", color: "#14100D", borderRadius: 14, borderTopLeftRadius: 4, padding: "12px 14px", fontWeight: 500, fontSize: 12.5, lineHeight: 1.7, animation: "fadein .3s ease", whiteSpace: "pre-wrap" }}>
                        {m.text}
                      </div>
                    )
                  )}
                  {chatBusy && <div style={{ alignSelf: "flex-start", color: "#8A7862", fontSize: 12 }}>نامي يكتب…</div>}
                  <div ref={chatEndRef} />
                </div>
                <div style={{ padding: "14px 18px", borderTop: "1px solid #2A2018" }}>
                  <div style={{ display: "flex", gap: 9 }}>
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendChat()}
                      placeholder="اسأل نامي عن السوق، عملة، سيناريو، أو قرار…"
                      style={{ flex: 1, border: "1px solid #33291F", background: "#14100D", borderRadius: 11, padding: "11px 14px", fontSize: 12, color: "#F2EADF", outline: "none" }}
                    />
                    <button onClick={sendChat} disabled={chatBusy} style={{ border: "none", background: "#F0A94B", color: "#14100D", fontWeight: 700, fontSize: 12, padding: "0 18px", borderRadius: 11, cursor: "pointer", opacity: chatBusy ? 0.6 : 1 }}>
                      إرسال
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: "#7A6650", marginTop: 8 }}>تحليل آليّ للمساعدة — ليس نصيحة مالية، والقرار النهائي لك.</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={card({ padding: "18px 20px" })}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14, color: "#F2EADF" }}>لمحة السوق</div>
                  {COINS.map((c, i) => {
                    const qq = quotes[c];
                    return (
                      <div key={c} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: i < 3 ? "1px solid #221A13" : "none" }}>
                        <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#F2EADF" }}>{COIN_SYMS[c]}</span>
                        <span className="mono" style={{ fontWeight: 500, fontSize: 12, color: "#B8A794" }}>{qq ? fmt(qq.price, qq.price < 1 ? 4 : 2) : "—"}</span>
                        <span className="mono" style={{ fontWeight: 600, fontSize: 11, color: qq && qq.ch >= 0 ? "#5FCB95" : "#E0604A" }}>{qq ? `${qq.ch >= 0 ? "+" : ""}${qq.ch.toFixed(2)}%` : "—"}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ background: "linear-gradient(135deg,#C0562F,#A8472B)", borderRadius: 18, padding: "18px 20px", color: "#fff" }}>
                  <div style={{ fontSize: 11, opacity: 0.85 }}>مؤشر الخوف والطمع</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 34 }}>{fng?.value ?? "—"}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{fngLabel(fng)}</span>
                  </div>
                  <div style={{ height: 6, background: "rgba(255,255,255,.25)", borderRadius: 999, marginTop: 12, overflow: "hidden" }}>
                    <span style={{ display: "block", width: `${fng?.value ?? 0}%`, height: "100%", background: "#fff", borderRadius: 999 }} />
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 12, opacity: 0.92 }}>
                    {fng && fng.value < 35 ? "الخوف الشديد قد يخلق فرصاً — لكن نامي لا يدخل دون تأكيد سعري." : "نامي يوازن المعنويات مع الشارت — ولا يدخل دون تأكيد."}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================= LOG ================= */}
          {page === "log" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "fadein .4s ease" }}>
              <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(3,1fr)" : "1fr", gap: 14 }}>
                <div style={card({ padding: "18px 20px", textAlign: "center" })}>
                  <div style={{ fontSize: 11, color: "#8A7862" }}>صافي الربح</div>
                  <div className="mono" style={{ fontWeight: 600, fontSize: 26, color: netRealized >= 0 ? "#5FCB95" : "#E0604A", marginTop: 6 }}>{netRealized >= 0 ? "+" : ""}{fmt(netRealized, 2)}</div>
                </div>
                <div style={card({ padding: "18px 20px", textAlign: "center" })}>
                  <div style={{ fontSize: 11, color: "#8A7862" }}>رابحة / خاسرة</div>
                  <div className="mono" style={{ fontWeight: 600, fontSize: 26, marginTop: 6, color: "#F2EADF" }}>{wins} / {losses}</div>
                </div>
                <div style={card({ padding: "18px 20px", textAlign: "center" })}>
                  <div style={{ fontSize: 11, color: "#8A7862" }}>نسبة الربح</div>
                  <div className="mono" style={{ fontWeight: 600, fontSize: 26, color: "#F0A94B", marginTop: 6 }}>{winRate}%</div>
                </div>
              </div>

              <div style={card({ padding: "20px 22px" })}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>سجلّ قرارات نامي</div>
                  <button onClick={runCycle} style={{ border: "1px solid #33291F", background: "#14100D", color: "#F2EADF", fontWeight: 600, fontSize: 11, padding: "8px 13px", borderRadius: 9, cursor: "pointer" }}>⟳ شغّل دورة فحص الآن</button>
                </div>
                {note && <div style={{ fontSize: 11, color: "#8A7862", marginBottom: 10 }}>{note}</div>}
                <div style={{ display: "flex", flexDirection: "column", maxHeight: 300, overflowY: "auto" }}>
                  {decisionLog.map((d, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 2px", borderBottom: "1px solid #221A13" }}>
                      <span className="mono" style={{ fontSize: 10.5, color: "#7A6650", flex: "none", paddingTop: 1 }}>{d.time}</span>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: d.dot, flex: "none", marginTop: 5 }} />
                      <span style={{ fontSize: 12, lineHeight: 1.6, color: "#D8C8B4" }}>{d.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: g2("1fr 1fr"), gap: 18 }}>
                <div style={{ background: "#26201A", border: "1px solid #33291F", borderRadius: 18, padding: "20px 22px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6, color: "#F2EADF" }}>📘 دروس تعلّمها نامي</div>
                  <div style={{ fontSize: 11, color: "#8A7862", marginBottom: 14 }}>يلتزم بها في كل قرار قادم</div>
                  {(bot?.lessons || []).length === 0 && <div style={{ fontSize: 12, color: "#8A7862" }}>لا دروس بعد — تُستخلص من مراجعة الصفقات.</div>}
                  {(bot?.lessons || []).slice().reverse().map((l, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderBottom: "1px solid #33291F" }}>
                      <span style={{ color: "#5FCB95", fontWeight: 700, fontSize: 13, flex: "none" }}>✓</span>
                      <span style={{ fontSize: 12, lineHeight: 1.6, color: "#D8C8B4" }}>{l.text}</span>
                    </div>
                  ))}
                </div>
                <div style={{ background: "#0E0B08", border: "1px solid #2A2018", borderRadius: 18, padding: "20px 22px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: "#F2EADF" }}>مراكز نامي المفتوحة</div>
                  {positions.length === 0 && <div style={{ fontSize: 12, color: "#8A7862" }}>لا مراكز مفتوحة.</div>}
                  {positions.map((p) => (
                    <div key={p.pair} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #221A13" }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: "#E6D8C6" }}>{p.pair}</span>
                      <span className="mono" style={{ fontSize: 11, color: "#8A7862" }}>{p.entry} → {p.target}</span>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12, color: p.up ? "#5FCB95" : "#E0604A" }}>{p.pnl}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ================= SETTINGS ================= */}
          {page === "settings" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 760, animation: "fadein .4s ease" }}>
              <div style={card({ padding: "22px 24px" })}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>تشغيل نامي</div>
                    <div style={{ fontSize: 11, color: "#8A7862", marginTop: 3 }}>عند الإيقاف لا يفتح البوت أي صفقة جديدة</div>
                  </div>
                  <div onClick={toggleBot} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color: running ? "#5FCB95" : "#E0604A" }}>{running ? "يعمل" : "متوقّف"}</span>
                    <Switch />
                  </div>
                </div>
              </div>

              <div style={card({ padding: "22px 24px" })}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 18, color: "#F2EADF" }}>حدود المخاطرة</div>
                <div style={{ display: "grid", gridTemplateColumns: g2("1fr 1fr"), gap: 18 }}>
                  <div>
                    <label style={{ fontWeight: 500, fontSize: 12, color: "#B8A794" }}>مبلغ كل صفقة (USDT) — 0 = بلا حد</label>
                    <input type="number" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} onBlur={saveRisk} className="mono" style={inputStyle} />
                  </div>
                  <div>
                    <label style={{ fontWeight: 500, fontSize: 12, color: "#B8A794" }}>مصروف اليوم الأقصى (USDT) — 0 = بلا حد</label>
                    <input type="number" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} onBlur={saveRisk} className="mono" style={inputStyle} />
                  </div>
                </div>
                <div style={{ marginTop: 18 }}>
                  <label style={{ fontWeight: 500, fontSize: 12, color: "#B8A794" }}>حدّ الثقة قبل الدخول</label>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    {["بلا شرط", "متوسط", "مرتفع"].map((lbl, i) => {
                      const active = (bot?.minConfidence ?? 0) === (i === 0 ? 0 : i === 1 ? 55 : 75) || (i === 0 && (bot?.minConfidence ?? 0) === 0);
                      return (
                        <span key={i} onClick={() => setConf(i)} style={{ padding: "8px 16px", borderRadius: 9, cursor: "pointer", fontWeight: 600, fontSize: 12, background: active ? "#F0A94B" : "transparent", color: active ? "#14100D" : "#9A8B7A", border: `1px solid ${active ? "#F0A94B" : "#33291F"}` }}>
                          {lbl}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={card({ padding: "22px 24px" })}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>دستور نامي (استراتيجيتك المُلزِمة)</div>
                  <span className="mono" style={{ fontSize: 11, color: strategy.length > 4000 ? "#E0604A" : "#8A7862" }}>{strategy.length} / 4000</span>
                </div>
                <div style={{ fontSize: 11, color: "#8A7862", marginBottom: 12, lineHeight: 1.6 }}>
                  اكتب قواعدك وتجاربك — يلتزم بها نامي حرفياً في كل قرار. (أمثلة: «لا أشتري تحت مقاومة قريبة»، «اقطع الخسارة عند −1.2%»، «جنِ الربح عند +2%».)
                </div>
                <textarea
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value.slice(0, 4000))}
                  placeholder="اكتب دستور نامي هنا…"
                  style={{ width: "100%", height: 180, border: "1px solid #33291F", background: "#14100D", borderRadius: 12, padding: "13px 15px", fontSize: 12.5, lineHeight: 1.9, color: "#F2EADF", resize: "vertical", outline: "none", direction: "rtl" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                  <button
                    onClick={saveStrategy}
                    disabled={savingStrategy}
                    style={{ border: "none", background: "#F0A94B", color: "#14100D", fontWeight: 700, fontSize: 12.5, padding: "10px 20px", borderRadius: 10, cursor: "pointer", opacity: savingStrategy ? 0.6 : 1 }}
                  >
                    {savingStrategy ? "يحفظ…" : "💾 احفظ الدستور"}
                  </button>
                  {bot && strategy !== (bot.strategy ?? "") && (
                    <span style={{ fontSize: 11, color: "#E0604A" }}>تغييرات غير محفوظة</span>
                  )}
                </div>
              </div>

              <div style={{ background: "#1E1813", border: "1px solid rgba(224,96,74,.3)", borderRadius: 18, padding: "22px 24px" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#E0604A", marginBottom: 6 }}>منطقة الخطر</div>
                <div style={{ fontSize: 11.5, lineHeight: 1.7, color: "#B8A794", marginBottom: 16 }}>
                  تفويض مطلق: يتداول نامي بمال حقيقي وقد يبيع أي أصل في محفظتك عند حكم بيع مؤكّد. الخسارة واردة والمسؤولية عليك — وزرّ الإيقاف دائماً هنا.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button onClick={liquidate} style={{ border: "1px solid rgba(224,96,74,.4)", background: "rgba(224,96,74,.12)", color: "#E0604A", fontWeight: 600, fontSize: 12, padding: "10px 16px", borderRadius: 10, cursor: "pointer" }}>تصفية شاملة وبدء من جديد</button>
                  <button onClick={toggleBot} style={{ border: "none", background: "#E0604A", color: "#14100D", fontWeight: 700, fontSize: 12, padding: "10px 16px", borderRadius: 10, cursor: "pointer" }}>{running ? "⏸ إيقاف نامي فوراً" : "▶ تشغيل نامي"}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      {!wide && bottomNav}
    </div>
  );

  // بطاقة الشارت (مشتركة بين الرئيسية)
  function chartCard() {
    return (
      <div style={card({ padding: "20px 22px" })}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#F2EADF" }}>{COIN_SYMS[coin]}</span>
            <span className="mono" style={{ fontWeight: 600, fontSize: 22, color: "#F2EADF" }}>{coinPrice}</span>
            <span className="mono" style={{ fontWeight: 600, fontSize: 13, color: q && q.ch >= 0 ? "#5FCB95" : "#E0604A" }}>{q && q.ch >= 0 ? "▲ " : "▼ "}{coinChange}</span>
            {coinRsi != null && <span className="mono" style={{ fontWeight: 500, fontSize: 11, background: "rgba(240,169,75,.14)", color: "#F0A94B", padding: "3px 9px", borderRadius: 6 }}>RSI {coinRsi}</span>}
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            {COINS.map((c) => {
              const a = coin === c;
              return (
                <span key={c} onClick={() => setCoin(c)} style={{ padding: "5px 13px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "var(--font-mono-nums)", background: a ? "#F0A94B" : "transparent", color: a ? "#14100D" : "#9A8B7A", border: `1px solid ${a ? "#F0A94B" : "#33291F"}` }}>
                  {c}
                </span>
              );
            })}
          </div>
        </div>
        {(() => {
          const closes = kl.map((c) => c.c);
          const e9 = emaArr(closes, 9).map((v, i) => (v == null ? null : { x: chart.xOf(i), y: chart.y(v) }));
          const e21 = emaArr(closes, 21).map((v, i) => (v == null ? null : { x: chart.xOf(i), y: chart.y(v) }));
          const rsi = rsiArr(closes);
          const ry = (v: number) => 10 + (1 - v / 100) * 44;
          const rpts = rsi.map((v, i) => (v == null ? null : { x: chart.xOf(i), y: ry(v) }));
          const rNow = rsi[rsi.length - 1];
          const m = macdArr(closes);
          const mAll = [...m.macd, ...m.signal, ...m.hist].filter((x): x is number => x != null);
          const amp = Math.max(0.0001, ...mAll.map((x) => Math.abs(x)));
          const my = (v: number) => 32 - (v / amp) * 20;
          const mMacd = m.macd.map((v, i) => (v == null ? null : { x: chart.xOf(i), y: my(v) }));
          const mSig = m.signal.map((v, i) => (v == null ? null : { x: chart.xOf(i), y: my(v) }));
          const bw = kl.length ? Math.max(1, ((820 - 24) / kl.length) * 0.5) : 3;
          const lastX = chart.xOf(kl.length - 1);
          return (
            <>
              {/* لوحة السعر — شموع + EMA9/EMA21 + حجم + وقف/هدف */}
              <svg viewBox="0 0 820 240" style={{ width: "100%", display: "block" }}>
                {chart.vols.map((v, i) => (
                  <rect key={i} x={v.x} y={v.y} width={v.w} height={v.h} fill={v.up ? "#4CB782" : "#E0604A"} opacity="0.22" />
                ))}
                {posForCoin && chart.ok && (
                  <>
                    <line x1="0" y1={chart.y(posForCoin.target)} x2="820" y2={chart.y(posForCoin.target)} stroke="rgba(76,183,130,.35)" strokeWidth="1" strokeDasharray="5 4" />
                    <text x="6" y={chart.y(posForCoin.target) - 5} fill="#4CB782" fontSize="10.5" fontFamily="var(--font-mono-nums)">هدف {fmt(posForCoin.target, posForCoin.target < 1 ? 4 : 2)}</text>
                    <line x1="0" y1={chart.y(posForCoin.stopLoss)} x2="820" y2={chart.y(posForCoin.stopLoss)} stroke="rgba(224,96,74,.35)" strokeWidth="1" strokeDasharray="5 4" />
                    <text x="6" y={chart.y(posForCoin.stopLoss) + 13} fill="#E0604A" fontSize="10.5" fontFamily="var(--font-mono-nums)">وقف {fmt(posForCoin.stopLoss, posForCoin.stopLoss < 1 ? 4 : 2)}</text>
                  </>
                )}
                <path d={pathFrom(e21)} fill="none" stroke="#B49BE0" strokeWidth="1.6" opacity=".8" strokeLinejoin="round" />
                <path d={pathFrom(e9)} fill="none" stroke="#F0A94B" strokeWidth="1.6" strokeLinejoin="round" />
                {chart.candles.map((c, i) => (
                  <g key={i}>
                    <line x1={c.wx} y1={c.wy1} x2={c.wx} y2={c.wy2} stroke={c.color} strokeWidth="1.2" />
                    <rect x={c.x} y={c.by} width={c.bw} height={c.bh} rx="1" fill={c.color} />
                  </g>
                ))}
                {chart.ok && kl.length > 0 && (
                  <circle cx={lastX} cy={chart.y(closes[closes.length - 1])} r="3" fill="#F2EADF" />
                )}
              </svg>
              {/* لوحة RSI */}
              <svg viewBox="0 0 820 64" style={{ width: "100%", display: "block", marginTop: 4 }}>
                <rect x="0" y={ry(70)} width="820" height={ry(30) - ry(70)} fill="#8A7862" opacity="0.05" />
                <line x1="0" y1={ry(70)} x2="820" y2={ry(70)} stroke="#E0604A" strokeWidth="0.8" strokeDasharray="4 4" opacity=".4" />
                <line x1="0" y1={ry(50)} x2="820" y2={ry(50)} stroke="#33291F" strokeWidth="0.8" />
                <line x1="0" y1={ry(30)} x2="820" y2={ry(30)} stroke="#4CB782" strokeWidth="0.8" strokeDasharray="4 4" opacity=".4" />
                <text x="6" y="14" fill="#8A7862" fontSize="10" fontFamily="var(--font-mono-nums)">RSI</text>
                <path d={pathFrom(rpts)} fill="none" stroke="#56A9CE" strokeWidth="1.6" strokeLinejoin="round" />
                {rNow != null && <circle cx={lastX} cy={ry(rNow)} r="2.8" fill={rNow >= 70 ? "#E0604A" : rNow <= 30 ? "#4CB782" : "#56A9CE"} />}
              </svg>
              {/* لوحة MACD */}
              <svg viewBox="0 0 820 64" style={{ width: "100%", display: "block", marginTop: 4 }}>
                <line x1="0" y1="32" x2="820" y2="32" stroke="#33291F" strokeWidth="0.8" />
                <text x="6" y="14" fill="#8A7862" fontSize="10" fontFamily="var(--font-mono-nums)">MACD</text>
                {m.hist.map((h, i) =>
                  h == null ? null : (
                    <rect key={i} x={chart.xOf(i) - bw / 2} y={Math.min(my(h), 32)} width={bw} height={Math.max(0.6, Math.abs(my(h) - 32))} fill={h >= 0 ? "#4CB782" : "#E0604A"} opacity="0.55" />
                  )
                )}
                <path d={pathFrom(mSig)} fill="none" stroke="#F0A94B" strokeWidth="1.4" strokeLinejoin="round" />
                <path d={pathFrom(mMacd)} fill="none" stroke="#E6D8C6" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              {/* مفتاح المؤشرات */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8, fontSize: 10.5, color: "#8A7862" }}>
                <Legend color="#F0A94B" label="EMA 9" />
                <Legend color="#B49BE0" label="EMA 21" />
                <Legend color="#56A9CE" label="RSI 14" />
                <span>MACD 12/26/9</span>
              </div>
            </>
          );
        })()}
      </div>
    );
  }
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ display: "inline-block", width: 14, height: 3, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 7,
  border: "1px solid #33291F",
  background: "#14100D",
  borderRadius: 10,
  padding: "10px 13px",
  fontWeight: 600,
  fontSize: 14,
  color: "#F2EADF",
  outline: "none",
  direction: "ltr",
  textAlign: "right",
};

function fngLabel(fng: { value: number; label: string } | null): string {
  if (!fng) return "";
  if (fng.value < 25) return "خوف شديد";
  if (fng.value < 45) return "خوف";
  if (fng.value < 55) return "محايد";
  if (fng.value < 75) return "طمع";
  return "طمع شديد";
}
