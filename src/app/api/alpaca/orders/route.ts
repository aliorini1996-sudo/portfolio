import { NextResponse } from "next/server";
import { getUsOpenOrders, isAlpacaConfigured, AlpacaError } from "@/lib/alpaca";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/alpaca/orders — الأوامر المعلّقة
export async function GET() {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isAlpacaConfigured()) return NextResponse.json({ orders: [] });
  try {
    return NextResponse.json({ orders: await getUsOpenOrders() });
  } catch (e) {
    return NextResponse.json({ orders: [], error: (e as AlpacaError).message }, { status: 502 });
  }
}
