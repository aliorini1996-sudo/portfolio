import { NextRequest, NextResponse } from "next/server";
import { pinOk } from "@/lib/auth";
import { runDailyClose, blobReady } from "@/lib/autopilot";

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 120; // إغلاق عدة مراكز + استخلاص دروس AI

// الإقفال اليومي 23:00 السعودية (20:00 UTC): يقفل المراكز، يستخلص دروس اليوم، يبدأ نظيفاً
async function run() {
  if (!blobReady()) return NextResponse.json({ error: "تخزين Blob غير مجهّز" }, { status: 503 });
  try {
    return NextResponse.json(await runDailyClose());
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 });
  }
}

// GET — نبضة Vercel Cron المُدارة (Authorization: Bearer <CRON_SECRET>)
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return run();
}

// POST — تشغيل يدوي: سرّ x-autopilot-secret أو جلسة PIN
export async function POST(req: NextRequest) {
  const secret = process.env.AUTOPILOT_SECRET;
  const header = req.headers.get("x-autopilot-secret");
  const bySecret = Boolean(secret && header && header === secret);
  const byPin = await pinOk();
  if (!bySecret && !byPin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return run();
}
