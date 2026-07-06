import { NextRequest, NextResponse } from "next/server";
import {
  placeOrder,
  cancelOrder,
  getSymbolInfo,
  roundStep,
  isConfigured,
  BinanceError,
} from "@/lib/binance";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

// POST /api/binance/order — تنفيذ أمر شراء/بيع (بعد تأكيد المستخدم في الواجهة)
export async function POST(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({ error: "حساب Binance غير مربوط" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol || "").toUpperCase();
  const side = body.side as "BUY" | "SELL";
  const type = body.type as "MARKET" | "LIMIT";

  if (!symbol || (side !== "BUY" && side !== "SELL") || (type !== "MARKET" && type !== "LIMIT")) {
    return NextResponse.json({ error: "معطيات الأمر ناقصة أو غير صحيحة" }, { status: 400 });
  }

  try {
    const info = await getSymbolInfo(symbol);

    if (type === "MARKET") {
      // شراء بالسوق بمبلغ التسعير (USDT)، بيع بالسوق بكمية العملة
      if (side === "BUY") {
        const quoteOrderQty = Number(body.quoteOrderQty);
        if (!(quoteOrderQty > 0)) return NextResponse.json({ error: "أدخل مبلغ الشراء" }, { status: 400 });
        const order = await placeOrder({ symbol, side, type, quoteOrderQty });
        return NextResponse.json({ ok: true, order });
      } else {
        const quantity = roundStep(Number(body.quantity), info.stepSize);
        if (!(quantity > 0)) return NextResponse.json({ error: "أدخل كمية البيع" }, { status: 400 });
        const order = await placeOrder({ symbol, side, type, quantity });
        return NextResponse.json({ ok: true, order });
      }
    } else {
      // أمر محدّد السعر
      const quantity = roundStep(Number(body.quantity), info.stepSize);
      const price = roundStep(Number(body.price), info.tickSize);
      if (!(quantity > 0) || !(price > 0))
        return NextResponse.json({ error: "أدخل الكمية والسعر" }, { status: 400 });
      if (info.minNotional && quantity * price < info.minNotional)
        return NextResponse.json(
          { error: `قيمة الأمر أقل من الحد الأدنى (${info.minNotional} ${info.quoteAsset})` },
          { status: 400 }
        );
      const order = await placeOrder({ symbol, side, type, quantity, price });
      return NextResponse.json({ ok: true, order });
    }
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ error: err.message, code: err.code }, { status: 502 });
  }
}

// DELETE /api/binance/order?symbol=BTCUSDT&orderId=123 — إلغاء أمر معلّق
export async function DELETE(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;
  const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  const orderId = Number(req.nextUrl.searchParams.get("orderId"));
  if (!symbol || !orderId) return NextResponse.json({ error: "معطيات ناقصة" }, { status: 400 });
  try {
    const res = await cancelOrder(symbol, orderId);
    return NextResponse.json({ ok: true, res });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ error: err.message, code: err.code }, { status: 502 });
  }
}
