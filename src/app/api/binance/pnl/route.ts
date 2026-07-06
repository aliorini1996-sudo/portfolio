import { NextResponse } from "next/server";
import { getAccountInfo, getAllPrices, isConfigured, BinanceError } from "@/lib/binance";
import { loadState, blobReady, riyadhDate, riyadhDateOf, netRealized } from "@/lib/autopilot";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

const STABLES = ["USDT", "USDC", "FDUSD", "BUSD"];

// GET /api/binance/pnl — ملخص الربح والخسارة: تغيّر 24 ساعة لكل عملة + مراكز البوت غير المحققة
export async function GET() {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isConfigured()) return NextResponse.json({ configured: false });

  try {
    const [acc, prices] = await Promise.all([getAccountInfo(), getAllPrices()]);

    // العملات المملوكة بقيمة معتبرة
    let stableUsdt = 0;
    const held: { asset: string; qty: number; valueUsdt: number }[] = [];
    for (const b of acc.balances) {
      const qty = b.free + b.locked;
      if (STABLES.includes(b.asset)) {
        stableUsdt += qty;
        continue;
      }
      const p = prices[`${b.asset}USDT`];
      if (p && qty * p >= 1) held.push({ asset: b.asset, qty, valueUsdt: qty * p });
    }

    // تغيّر 24 ساعة دفعة واحدة من الشبكة الحية (كما في marketAnalysis — أدق من التجريبية)
    const pct24h: Record<string, number> = {};
    if (held.length) {
      const symbols = held.map((h) => `${h.asset}USDT`);
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const rows = (await res.json()) as { symbol: string; priceChangePercent: string }[];
        for (const r of rows) pct24h[r.symbol] = parseFloat(r.priceChangePercent);
      }
    }

    const assets = held
      .map((h) => {
        const pct = pct24h[`${h.asset}USDT`] ?? null;
        // قيمة الأمس = القيمة الحالية ÷ (1 + نسبة التغير)
        const delta = pct != null ? h.valueUsdt - h.valueUsdt / (1 + pct / 100) : null;
        return {
          asset: h.asset,
          valueUsdt: +h.valueUsdt.toFixed(2),
          pct24h: pct != null ? +pct.toFixed(2) : null,
          delta24h: delta != null ? +delta.toFixed(2) : null,
        };
      })
      .sort((a, b) => b.valueUsdt - a.valueUsdt);

    const totalUsdt = stableUsdt + held.reduce((s, h) => s + h.valueUsdt, 0);
    const change24hUsdt = assets.reduce((s, a) => s + (a.delta24h ?? 0), 0);
    const yesterdayTotal = totalUsdt - change24hUsdt;

    // مراكز البوت المفتوحة: ربح/خسارة غير محققة مقابل سعر الدخول
    let botPositions: {
      symbol: string;
      qty: number;
      entry: number;
      current: number;
      plUsdt: number;
      plPct: number;
    }[] = [];
    // الربح المحقق اليومي (بتوقيت الرياض) + تاريخ الأيام السابقة + الشهري + متوسط زمن الصفقة
    let todayRealized = 0;
    let todayClosed = 0;
    let monthRealized = 0;
    let avgHoldMin = 0;
    let dailyHistory: { date: string; realizedUsdt: number; closedCount: number; note: string }[] = [];
    if (blobReady()) {
      try {
        const st = await loadState();
        botPositions = st.positions.map((p) => {
          const current = prices[p.symbol] ?? p.entry;
          // ربح/خسارة غير محقق صافياً — كأنك أغلقت الآن بعد رسوم الشراء والبيع
          const r = netRealized(p.entry, current, p.qty);
          return {
            symbol: p.symbol,
            qty: p.qty,
            entry: p.entry,
            current,
            plUsdt: r.pnlUsdt,
            plPct: r.pnlPct,
          };
        });
        const today = riyadhDate();
        const todays = (st.trades || []).filter(
          (t) => t.pnlUsdt != null && riyadhDateOf(t.closedAt) === today
        );
        todayRealized = +todays.reduce((a, t) => a + (t.pnlUsdt || 0), 0).toFixed(2);
        todayClosed = todays.length;
        // الربح المحقق للشهر الحالي: أيام سابقة من السجلّ + اليوم (بلا تكرار)
        const ym = today.slice(0, 7); // YYYY-MM (رياض)
        const monthHist = (st.dailyHistory || [])
          .filter((d) => d.date.startsWith(ym) && d.date !== today)
          .reduce((a, d) => a + (d.realizedUsdt || 0), 0);
        monthRealized = +(monthHist + todayRealized).toFixed(2);
        // متوسط زمن الصفقة (دقائق) من الصفقات معروفة الدخول والخروج
        const durs = (st.trades || [])
          .filter((t) => t.openedAt && t.closedAt)
          .map((t) => (new Date(t.closedAt).getTime() - new Date(t.openedAt as string).getTime()) / 60000)
          .filter((m) => m > 0 && m < 60 * 24 * 30);
        avgHoldMin = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
        dailyHistory = (st.dailyHistory || [])
          .filter((d) => d.date !== today)
          .slice(-7)
          .reverse()
          .map((d) => ({
            date: d.date,
            realizedUsdt: d.realizedUsdt,
            closedCount: d.closedCount,
            note: d.note,
          }));
      } catch {
        /* غياب حالة البوت لا يمنع الملخص */
      }
    }
    const botUnrealized = +botPositions.reduce((s, p) => s + p.plUsdt, 0).toFixed(2);

    return NextResponse.json({
      configured: true,
      totalUsdt: +totalUsdt.toFixed(2),
      stableUsdt: +stableUsdt.toFixed(2),
      change24h: {
        usdt: +change24hUsdt.toFixed(2),
        pct: yesterdayTotal > 0 ? +((change24hUsdt / yesterdayTotal) * 100).toFixed(2) : 0,
      },
      assets,
      bot: { positions: botPositions, unrealizedUsdt: botUnrealized },
      daily: { todayRealized, todayClosed, monthRealized, avgHoldMin, history: dailyHistory },
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ configured: true, error: err.message }, { status: 502 });
  }
}
