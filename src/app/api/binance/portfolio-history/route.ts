import { NextRequest, NextResponse } from "next/server";
import { getAccountInfo, getAllPrices, isConfigured, BinanceError } from "@/lib/binance";
import { klines } from "@/lib/marketAnalysis";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 30;

const STABLES = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI"];

// نطاق زمني → إطار الشمعة وعددها (يوم واحد = 5د×288، إلخ)
const RANGES: Record<string, { interval: string; limit: number }> = {
  "1d": { interval: "5m", limit: 288 },
  "5d": { interval: "30m", limit: 240 },
  "1m": { interval: "2h", limit: 360 },
  "6m": { interval: "12h", limit: 360 },
  "1y": { interval: "1d", limit: 365 },
  max: { interval: "1w", limit: 300 },
};

// GET /api/binance/portfolio-history?range=1d
// يعيد سلسلة زمنية لقيمة المحفظة = Σ(الكمية الحالية × سعر الأصل عند كل لحظة) + المستقرّ.
// أي «كم كانت تساوي حيازاتك الحالية عبر الزمن» — تماماً كرسم القيمة في منصّات الأسهم.
export async function GET(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isConfigured()) return NextResponse.json({ configured: false });

  const range = new URL(req.url).searchParams.get("range") || "1d";
  const cfg = RANGES[range] || RANGES["1d"];

  try {
    const [acc, prices] = await Promise.all([getAccountInfo(), getAllPrices()]);

    // المستقرّ ثابت في المنحنى؛ الأصول غير المستقرّة تُقيَّم تاريخياً
    let stableBase = 0;
    const held: { symbol: string; qty: number; valueNow: number }[] = [];
    for (const b of acc.balances) {
      const qty = b.free + b.locked;
      if (qty <= 0) continue;
      if (STABLES.includes(b.asset)) {
        stableBase += qty;
        continue;
      }
      const price = prices[`${b.asset}USDT`];
      if (!price) continue;
      const valueNow = qty * price;
      if (valueNow < 1) continue;
      held.push({ symbol: `${b.asset}USDT`, qty, valueNow });
    }

    // خذ حتى 10 أصول الأعلى قيمةً (بقيّتها تُضاف كثابت حالي — تبقي مستوى المنحنى صحيحاً)
    held.sort((a, b) => b.valueNow - a.valueNow);
    const top = held.slice(0, 10);
    for (const r of held.slice(10)) stableBase += r.valueNow;

    // اجلب تاريخ كل أصل بالتوازي؛ ما يتعذّر تاريخه يُضاف كثابت حالي
    const series: { qty: number; candles: { t: number; c: number }[] }[] = [];
    await Promise.all(
      top.map(async (a) => {
        try {
          const c = await klines(a.symbol, cfg.interval, cfg.limit);
          if (c.length) series.push({ qty: a.qty, candles: c.map((k) => ({ t: k.t, c: k.c })) });
          else stableBase += a.valueNow;
        } catch {
          stableBase += a.valueNow;
        }
      })
    );

    stableBase = +stableBase.toFixed(2);

    if (!series.length) {
      // لا أصول ذات تاريخ متاح — لا منحنى (المستقرّ فقط)
      return NextResponse.json({ configured: true, range, points: [], stableBase });
    }

    // محور الزمن = السلسلة الأطول (أكثر شموعاً)؛ لكل أصل خريطة لحظة→سعر
    const axisCandles = series.reduce((a, b) => (b.candles.length > a.candles.length ? b : a)).candles;
    const axis = axisCandles.map((k) => k.t);
    const maps = series.map((s) => {
      const m = new Map<number, number>();
      for (const k of s.candles) m.set(k.t, k.c);
      return { qty: s.qty, m, candles: s.candles };
    });

    const points = axis.map((t, i) => {
      let v = stableBase;
      for (const a of maps) {
        // سعر الأصل عند هذه اللحظة، وإلا أقرب شمعة متاحة (محاذاة الأطر المختلفة)
        const c = a.m.get(t) ?? a.candles[Math.min(i, a.candles.length - 1)]?.c ?? 0;
        v += a.qty * c;
      }
      return { t, v: +v.toFixed(2) };
    });

    return NextResponse.json({ configured: true, range, interval: cfg.interval, stableBase, points });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ configured: true, error: err.message }, { status: 502 });
  }
}
