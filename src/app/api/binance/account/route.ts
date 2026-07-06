import { NextResponse } from "next/server";
import {
  getAccountInfo,
  getAllPrices,
  getApiRestrictions,
  isConfigured,
  binanceConfig,
  BinanceError,
} from "@/lib/binance";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1"; // فرانكفورت — عادةً مسموح لـBinance

// GET /api/binance/account — الأرصدة الحقيقية + قيمتها بالدولار
export async function GET() {
  const denied = await requirePin();
  if (denied) return denied;
  const { testnet } = binanceConfig();
  if (!isConfigured()) {
    return NextResponse.json({
      configured: false,
      testnet,
      message: "لم يُربط حساب Binance بعد. أضف BINANCE_API_KEY و BINANCE_API_SECRET في إعدادات الخادم.",
    });
  }
  try {
    const [info, prices, restrictions] = await Promise.all([
      getAccountInfo(),
      getAllPrices(),
      getApiRestrictions(),
    ]);
    const { balances } = info;
    const enriched = balances.map((b) => {
      const total = b.free + b.locked;
      let usdt = 0;
      if (b.asset === "USDT" || b.asset === "BUSD" || b.asset === "FDUSD" || b.asset === "USDC") {
        usdt = total;
      } else {
        const p = prices[`${b.asset}USDT`];
        usdt = p ? total * p : 0;
      }
      return { ...b, total, usdt };
    });
    enriched.sort((a, b) => b.usdt - a.usdt);
    const totalUsdt = enriched.reduce((s, b) => s + b.usdt, 0);
    return NextResponse.json({
      configured: true,
      testnet,
      balances: enriched,
      totalUsdt,
      canTrade: info.canTrade,
      accountType: info.accountType,
      keyPermissions: restrictions, // صلاحيات المفتاح الفعلية (أو null)
    });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json(
      { configured: true, testnet, error: err.message, code: err.code, status: err.status },
      { status: 502 }
    );
  }
}
