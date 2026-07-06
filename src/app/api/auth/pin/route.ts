import { NextRequest, NextResponse } from "next/server";
import { pinOk, PIN_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// GET — حالة القفل (هل PIN مطلوب؟ وهل الجلسة الحالية مسموحة؟)
export async function GET() {
  return NextResponse.json({
    required: Boolean(process.env.APP_PIN),
    ok: await pinOk(),
  });
}

// POST { pin } — الدخول: يضبط كوكي آمنة لثلاثين يوماً
export async function POST(req: NextRequest) {
  const appPin = process.env.APP_PIN;
  if (!appPin) return NextResponse.json({ ok: true, note: "لا يوجد قفل مضبوط" });

  const body = await req.json().catch(() => ({}));
  const pin = String(body.pin || "");
  if (pin !== appPin) {
    return NextResponse.json({ ok: false, error: "رمز غير صحيح" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(PIN_COOKIE, pin, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
