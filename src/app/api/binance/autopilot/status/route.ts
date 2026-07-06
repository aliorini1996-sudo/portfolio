import { NextResponse } from "next/server";
import { requirePin } from "@/lib/auth";
import { loadState, blobReady } from "@/lib/autopilot";

export const runtime = "nodejs";
export const preferredRegion = "fra1";

// GET — حالة المضاربة الآلية كاملة للوحة التحكم
export async function GET() {
  const denied = await requirePin();
  if (denied) return denied;

  if (!blobReady()) {
    return NextResponse.json({
      blobReady: false,
      message:
        "تخزين حالة البوت غير مجهّز. من Vercel: مشروع stock-portfolio ← Storage ← Create Database ← Blob ← اربطه بالمشروع ثم أعد النشر.",
    });
  }
  try {
    const state = await loadState();
    return NextResponse.json({
      blobReady: true,
      aiReady: Boolean(process.env.ANTHROPIC_API_KEY),
      state: {
        ...state,
        log: state.log.slice(-30).reverse(),
        trades: (state.trades || []).slice(-20).reverse(),
      },
    });
  } catch (e) {
    return NextResponse.json({ blobReady: true, error: String((e as Error).message) }, { status: 502 });
  }
}
