import { NextResponse } from "next/server";
import {
  getUsAccount,
  getUsPositions,
  getUsClock,
  isAlpacaConfigured,
  alpacaConfig,
  AlpacaError,
} from "@/lib/alpaca";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/alpaca/account — الحساب + المراكز + حالة السوق
export async function GET() {
  const denied = await requirePin();
  if (denied) return denied;
  const { paper } = alpacaConfig();
  if (!isAlpacaConfigured()) {
    return NextResponse.json({
      configured: false,
      paper,
      message: "لم يُربط حساب Alpaca بعد. أضف ALPACA_API_KEY و ALPACA_API_SECRET في إعدادات الخادم.",
    });
  }
  try {
    const [account, positions, clock] = await Promise.all([
      getUsAccount(),
      getUsPositions(),
      getUsClock(),
    ]);
    return NextResponse.json({ configured: true, paper, account, positions, clock });
  } catch (e) {
    const err = e as AlpacaError;
    return NextResponse.json(
      { configured: true, paper, error: err.message, status: err.status },
      { status: 502 }
    );
  }
}
