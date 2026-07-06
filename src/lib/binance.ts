// محرّك Binance — يعمل في الخادم فقط (المفتاح السرّي لا يغادر الخادم إطلاقاً)
// التوقيع HMAC-SHA256 حسب توثيق Binance الرسمي
import crypto from "crypto";

const LIVE = "https://api.binance.com";
const TESTNET = "https://testnet.binance.vision";

export function binanceConfig() {
  const apiKey = process.env.BINANCE_API_KEY || "";
  const apiSecret = process.env.BINANCE_API_SECRET || "";
  const testnet = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true";
  return { apiKey, apiSecret, testnet, base: testnet ? TESTNET : LIVE };
}

export function isConfigured() {
  const { apiKey, apiSecret } = binanceConfig();
  return Boolean(apiKey && apiSecret);
}

const UA = "field-sales-portfolio/1.0";

// طلب عام (بلا توقيع) — للأسعار ومعلومات الأزواج
async function publicGet(path: string, params: Record<string, string | number> = {}) {
  const { base } = binanceConfig();
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new BinanceError(res.status, text);
  return JSON.parse(text);
}

// طلب موقّع — للحساب والأوامر
async function signedRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number> = {}
) {
  const { base, apiKey, apiSecret } = binanceConfig();
  if (!apiKey || !apiSecret) throw new BinanceError(0, "لم يُضبط مفتاح Binance في الخادم");

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) query[k] = String(v);
  query.timestamp = String(Date.now());
  query.recvWindow = "5000";

  const qs = new URLSearchParams(query).toString();
  const signature = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
  const url = `${base}${path}?${qs}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey, "User-Agent": UA },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new BinanceError(res.status, text);
  return JSON.parse(text);
}

export class BinanceError extends Error {
  status: number;
  code?: number;
  constructor(status: number, raw: string) {
    let msg = raw;
    let code: number | undefined;
    try {
      const j = JSON.parse(raw);
      msg = j.msg || raw;
      code = j.code;
    } catch {
      // قد تُرجع Binance HTML عند الحظر الجغرافي (451)
      if (status === 451 || /restricted location/i.test(raw))
        msg = "الوصول محظور من موقع الخادم (قد تحجب Binance بعض عناوين الخوادم). جرّب تغيير منطقة النشر.";
      else if (raw.length > 200) msg = `خطأ HTTP ${status}`;
    }
    super(msg);
    this.status = status;
    this.code = code;
  }
}

// ===== دوال عالية المستوى =====

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface AccountInfo {
  balances: Balance[];
  canTrade: boolean;
  canWithdraw: boolean;
  accountType: string;
}

export async function getAccountInfo(): Promise<AccountInfo> {
  const acc = await signedRequest("GET", "/api/v3/account");
  const balances: Balance[] = (acc.balances || [])
    .map((b: { asset: string; free: string; locked: string }) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
    }))
    .filter((b: Balance) => b.free + b.locked > 0);
  return {
    balances,
    canTrade: Boolean(acc.canTrade),
    canWithdraw: Boolean(acc.canWithdraw),
    accountType: acc.accountType || "SPOT",
  };
}

export async function getBalances(): Promise<Balance[]> {
  return (await getAccountInfo()).balances;
}

// صلاحيات المفتاح الفعلية (لا الحساب) — للفحص الأمني
export interface ApiRestrictions {
  enableReading: boolean;
  enableSpotAndMarginTrading: boolean;
  enableWithdrawals: boolean;
  ipRestrict: boolean;
}

export async function getApiRestrictions(): Promise<ApiRestrictions | null> {
  const { testnet } = binanceConfig();
  if (testnet) return null; // /sapi غير متاح على الشبكة التجريبية
  try {
    const r = await signedRequest("GET", "/sapi/v1/account/apiRestrictions");
    return {
      enableReading: Boolean(r.enableReading),
      enableSpotAndMarginTrading: Boolean(r.enableSpotAndMarginTrading),
      enableWithdrawals: Boolean(r.enableWithdrawals),
      ipRestrict: Boolean(r.ipRestrict),
    };
  } catch {
    return null; // لا نُفشل تحميل الحساب إن تعذّر فحص الصلاحيات
  }
}

// كل الأسعار مقابل USDT (خريطة رمز→سعر)
export async function getAllPrices(): Promise<Record<string, number>> {
  const list = (await publicGet("/api/v3/ticker/price")) as { symbol: string; price: string }[];
  const map: Record<string, number> = {};
  for (const t of list) map[t.symbol] = parseFloat(t.price);
  return map;
}

export async function getTicker24h(symbol: string) {
  return publicGet("/api/v3/ticker/24hr", { symbol });
}

export async function getPrice(symbol: string): Promise<number> {
  const t = (await publicGet("/api/v3/ticker/price", { symbol })) as { price: string };
  return parseFloat(t.price);
}

// معلومات زوج تداول (فلاتر الدقة)
export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  stepSize: number; // دقة الكمية
  tickSize: number; // دقة السعر
  minNotional: number; // أدنى قيمة أمر
}

export async function getSymbolInfo(symbol: string): Promise<SymbolInfo> {
  const info = await publicGet("/api/v3/exchangeInfo", { symbol });
  const s = info.symbols?.[0];
  if (!s) throw new BinanceError(400, `الزوج ${symbol} غير موجود`);
  const filt = (t: string) => s.filters.find((f: { filterType: string }) => f.filterType === t);
  const lot = filt("LOT_SIZE");
  const price = filt("PRICE_FILTER");
  const notional = filt("NOTIONAL") || filt("MIN_NOTIONAL");
  return {
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: s.quoteAsset,
    stepSize: parseFloat(lot?.stepSize || "0.00000001"),
    tickSize: parseFloat(price?.tickSize || "0.00000001"),
    minNotional: parseFloat(notional?.minNotional || notional?.notional || "0"),
  };
}

// تقريب قيمة إلى مضاعف الخطوة (لأسفل)
export function roundStep(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const rounded = Math.floor(value / step) * step;
  return parseFloat(rounded.toFixed(decimals));
}

export interface OrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity?: number; // كمية العملة الأساسية
  quoteOrderQty?: number; // مبلغ بعملة التسعير (لأوامر السوق)
  price?: number; // لأوامر LIMIT
}

export async function placeOrder(p: OrderParams) {
  const params: Record<string, string | number> = {
    symbol: p.symbol,
    side: p.side,
    type: p.type,
  };
  if (p.type === "MARKET") {
    if (p.quoteOrderQty != null) params.quoteOrderQty = p.quoteOrderQty;
    else if (p.quantity != null) params.quantity = p.quantity;
  } else {
    params.timeInForce = "GTC";
    params.quantity = p.quantity!;
    params.price = p.price!;
  }
  return signedRequest("POST", "/api/v3/order", params);
}

export async function getOpenOrders(symbol?: string) {
  return signedRequest("GET", "/api/v3/openOrders", symbol ? { symbol } : {});
}

export async function cancelOrder(symbol: string, orderId: number) {
  return signedRequest("DELETE", "/api/v3/order", { symbol, orderId });
}

// حالة أمر مفرد (للتحقّق من تنفيذ أرجل OCO وسعرها الفعلي)
export async function getOrder(symbol: string, orderId: number) {
  return signedRequest("GET", "/api/v3/order", { symbol, orderId });
}

// أمر OCO للبيع: جني ربح (حدّ فوق السوق) + وقف خسارة (مشغّل تحت السوق) معاً على المنصّة.
// تنفّذه Binance فوراً عند بلوغ أي مستوى — يلتقط تذبذب المضاربة دون انتظار نبضة البوت.
export async function placeOcoSell(p: {
  symbol: string;
  quantity: number;
  takeProfitPrice: number; // حدّ جني الربح (فوق السوق)
  stopPrice: number; // سعر تشغيل الوقف (تحت السوق)
  stopLimitPrice: number; // حدّ أمر الوقف بعد تشغيله (≤ stopPrice)
}) {
  return signedRequest("POST", "/api/v3/order/oco", {
    symbol: p.symbol,
    side: "SELL",
    quantity: p.quantity,
    price: p.takeProfitPrice,
    stopPrice: p.stopPrice,
    stopLimitPrice: p.stopLimitPrice,
    stopLimitTimeInForce: "GTC",
  });
}

// إلغاء قائمة أوامر OCO كاملةً (قبل بيع سوقي يدوي/إقفال يومي كي لا تُحتجَز الكمية)
export async function cancelOcoList(symbol: string, orderListId: number) {
  return signedRequest("DELETE", "/api/v3/orderList", { symbol, orderListId });
}
