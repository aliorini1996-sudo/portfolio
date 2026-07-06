import { NextResponse } from "next/server";
import { placeUsOrder, cancelUsOrder, isAlpacaConfigured, AlpacaError } from "@/lib/alpaca";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

// POST /api/alpaca/order — تنفيذ أمر (سوق/محدّد، شراء/بيع)
export async function POST(req: Request) {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isAlpacaConfigured())
    return NextResponse.json({ ok: false, error: "حساب Alpaca غير مربوط" }, { status: 400 });
  try {
    const b = (await req.json()) as {
      symbol?: string;
      side?: string;
      type?: string;
      qty?: number;
      notional?: number;
      price?: number;
    };
    const symbol = (b.symbol || "").trim().toUpperCase();
    const side = b.side === "SELL" ? "sell" : b.side === "BUY" ? "buy" : null;
    const type = b.type === "LIMIT" ? "limit" : b.type === "MARKET" ? "market" : null;
    if (!symbol || !side || !type)
      return NextResponse.json({ ok: false, error: "أمر ناقص البيانات" }, { status: 400 });

    if (type === "market" && side === "buy") {
      if (!(Number(b.notional) >= 1))
        return NextResponse.json({ ok: false, error: "أدنى مبلغ للشراء 1 دولار" }, { status: 400 });
    } else if (!(Number(b.qty) > 0)) {
      return NextResponse.json({ ok: false, error: "أدخل كمية صحيحة" }, { status: 400 });
    }
    if (type === "limit" && !(Number(b.price) > 0))
      return NextResponse.json({ ok: false, error: "أدخل سعراً صحيحاً" }, { status: 400 });

    const o = await placeUsOrder({
      symbol,
      side,
      type,
      qty: b.qty,
      notional: type === "market" && side === "buy" ? Number(b.notional) : undefined,
      limitPrice: b.price,
    });
    return NextResponse.json({
      ok: true,
      order: {
        id: o.id,
        status: o.status,
        symbol: o.symbol,
        filledQty: o.filled_qty,
        filledAvgPrice: o.filled_avg_price,
      },
    });
  } catch (e) {
    const err = e as AlpacaError;
    return NextResponse.json({ ok: false, error: err.message }, { status: 502 });
  }
}

// DELETE /api/alpaca/order?id=… — إلغاء أمر معلّق
export async function DELETE(req: Request) {
  const denied = await requirePin();
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, error: "حدّد رقم الأمر" }, { status: 400 });
  try {
    await cancelUsOrder(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as AlpacaError).message }, { status: 502 });
  }
}
