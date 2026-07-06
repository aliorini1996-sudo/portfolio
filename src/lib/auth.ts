// حماية الوصول برمز PIN — يُضبط عبر APP_PIN في بيئة الخادم
// بلا APP_PIN: التطبيق مفتوح (وضع التطوير/قبل الإعداد)
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const PIN_COOKIE = "pf_pin";

export async function pinOk(): Promise<boolean> {
  const pin = process.env.APP_PIN;
  if (!pin) return true;
  const c = (await cookies()).get(PIN_COOKIE)?.value;
  return c === pin;
}

// يعيد استجابة 401 عند الرفض، أو null عند السماح
export async function requirePin(): Promise<NextResponse | null> {
  if (await pinOk()) return null;
  return NextResponse.json({ error: "أدخل رمز الدخول", locked: true }, { status: 401 });
}
