import { NextRequest, NextResponse } from "next/server";
import { pinOk } from "@/lib/auth";
import { runTick, blobReady } from "@/lib/autopilot";

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 300; // تحليل عدة عملات + أحكام Claude

async function tick() {
  if (!blobReady()) {
    return NextResponse.json(
      { error: "تخزين Blob غير مجهّز — من Vercel: Storage ← Create ← Blob ثم أعد النشر" },
      { status: 503 }
    );
  }
  try {
    return NextResponse.json(await runTick());
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 });
  }
}

// GET — نبضة Vercel Cron المُدارة (تُرسل Authorization: Bearer <CRON_SECRET> تلقائياً كل 15 دقيقة)
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return tick();
}

// POST — نبضة يدوية/احتياطية: زر «دورة الآن» (جلسة PIN) أو نبض GitHub (بسرّ x-autopilot-secret)
export async function POST(req: NextRequest) {
  const secret = process.env.AUTOPILOT_SECRET;
  const header = req.headers.get("x-autopilot-secret");
  const bySecret = Boolean(secret && header && header === secret);
  const byPin = await pinOk();

  if (!bySecret && !byPin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return tick();
}
