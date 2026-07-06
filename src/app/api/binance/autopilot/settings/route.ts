import { NextRequest, NextResponse } from "next/server";
import { requirePin } from "@/lib/auth";
import { loadState, saveSettings, blobReady } from "@/lib/autopilot";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

// POST — تحديث إعدادات المضاربة الآلية (التشغيل/الإيقاف من هنا أيضاً)
export async function POST(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;

  if (!blobReady()) {
    return NextResponse.json({ error: "تخزين Blob غير مجهّز — أنشئه من Vercel أولاً" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const s = await loadState();

  if (typeof body.enabled === "boolean") {
    s.enabled = body.enabled;
  }
  // 0 = بلا حد — تحكّم كامل للمستخدم بلا سقوف مفروضة
  if (body.perTradeUsdt != null) {
    const v = Number(body.perTradeUsdt);
    if (v === 0 || v >= 10) s.perTradeUsdt = v;
  }
  if (body.dailyCapUsdt != null) {
    const v = Number(body.dailyCapUsdt);
    if (v === 0 || v >= 10) s.dailyCapUsdt = v;
  }
  if (body.minConfidence != null) {
    const v = Number(body.minConfidence);
    if (v >= 0 && v <= 100) s.minConfidence = v;
  }
  if (typeof body.strategy === "string") {
    s.strategy = body.strategy.trim().slice(0, 4000);
  }
  if (body.screenMode === "rule" || body.screenMode === "always") {
    s.screenMode = body.screenMode;
  }
  if (typeof body.tradeAllMarket === "boolean") {
    s.tradeAllMarket = body.tradeAllMarket;
  }
  if (body.maxScan != null) {
    const v = Math.round(Number(body.maxScan));
    if (v >= 4 && v <= 30) s.maxScan = v; // حدّ معقول للتكلفة/الوقت (maxDuration=300)
  }
  if (Array.isArray(body.symbols)) {
    const clean = body.symbols
      .map((x: unknown) => String(x).toUpperCase().trim())
      .filter((x: string) => /^[A-Z0-9]{2,10}USDT$/.test(x))
      .slice(0, 8);
    if (clean.length) s.symbols = clean;
  }

  await saveSettings(s);
  return NextResponse.json({
    ok: true,
    state: {
      ...s,
      log: s.log.slice(-30).reverse(),
      trades: (s.trades || []).slice(-20).reverse(),
    },
  });
}
