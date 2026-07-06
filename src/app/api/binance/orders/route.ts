import { NextRequest, NextResponse } from "next/server";
import { getOpenOrders, isConfigured, BinanceError } from "@/lib/binance";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

// GET /api/binance/orders — الأوامر المعلّقة
export async function GET(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isConfigured()) return NextResponse.json({ configured: false, orders: [] });
  const symbol = req.nextUrl.searchParams.get("symbol") || undefined;
  try {
    const orders = await getOpenOrders(symbol?.toUpperCase());
    return NextResponse.json({ configured: true, orders });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ configured: true, error: err.message, orders: [] }, { status: 502 });
  }
}
