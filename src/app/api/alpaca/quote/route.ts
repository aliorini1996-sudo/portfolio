import { NextResponse } from "next/server";
import { getUsAsset, getUsSnapshot, isAlpacaConfigured, AlpacaError } from "@/lib/alpaca";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/alpaca/quote?symbol=AAPL — سعر لحظي + معلومات السهم
export async function GET(req: Request) {
  const denied = await requirePin();
  if (denied) return denied;
  const symbol = (new URL(req.url).searchParams.get("symbol") || "").trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "حدّد رمز السهم" }, { status: 400 });
  if (!isAlpacaConfigured())
    return NextResponse.json({ error: "حساب Alpaca غير مربوط" }, { status: 400 });
  try {
    const [asset, snap] = await Promise.all([getUsAsset(symbol), getUsSnapshot(symbol)]);
    return NextResponse.json({
      symbol: asset.symbol,
      name: asset.name,
      exchange: asset.exchange,
      tradable: asset.tradable,
      fractionable: asset.fractionable,
      price: snap.price,
      changePercent: snap.changePercent,
      high: snap.high,
      low: snap.low,
    });
  } catch (e) {
    const err = e as AlpacaError;
    const msg = err.status === 404 ? `الرمز ${symbol} غير موجود` : err.message;
    return NextResponse.json({ error: msg }, { status: err.status === 404 ? 404 : 502 });
  }
}
