import { NextRequest, NextResponse } from "next/server";
import { klines } from "@/lib/marketAnalysis";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

const ALLOWED = new Set(["5m", "15m", "30m", "1h", "4h", "1d", "1w"]);

// GET /api/binance/klines?symbol=BTCUSDT&interval=1h&limit=168 — شموع للرسم البياني (بيانات عامة)
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const symbol = (p.get("symbol") || "").toUpperCase();
  const interval = p.get("interval") || "1h";
  const limit = Math.min(500, Math.max(10, Number(p.get("limit")) || 168));

  if (!symbol) return NextResponse.json({ error: "symbol مطلوب" }, { status: 400 });
  if (!ALLOWED.has(interval)) return NextResponse.json({ error: "interval غير مدعوم" }, { status: 400 });

  try {
    const candles = await klines(symbol, interval, limit);
    return NextResponse.json({ symbol, interval, candles });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message) }, { status: 502 });
  }
}
