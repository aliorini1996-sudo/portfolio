// محرّك Alpaca — أسهم السوق الأمريكي، يعمل في الخادم فقط (المفاتيح لا تغادر الخادم إطلاقاً)
// المصادقة برؤوس APCA-API-KEY-ID / APCA-API-SECRET-KEY — بلا توقيع

const LIVE = "https://api.alpaca.markets";
const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

export function alpacaConfig() {
  // trim: لصق المفاتيح في لوحة Vercel قد يضيف مسافة/سطراً جديداً يُفسد المصادقة
  const apiKey = (process.env.ALPACA_API_KEY || "").trim();
  const apiSecret = (process.env.ALPACA_API_SECRET || "").trim();
  const paper = String(process.env.ALPACA_PAPER || "").trim().toLowerCase() === "true";
  return { apiKey, apiSecret, paper, base: paper ? PAPER : LIVE };
}

export function isAlpacaConfigured() {
  const { apiKey, apiSecret } = alpacaConfig();
  return Boolean(apiKey && apiSecret);
}

export class AlpacaError extends Error {
  status: number;
  constructor(status: number, raw: string) {
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      msg = j.message || raw;
    } catch {
      if (raw.length > 200) msg = `خطأ HTTP ${status}`;
    }
    if (status === 401 || status === 403)
      msg = `المفاتيح مرفوضة (${status}) — تأكد من صحة ALPACA_API_KEY/SECRET وأنها لنفس البيئة (حقيقي/تجريبي): ${msg}`;
    super(msg);
    this.status = status;
  }
}

async function request(method: "GET" | "POST" | "DELETE", url: string, body?: unknown) {
  const { apiKey, apiSecret } = alpacaConfig();
  if (!apiKey || !apiSecret) throw new AlpacaError(0, "لم يُضبط مفتاح Alpaca في الخادم");
  const res = await fetch(url, {
    method,
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": apiSecret,
      "content-type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new AlpacaError(res.status, text);
  return text ? JSON.parse(text) : null;
}

// طلب لواجهة التداول (حساب/مراكز/أوامر)
function trading(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
  return request(method, `${alpacaConfig().base}${path}`, body);
}

// طلب لواجهة بيانات السوق — خطة البيانات المجانية تستخدم تغذية IEX
function marketData(path: string, params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ feed: "iex", ...params }).toString();
  return request("GET", `${DATA}${path}?${qs}`);
}

// ===== دوال عالية المستوى =====

export interface UsAccount {
  status: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  daytradeCount: number;
  patternDayTrader: boolean;
  tradingBlocked: boolean;
}

export async function getUsAccount(): Promise<UsAccount> {
  const a = await trading("GET", "/v2/account");
  return {
    status: a.status,
    currency: a.currency || "USD",
    cash: parseFloat(a.cash),
    equity: parseFloat(a.equity),
    buyingPower: parseFloat(a.buying_power),
    daytradeCount: Number(a.daytrade_count || 0),
    patternDayTrader: Boolean(a.pattern_day_trader),
    tradingBlocked: Boolean(a.trading_blocked || a.account_blocked),
  };
}

export interface UsPosition {
  symbol: string;
  qty: number;
  avgEntry: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}

export async function getUsPositions(): Promise<UsPosition[]> {
  const list = (await trading("GET", "/v2/positions")) as Record<string, string>[];
  return list.map((p) => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty),
    avgEntry: parseFloat(p.avg_entry_price),
    currentPrice: parseFloat(p.current_price),
    marketValue: parseFloat(p.market_value),
    unrealizedPl: parseFloat(p.unrealized_pl),
    unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100,
  }));
}

export interface UsClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

export async function getUsClock(): Promise<UsClock> {
  const c = await trading("GET", "/v2/clock");
  return { isOpen: Boolean(c.is_open), nextOpen: c.next_open, nextClose: c.next_close };
}

export interface UsAsset {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
  fractionable: boolean;
}

export async function getUsAsset(symbol: string): Promise<UsAsset> {
  const a = await trading("GET", `/v2/assets/${encodeURIComponent(symbol)}`);
  return {
    symbol: a.symbol,
    name: a.name || a.symbol,
    exchange: a.exchange || "",
    tradable: Boolean(a.tradable),
    fractionable: Boolean(a.fractionable),
  };
}

export interface UsSnapshot {
  price: number;
  prevClose: number | null;
  changePercent: number | null;
  high: number | null;
  low: number | null;
}

export async function getUsSnapshot(symbol: string): Promise<UsSnapshot> {
  const s = await marketData(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`);
  const price: number = s?.latestTrade?.p ?? s?.dailyBar?.c ?? 0;
  if (!price) throw new AlpacaError(404, `لا يوجد سعر متاح للسهم ${symbol}`);
  const prevClose: number | null = s?.prevDailyBar?.c ?? null;
  return {
    price,
    prevClose,
    changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    high: s?.dailyBar?.h ?? null,
    low: s?.dailyBar?.l ?? null,
  };
}

export interface UsOrderParams {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty?: number; // عدد الأسهم (يقبل كسوراً في أوامر السوق للأسهم القابلة للتجزئة)
  notional?: number; // مبلغ بالدولار (شراء سوق)
  limitPrice?: number;
}

export async function placeUsOrder(p: UsOrderParams) {
  const body: Record<string, unknown> = {
    symbol: p.symbol,
    side: p.side,
    type: p.type,
    // الكسور والمبالغ الدولارية تُقبل بأوامر يوم فقط؛ المحدّد يبقى قائماً حتى الإلغاء
    time_in_force: p.type === "limit" ? "gtc" : "day",
  };
  if (p.type === "market" && p.notional != null) body.notional = +p.notional.toFixed(2);
  else body.qty = String(p.qty);
  if (p.type === "limit") body.limit_price = String(p.limitPrice);
  return trading("POST", "/v2/orders", body);
}

export interface UsOpenOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string | null;
  notional: string | null;
  limitPrice: string | null;
  submittedAt: string;
}

export async function getUsOpenOrders(): Promise<UsOpenOrder[]> {
  const list = (await trading("GET", "/v2/orders?status=open&limit=50")) as Record<
    string,
    string | null
  >[];
  return list.map((o) => ({
    id: String(o.id),
    symbol: String(o.symbol),
    side: String(o.side),
    type: String(o.type),
    qty: o.qty,
    notional: o.notional,
    limitPrice: o.limit_price,
    submittedAt: String(o.submitted_at || ""),
  }));
}

export async function cancelUsOrder(id: string) {
  return trading("DELETE", `/v2/orders/${encodeURIComponent(id)}`);
}
