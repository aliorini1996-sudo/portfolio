// بناء تحليل فني متعدد الأُطر لزوج Binance — مشترك بين مسار التحليل والدردشة
import { getSymbolInfo, getAccountInfo, isConfigured } from "@/lib/binance";
import {
  summarize,
  bollinger,
  atr,
  supportResistance,
  changePct,
  macdCross,
  Candle,
} from "@/lib/indicators";

// بيانات السوق دائماً من الشبكة الحيّة العامة (أغنى وأدق من التجريبية)
export async function klines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`klines ${interval}: HTTP ${res.status}`);
  const rows = (await res.json()) as (string | number)[][];
  return rows.map((r) => ({
    t: Number(r[0]),
    o: parseFloat(String(r[1])),
    h: parseFloat(String(r[2])),
    l: parseFloat(String(r[3])),
    c: parseFloat(String(r[4])),
    v: parseFloat(String(r[5])),
  }));
}

// ملخّص فني لإطار زمني واحد
export function frame(candles: Candle[]) {
  const closes = candles.map((c) => c.c);
  const s = summarize(closes);
  const bb = bollinger(closes);
  return {
    rsi14: s?.rsi14 != null ? +s.rsi14.toFixed(1) : null,
    macdHist: s?.macdHist != null ? +s.macdHist.toFixed(4) : null,
    macdCross: macdCross(closes),
    sma50: s?.sma50 != null ? +s.sma50.toFixed(4) : null,
    sma200: s?.sma200 != null ? +s.sma200.toFixed(4) : null,
    trend: s?.trend ?? "sideways",
    score: s?.score ?? 0,
    signals: (s?.signals ?? []).map((x) => x.label),
    bbPercentB: bb ? +bb.percentB.toFixed(2) : null,
    atr14: atr(candles),
  };
}

export interface MarketAnalysis {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  changes: { h24: number | null; d7: number | null; d30: number | null };
  frames: { h1: ReturnType<typeof frame>; h4: ReturnType<typeof frame>; d1: ReturnType<typeof frame> };
  levels: { support: number | null; resistance: number | null; atrDaily: number | null };
  position: { baseQty: number; baseValueUsdt: number; quoteFree: number } | null;
  rule: { signal: string; score: number };
}

// scalp=true يستخدم أُطراً قصيرة (5د/15د/ساعة) للمضاربة السريعة بدل (ساعة/4س/يومي)
export async function buildAnalysis(symbol: string, opts?: { scalp?: boolean }): Promise<MarketAnalysis> {
  const [i1, i2, i3] = opts?.scalp ? ["5m", "15m", "1h"] : ["1h", "4h", "1d"];
  const [info, h1, h4, d1] = await Promise.all([
    getSymbolInfo(symbol),
    klines(symbol, i1, 250),
    klines(symbol, i2, 250),
    klines(symbol, i3, 250),
  ]);

  const price = h1[h1.length - 1].c; // أحدث سعر من أقصر إطار
  const frames = { h1: frame(h1), h4: frame(h4), d1: frame(d1) };
  const sr = supportResistance(d1, 30);
  const closesH1 = h1.map((c) => c.c);
  const closesD1 = d1.map((c) => c.c);

  // مركز المستخدم الحالي في هذا الأصل (سياق للتوصية)
  let position: MarketAnalysis["position"] = null;
  if (isConfigured()) {
    try {
      const acc = await getAccountInfo();
      const base = acc.balances.find((b) => b.asset === info.baseAsset);
      const quote = acc.balances.find((b) => b.asset === info.quoteAsset);
      const baseQty = base ? base.free + base.locked : 0;
      position = {
        baseQty,
        baseValueUsdt: +(baseQty * price).toFixed(2),
        quoteFree: quote ? +quote.free.toFixed(2) : 0,
      };
    } catch {
      /* الحساب غير متاح لا يمنع التحليل */
    }
  }

  // إشارة قواعدية مرجّحة (اليومي أثقل)
  const weighted = (frames.d1.score * 1.5 + frames.h4.score * 1.25 + frames.h1.score) / 3.75;

  return {
    symbol,
    baseAsset: info.baseAsset,
    quoteAsset: info.quoteAsset,
    price,
    changes: {
      h24: changePct(closesH1, 24),
      d7: changePct(closesD1, 7),
      d30: changePct(closesD1, 30),
    },
    frames,
    levels: { support: sr.support, resistance: sr.resistance, atrDaily: frames.d1.atr14 },
    position,
    rule: {
      signal: weighted >= 25 ? "BUY" : weighted <= -25 ? "SELL" : "HOLD",
      score: Math.round(weighted),
    },
  };
}

// نظرة عامة على السوق: أهم العملات وتغيّراتها
const OVERVIEW_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "LINKUSDT",
];

// كون التداول الكامل: مرشّحون من كل سوق USDT — أكثر العملات حركةً بسيولة كافية
// (يمنح البوت وصولاً لكل العملات دون تحليل 400 عملة كل دورة — يختار الأجدر)
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/; // استبعاد الرموز ذات الرافعة
const STABLE_BASES = new Set(["USDC", "FDUSD", "TUSD", "DAI", "BUSD", "USDP", "EURI", "AEUR"]);

export async function marketUniverse(
  limit = 12,
  minQuoteVolume = 10_000_000 // ≥10M USDT حجم 24س — سيولة تحمي من التلاعب والعملات الميتة
): Promise<string[]> {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-store" });
  if (!res.ok) throw new Error(`universe: HTTP ${res.status}`);
  const rows = (await res.json()) as {
    symbol: string;
    priceChangePercent: string;
    quoteVolume: string;
  }[];
  return rows
    .filter((r) => {
      if (!r.symbol.endsWith("USDT")) return false;
      if (LEVERAGED.test(r.symbol)) return false;
      const base = r.symbol.slice(0, -4);
      if (STABLE_BASES.has(base)) return false;
      return parseFloat(r.quoteVolume) >= minQuoteVolume;
    })
    // الأكثر حركةً (صعوداً أو هبوطاً) بين العملات السائلة = أخصب الفرص
    .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)))
    .slice(0, limit)
    .map((r) => r.symbol);
}

export async function marketOverview() {
  const qs = encodeURIComponent(JSON.stringify(OVERVIEW_SYMBOLS));
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${qs}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`overview: HTTP ${res.status}`);
  const rows = (await res.json()) as {
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    quoteVolume: string;
  }[];
  return rows.map((r) => ({
    symbol: r.symbol,
    price: parseFloat(r.lastPrice),
    changePct24h: parseFloat(r.priceChangePercent),
    high24h: parseFloat(r.highPrice),
    low24h: parseFloat(r.lowPrice),
    volumeUsdt: Math.round(parseFloat(r.quoteVolume)),
  }));
}
