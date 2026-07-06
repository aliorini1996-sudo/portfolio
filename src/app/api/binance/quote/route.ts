import { NextRequest, NextResponse } from "next/server";
import { getSymbolInfo, getTicker24h, roundStep, BinanceError } from "@/lib/binance";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

// GET /api/binance/quote?symbol=BTCUSDT — سعر حي + معلومات الزوج لمراجعة الأمر
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol مطلوب" }, { status: 400 });
  try {
    const [info, t] = await Promise.all([getSymbolInfo(symbol), getTicker24h(symbol)]);
    const price = parseFloat(t.lastPrice);
    return NextResponse.json({
      symbol: info.symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      price,
      changePercent: parseFloat(t.priceChangePercent),
      high: parseFloat(t.highPrice),
      low: parseFloat(t.lowPrice),
      volume: parseFloat(t.quoteVolume),
      stepSize: info.stepSize,
      tickSize: info.tickSize,
      minNotional: info.minNotional,
      // كمية مقترحة مقرّبة عند سعر السوق لأدنى قيمة أمر
      pricePreview: roundStep(price, info.tickSize),
    });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ error: err.message, code: err.code }, { status: 502 });
  }
}
