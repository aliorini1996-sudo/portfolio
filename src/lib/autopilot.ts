// محرّك المضاربة الآلية — يعمل بنبضات دورية (tick)
// المنهج: ترشيح قواعدي مجاني → تأكيد Claude بثقة كافية → شراء → إدارة بوقف/هدف → بيع
// أمان: لا يلمس إلا المراكز التي فتحها هو؛ سقف لكل صفقة وسقف يومي؛ إيقاف فوري بمفتاح
import { promises as fsp, mkdirSync } from "fs";
import path from "path";
import {
  getAccountInfo,
  getSymbolInfo,
  getPrice,
  placeOrder,
  placeOcoSell,
  getOpenOrders,
  getOrder,
  cancelOcoList,
  roundStep,
  isConfigured,
} from "@/lib/binance";
import { buildAnalysis, marketUniverse } from "@/lib/marketAnalysis";
import { getAiVerdict, callAi } from "@/lib/aiVerdict";
import { marketSentiment } from "@/lib/sentiment";

// التاريخ بتوقيت السعودية (UTC+3، بلا توقيت صيفي) — لتجميع أرباح اليوم والإقفال اليومي
export function riyadhDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
export function riyadhDateOf(iso: string): string {
  return riyadhDate(new Date(iso));
}
// وعي الوقت بتوقيت الرياض — يعرفه البوت في القرار والدردشة
const WEEKDAYS_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
export function riyadhTime(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
export function riyadhHour(iso: string | Date = new Date()): number {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Date(d.getTime() + 3 * 3600 * 1000).getUTCHours();
}
export function riyadhWeekday(d: Date = new Date()): string {
  return WEEKDAYS_AR[new Date(d.getTime() + 3 * 3600 * 1000).getUTCDay()];
}

const STATE_KEY = "autopilot-state.json"; // حالة التشغيل — يكتبها البوت (tick/daily/chat)
const SETTINGS_KEY = "autopilot-settings.json"; // الإعدادات — يكتبها المستخدم فقط (لا يلمسها البوت)

// مجلد التخزين الدائم على Render (قرص مُركَّب) — بديل @vercel/blob. محليًا اضبط DATA_DIR لمجلّد قابل للكتابة.
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const dataFile = (key: string) => path.join(DATA_DIR, key.replace(/[^\w.-]/g, "_"));

// حقول الإعدادات (يملكها المستخدم) — تُخزَّن منفصلة كي لا يدهسها البوت أبداً
const SETTINGS_FIELDS = [
  "enabled",
  "perTradeUsdt",
  "dailyCapUsdt",
  "minConfidence",
  "symbols",
  "tradeAllMarket",
  "maxScan",
  "strategy",
  "screenMode",
] as const;

export interface BotPosition {
  symbol: string;
  qty: number;
  entry: number;
  stopLoss: number;
  target: number;
  openedAt: string;
  reason: string;
  peak?: number; // أعلى سعر بلغه المركز — لحساب الوقف المتحرك
  ocoListId?: number; // معرّف قائمة OCO على Binance (جني ربح + وقف على المنصّة)
  ocoOrders?: number[]; // معرّفات رجْلَي OCO (لكشف التنفيذ وسعره)
}

export interface LogEntry {
  t: string;
  level: "info" | "trade" | "error";
  msg: string;
}

// صفقة مغلقة — الذاكرة الدائمة التي يتعلّم منها البوت
// entry/pnl فارغة (null) عند بيع أصل مملوك مسبقاً لا يعرف البوت تكلفته
export interface ClosedTrade {
  symbol: string;
  entry: number | null;
  exit: number;
  qty: number;
  pnlUsdt: number | null; // صافي بعد خصم رسوم الشراء والبيع
  pnlPct: number | null; // صافي بعد الرسوم
  feesUsdt?: number; // إجمالي رسوم التداول للصفقة (شراء + بيع)
  openedAt: string | null;
  closedAt: string;
  exitReason: string; // وقف خسارة / جني أرباح / بيع تحليلي
  entryConfidence: number | null; // ثقة AI وقت الدخول
  entryReason: string;
}

export interface ApState {
  enabled: boolean;
  perTradeUsdt: number; // 0 = بلا حد (يستخدم كل المتاح)
  dailyCapUsdt: number; // 0 = بلا حد
  minConfidence: number; // 0..100
  symbols: string[];
  tradeAllMarket: boolean; // كل سوق USDT (مرشّحون ديناميكيون) بدل قائمة ثابتة
  maxScan: number; // أقصى عدد عملات تُحلَّل بالدورة في وضع «كل السوق» (ضبط التكلفة/الوقت)
  strategy: string; // قواعد وتجارب المستخدم — دستور ملزم لحكم AI
  screenMode: "rule" | "always"; // اقتصادي (ترشيح قواعدي أولاً) أو كامل (AI يقيّم كل عملة كل دورة)
  lessons: { t: string; text: string }[]; // دروس متعلَّمة من مناقشة القرارات — تُلزم الأحكام القادمة
  positions: BotPosition[];
  trades: ClosedTrade[]; // سجلّ الصفقات المغلقة — ذاكرة الأداء التي يتعلّم منها
  dailyHistory: DailyRecord[]; // ملخّص كل يوم (ربح/خسارة محقق + دروس) — للإقفال اليومي
  blocked: string[]; // رموز مقيّدة على المفتاح (not whitelisted) — تُتخطّى تلقائياً
  log: LogEntry[];
  dailySpent: number;
  dailyDate: string;
  lastRunAt: string | null;
  // === وعي الوقت وتعلّم توقيت اليوم ===
  sessionStartAt: string | null; // بداية جلسة اليوم (أول نبضة بعد منتصف ليل الرياض)
  buyHourStats: HourBucket[]; // 24 خانة — أداء الدخول حسب ساعة الرياض (تراكمي عبر الأيام)
  sellHourStats: HourBucket[]; // 24 خانة — أداء الخروج حسب ساعة الرياض (تراكمي)
}

// خانة إحصاء ساعة واحدة — يتراكم عبر الأيام ليتعلّم البوت الأوقات المناسبة
export interface HourBucket {
  trades: number; // عدد الصفقات معروفة النتيجة في هذه الساعة
  wins: number; // كم منها رابح
  pnl: number; // صافي الربح/الخسارة المتراكم لهذه الساعة (USDT)
}
function emptyHourStats(): HourBucket[] {
  return Array.from({ length: 24 }, () => ({ trades: 0, wins: 0, pnl: 0 }));
}

// سجلّ يوم واحد — يُكتب عند الإقفال اليومي (23:00 السعودية)
export interface DailyRecord {
  date: string; // تاريخ الرياض YYYY-MM-DD
  realizedUsdt: number; // صافي الربح/الخسارة المحقق لليوم
  closedCount: number; // عدد الصفقات المغلقة معروفة النتيجة
  lessons: number; // عدد الدروس المستخلصة
  note: string;
}

export function defaultState(): ApState {
  return {
    enabled: false,
    perTradeUsdt: 25,
    dailyCapUsdt: 100,
    minConfidence: 70,
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"],
    tradeAllMarket: false,
    maxScan: 12,
    strategy: "",
    screenMode: "rule",
    lessons: [],
    positions: [],
    trades: [],
    dailyHistory: [],
    blocked: [],
    log: [],
    dailySpent: 0,
    dailyDate: "",
    lastRunAt: null,
    sessionStartAt: null,
    buyHourStats: emptyHourStats(),
    sellHourStats: emptyHourStats(),
  };
}

// جاهزية التخزين: مجلد القرص الدائم قابل للإنشاء/الكتابة. (الاسم يبقى blobReady لعدم كسر المستدعين الـ7.)
export function blobReady(): boolean {
  try { mkdirSync(DATA_DIR, { recursive: true }); return true; }
  catch { return false; }
}

// يقرأ ملف JSON بمفتاح معيّن من القرص الدائم — يعيد Partial أو null (الملف غير موجود = أول تشغيل)
async function readBlob(key: string): Promise<Partial<ApState> | null> {
  try {
    const raw = await fsp.readFile(dataFile(key), "utf8");
    return JSON.parse(raw) as Partial<ApState>;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<ApState> {
  if (!blobReady()) throw new Error("BLOB_MISSING");
  const [runtime, settings] = await Promise.all([readBlob(STATE_KEY), readBlob(SETTINGS_KEY)]);
  // الدمج: القاعدة ← التشغيل (يحوي إعدادات قديمة للترحيل) ← ملف الإعدادات (يفوز إن وُجد)
  return { ...defaultState(), ...(runtime || {}), ...(settings || {}) };
}

// يكتب ملف JSON على القرص الدائم بشكل ذرّي (ملف مؤقّت ثم إعادة تسمية) — بديل put من @vercel/blob
async function writeBlob(key: string, data: unknown): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const dest = dataFile(key);
  const tmp = `${dest}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), "utf8");
  await fsp.rename(tmp, dest);
}

// يكتب حالة التشغيل فقط (لا يمسّ الإعدادات إطلاقاً) — يستدعيه البوت
export async function saveState(s: ApState): Promise<void> {
  const runtime = {
    positions: s.positions,
    trades: (s.trades || []).slice(-60),
    dailyHistory: (s.dailyHistory || []).slice(-90),
    blocked: (s.blocked || []).slice(-40),
    lessons: (s.lessons || []).slice(-30),
    log: (s.log || []).slice(-80),
    dailySpent: s.dailySpent,
    dailyDate: s.dailyDate,
    lastRunAt: s.lastRunAt,
    sessionStartAt: s.sessionStartAt,
    buyHourStats: s.buyHourStats,
    sellHourStats: s.sellHourStats,
  };
  await writeBlob(STATE_KEY, runtime);
}

// يكتب الإعدادات فقط (لا يمسّ حالة التشغيل) — يستدعيه مسار الإعدادات (المستخدم)
export async function saveSettings(s: ApState): Promise<void> {
  const settings: Record<string, unknown> = {};
  for (const f of SETTINGS_FIELDS) settings[f] = s[f];
  await writeBlob(SETTINGS_KEY, settings);
}

// يستخرج ثقة AI من نص سبب الدخول ("AI ثقة 78%: ...")
function confFromReason(reason: string): number | null {
  const m = /ثقة\s+(\d+)\s*%/.exec(reason || "");
  return m ? Number(m[1]) : null;
}

// ملخّص أداء يُحقن في كل حكم — ذاكرة البوت الحقيقية عن نفسه
// يحسب الإحصاءات من الصفقات ذات الربح المعروف فقط (يتجاهل تصفية ممتلكات بلا تكلفة)
export function performanceDigest(trades: ClosedTrade[]): string {
  if (!trades?.length) return "";
  const recent = trades.slice(-20);
  const scored = recent.filter((t) => t.pnlPct != null) as (ClosedTrade & {
    pnlPct: number;
    pnlUsdt: number;
  })[];
  if (!scored.length) return "";

  const wins = scored.filter((t) => t.pnlPct > 0);
  const losses = scored.filter((t) => t.pnlPct <= 0);
  const winRate = Math.round((wins.length / scored.length) * 100);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
  const net = scored.reduce((a, t) => a + t.pnlUsdt, 0);

  // سجلّ كل عملة على حدة — «SOL: 1 ربح / 3 خسارة» يغيّر القرار فعلياً
  const bySym: Record<string, { w: number; l: number; pnl: number }> = {};
  for (const t of scored) {
    const k = (bySym[t.symbol] ||= { w: 0, l: 0, pnl: 0 });
    if (t.pnlPct > 0) k.w++;
    else k.l++;
    k.pnl += t.pnlUsdt;
  }
  const symLines = Object.entries(bySym)
    .map(([k, v]) => `${k}: ${v.w} ربح / ${v.l} خسارة (${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(1)} USDT)`)
    .join("، ");

  return (
    `آخر ${scored.length} صفقة مغلقة معروفة النتيجة: نسبة الربح ${winRate}%، ` +
    `متوسط الرابحة +${avgWin.toFixed(1)}%، متوسط الخاسرة ${avgLoss.toFixed(1)}%، ` +
    `صافي ${net >= 0 ? "+" : ""}${net.toFixed(1)} USDT.\nحسب العملة — ${symLines}.`
  );
}

// ============ محاسبة الصفقات ============
// رسوم Binance الفورية القياسية: 0.1% لكل جهة (شراء + بيع). نحسب الربح صافياً بعد الرسوم
// حتى لا تُبالَغ أرباح المضاربة السريعة (الرسوم ~0.2% ذهاباً وإياباً تلتهم جزءاً من الهدف الصغير).
export const FEE_RATE = 0.001;

// صافي ربح/خسارة صفقة مقفلة بعد خصم رسوم الشراء والبيع
export function netRealized(entry: number, exit: number, qty: number) {
  const gross = (exit - entry) * qty;
  const fees = FEE_RATE * qty * (entry + exit); // 0.1%×قيمة الشراء + 0.1%×قيمة البيع
  const net = gross - fees;
  return {
    pnlUsdt: +net.toFixed(2),
    pnlPct: entry > 0 ? +((net / (entry * qty)) * 100).toFixed(2) : 0,
    feesUsdt: +fees.toFixed(2),
  };
}

// سعر الخروج الفعلي من تنفيذات أمر البيع (متوسط مرجّح)، وإلا السعر المرجعي — أدقّ من سعر ما قبل التنفيذ
function fillPrice(
  order: { fills?: { price: string; qty: string }[]; executedQty?: string },
  fallback: number,
  qty: number
): number {
  const fills = order.fills || [];
  const exec = parseFloat(order.executedQty || String(qty)) || qty;
  if (!fills.length || !exec) return fallback;
  return fills.reduce((a, f) => a + parseFloat(f.price) * parseFloat(f.qty), 0) / exec;
}

// ============ تعلّم توقيت اليوم (بتوقيت الرياض) ============
function ensureHourStats(s: ApState) {
  if (!Array.isArray(s.buyHourStats) || s.buyHourStats.length !== 24) s.buyHourStats = emptyHourStats();
  if (!Array.isArray(s.sellHourStats) || s.sellHourStats.length !== 24) s.sellHourStats = emptyHourStats();
}

// يطوي صفقات مقفلة جديدة في خانات الساعة (مرّة واحدة لكل صفقة) — ذاكرة توقيت دائمة تتجاوز حدّ الـ60
export function foldHourStats(s: ApState, trades: ClosedTrade[]) {
  ensureHourStats(s);
  for (const t of trades) {
    if (t.pnlUsdt == null) continue; // نتيجة غير معروفة (تصفية ممتلكات بلا تكلفة) لا تُعلّم توقيتاً
    if (t.openedAt) {
      const b = s.buyHourStats[riyadhHour(t.openedAt)];
      b.trades++;
      if (t.pnlUsdt > 0) b.wins++;
      b.pnl = +(b.pnl + t.pnlUsdt).toFixed(2);
    }
    const e = s.sellHourStats[riyadhHour(t.closedAt)];
    e.trades++;
    if (t.pnlUsdt > 0) e.wins++;
    e.pnl = +(e.pnl + t.pnlUsdt).toFixed(2);
  }
}

// خلاصة توقيت اليوم — أفضل/أسوأ ساعات الدخول والخروج تاريخياً (تُحقن في القرار والدردشة)
export function timingDigest(s: ApState): string {
  ensureHourStats(s);
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const rank = (arr: HourBucket[], label: string, verb: string): string => {
    const rows = arr.map((b, h) => ({ h, ...b })).filter((r) => r.trades >= 3); // 3 صفقات على الأقل لدلالة
    if (rows.length < 2) return `${label}: لا تزال العيّنة صغيرة للتعلّم (تحتاج ≥3 صفقات في الساعة).`;
    const line = (r: (typeof rows)[number]) =>
      `${hh(r.h)} (${r.trades} صفقة، نجاح ${Math.round((r.wins / r.trades) * 100)}%، ${r.pnl >= 0 ? "+" : ""}${r.pnl}$)`;
    const best = [...rows].sort((a, b) => b.pnl - a.pnl).slice(0, 3).map(line).join("، ");
    const worst = [...rows].sort((a, b) => a.pnl - b.pnl).slice(0, 3).map(line).join("، ");
    return `${label} — أفضل ساعات ${verb}: ${best}؛ أسوأ ساعات ${verb}: ${worst}.`;
  };
  return rank(s.buyHourStats, "توقيت الشراء", "الدخول") + "\n" + rank(s.sellHourStats, "توقيت البيع", "الخروج");
}

// سياق الوقت الحالي والجلسة — يُحقن في القرار والدردشة كي يعرف البوت «الساعة كم» ومتى بدأت الجلسة
export function timeContext(s?: ApState | null): string {
  const now = `الوقت الآن بتوقيت الرياض: ${riyadhTime()} (الساعة ${riyadhHour()}، ${riyadhWeekday()}).`;
  if (!s) return now;
  const sess = s.sessionStartAt
    ? ` جلسة اليوم بدأت الساعة ${riyadhTime(new Date(s.sessionStartAt)).slice(11)} (${riyadhDateOf(s.sessionStartAt)}).`
    : "";
  const last = s.lastRunAt ? ` آخر فحص: ${riyadhTime(new Date(s.lastRunAt))}.` : "";
  return now + sess + last;
}

// ============ دورة واحدة من المحرّك ============
export interface TickResult {
  ran: boolean;
  reason?: string;
  actions: string[];
}

export async function runTick(): Promise<TickResult> {
  const s = await loadState();
  const actions: string[] = [];
  // سجلّ هذه الدورة يُجمع منفصلاً ويُدمج عند الحفظ — يمنع دهس ما كُتب أثناء الدورة (دروس/إعدادات)
  const newLog: LogEntry[] = [];
  const log = (level: LogEntry["level"], msg: string) =>
    newLog.push({ t: new Date().toISOString(), level, msg });
  // الصفقات المغلقة في هذه الدورة تُجمع منفصلة وتُدمج عند الحفظ (كالسجلّ)
  const newTrades: ClosedTrade[] = [];
  // رموز اكتُشف أنها مقيّدة على المفتاح هذه الدورة — تُدمج في قائمة التخطّي
  const newBlocked: string[] = [];

  if (!s.enabled) return { ran: false, reason: "المضاربة الآلية متوقفة", actions };
  if (!isConfigured()) return { ran: false, reason: "حساب Binance غير مربوط", actions };

  // تصفير العدّاد اليومي + بدء جلسة جديدة عند يوم رياض جديد
  const today = riyadhDate();
  if (s.dailyDate !== today) {
    s.dailyDate = today;
    s.dailySpent = 0;
    s.sessionStartAt = new Date().toISOString(); // بداية جلسة اليوم (بتوقيت الرياض)
  }
  if (!s.sessionStartAt) s.sessionStartAt = new Date().toISOString();

  // معنويات السوق والأخبار — تُعرض على كل حكم AI في هذه الدورة
  const market = await marketSentiment();
  const lessonsTexts = s.lessons.map((l) => l.text);
  // ذاكرة الأداء + وعي الوقت وتوقيت اليوم — تُحقن في كل حكم ليتعلّم البوت من نتائجه وأوقاته
  const perf = performanceDigest(s.trades);
  const timing = `${timeContext(s)}\n${timingDigest(s)}`;

  try {
    // ===== 1) إدارة المراكز المفتوحة (وقف خسارة / جني أرباح) =====
    if (s.positions.length) {
      const acc = await getAccountInfo();
      // معرّفات الأوامر المفتوحة حالياً — اختفاء رجْلَي OCO يعني أن المنصّة نفّذت الخروج لحظياً
      let openIds = new Set<number>();
      try {
        openIds = new Set(((await getOpenOrders()) as { orderId: number }[]).map((o) => o.orderId));
      } catch {
        /* تعذّر جلب الأوامر — نُكمل بالإدارة الداخلية */
      }
      for (const pos of [...s.positions]) {
        try {
          // --- مركز محروس بـ OCO على المنصّة: افحص إن نُفِّذ الخروج لحظياً ---
          if (pos.ocoListId && pos.ocoOrders?.length) {
            const stillOpen = openIds.size > 0 && pos.ocoOrders.some((id) => openIds.has(id));
            if (stillOpen) continue; // المنصّة تحرس الهدف/الوقف لحظياً — لا تدخّل هذه الدورة
            // اختفت الأرجل → إمّا نُفِّذت (بيعت) أو أُلغيت. افحص الرصيد لنميّز:
            const base = pos.symbol.replace(/USDT$/, "");
            const freeNow = acc.balances.find((b) => b.asset === base)?.free ?? 0;
            if (freeNow >= pos.qty * 0.5) {
              // الرصيد باقٍ → أُلغي OCO دون تنفيذ — أعِد الإدارة الداخلية لهذا المركز
              pos.ocoListId = undefined;
              pos.ocoOrders = undefined;
            } else {
              // نُفِّذ خروج المنصّة → استخرج السعر الفعلي من الرجل المنفَّذة
              let exitPx = await getPrice(pos.symbol);
              let execQty = pos.qty;
              let via = "خروج OCO";
              for (const id of pos.ocoOrders) {
                try {
                  const od = await getOrder(pos.symbol, id);
                  const ex = parseFloat(od.executedQty || "0");
                  if (od.status === "FILLED" && ex > 0) {
                    const cq = parseFloat(od.cummulativeQuoteQty || "0");
                    execQty = ex;
                    exitPx = cq > 0 ? cq / ex : exitPx;
                    via = od.type === "STOP_LOSS_LIMIT" ? "وقف خسارة (OCO)" : "جني ربح (OCO)";
                    break;
                  }
                } catch {
                  /* تجاهل رجلاً يتعذّر جلبها */
                }
              }
              const r = netRealized(pos.entry, exitPx, execQty);
              const emsg = `⚡ ${via}: ${pos.symbol} دخول ${pos.entry} → ${exitPx.toFixed(4)} (صافي ${r.pnlPct}% بعد الرسوم)`;
              log("trade", emsg);
              actions.push(emsg);
              newTrades.push({
                symbol: pos.symbol,
                entry: pos.entry,
                exit: +exitPx.toFixed(8),
                qty: execQty,
                pnlUsdt: r.pnlUsdt,
                pnlPct: r.pnlPct,
                feesUsdt: r.feesUsdt,
                openedAt: pos.openedAt,
                closedAt: new Date().toISOString(),
                exitReason: via,
                entryConfidence: confFromReason(pos.reason),
                entryReason: pos.reason,
              });
              s.positions = s.positions.filter((p) => p !== pos);
              continue;
            }
          }
          const price = await getPrice(pos.symbol);
          // === مضاربة سريعة (scalping): جني ربح سريع عند الهدف + تأمين تعادل ووقف ضيّق ===
          pos.peak = Math.max(pos.peak ?? pos.entry, price);
          const gain = (price - pos.entry) / pos.entry;
          // بعد +0.6% ربح: انقل الوقف للتعادل+ وتتبّعه بضيق (0.8% تحت القمة) لقفل الربح سريعاً
          if (gain >= 0.006) {
            const trail = Math.max(pos.entry * 1.0008, pos.peak * 0.992);
            if (trail > pos.stopLoss) pos.stopLoss = +trail.toFixed(8);
          }
          let exitReason: string | null = null;
          let win = false;
          if (price >= pos.target) {
            exitReason = `جني ربح سريع عند ${price}`;
            win = true;
          } else if (price <= pos.stopLoss) {
            win = price >= pos.entry;
            exitReason = win ? `قفل ربح بوقف ضيّق عند ${price}` : `وقف خسارة عند ${price}`;
          }

          if (!exitReason) continue;

          const info = await getSymbolInfo(pos.symbol);
          const free = acc.balances.find((b) => b.asset === info.baseAsset)?.free ?? 0;
          const qty = roundStep(Math.min(pos.qty, free), info.stepSize);

          if (qty <= 0) {
            log("error", `${pos.symbol}: لا رصيد للبيع (بيعَ يدوياً؟) — أُزيل المركز من التتبّع`);
            s.positions = s.positions.filter((p) => p !== pos);
            continue;
          }

          const order = await placeOrder({ symbol: pos.symbol, side: "SELL", type: "MARKET", quantity: qty });
          const exitPx = fillPrice(order, price, qty); // سعر البيع الفعلي المنفَّذ
          const r = netRealized(pos.entry, exitPx, qty); // صافٍ بعد الرسوم
          const msg = `بيع ${qty} ${info.baseAsset} — ${exitReason} (دخول ${pos.entry} → ${exitPx.toFixed(4)}، صافي ${r.pnlPct}% بعد الرسوم) أمر #${order.orderId}`;
          log("trade", msg);
          actions.push(msg);
          newTrades.push({
            symbol: pos.symbol,
            entry: pos.entry,
            exit: +exitPx.toFixed(8),
            qty,
            pnlUsdt: r.pnlUsdt,
            pnlPct: r.pnlPct,
            feesUsdt: r.feesUsdt,
            openedAt: pos.openedAt,
            closedAt: new Date().toISOString(),
            exitReason: price >= pos.target ? "جني ربح سريع" : win ? "قفل ربح بوقف ضيّق" : "وقف خسارة",
            entryConfidence: confFromReason(pos.reason),
            entryReason: pos.reason,
          });
          s.positions = s.positions.filter((p) => p !== pos);
        } catch (e) {
          log("error", `${pos.symbol}: فشل إدارة المركز — ${String((e as Error).message).slice(0, 120)}`);
        }
      }
    }

    // ===== 1.5) التفويض المطلق: إدارة كل الممتلكات (أي أصل بمحفظة المستخدم) =====
    // ترشيح مجاني: AI يُستشار فقط عند إشارة ضعف قواعدية — ثم بيع بقرار تحليلي جريء
    try {
      const accAll = await getAccountInfo();
      const stables = new Set(["USDT", "USDC", "FDUSD", "BUSD"]);
      for (const b of accAll.balances) {
        if (stables.has(b.asset)) continue;
        const symbol = `${b.asset}USDT`;
        let analysis;
        try {
          analysis = await buildAnalysis(symbol, { scalp: true });
        } catch {
          continue; // لا زوج USDT لهذا الأصل
        }
        const value = (b.free + b.locked) * analysis.price;
        if (value < 10) continue;
        if (analysis.rule.signal !== "SELL") continue;

        const { ai, error } = await getAiVerdict(analysis, s.strategy, lessonsTexts, market, perf, timing);
        if (!ai) {
          log("error", `${symbol}: تعذّر حكم AI — ${error}`);
          if (/429|quota|RESOURCE_EXHAUSTED/i.test(error || "")) break; // حصة منهَكة — أوقف تقييم الممتلكات
          continue;
        }
        if (ai.recommendation !== "SELL" || ai.confidence < s.minConfidence) {
          log("info", `${symbol}: إشارة ضعف قواعدية لكن AI قال ${ai.recommendation} بثقة ${ai.confidence}% — إبقاء`);
          continue;
        }

        const info = await getSymbolInfo(symbol);
        const qty = roundStep(b.free, info.stepSize);
        if (qty <= 0) continue;
        const botPos = s.positions.find((p) => p.symbol === symbol); // إن كان مركزاً فتحه البوت نعرف تكلفته
        const order = await placeOrder({ symbol, side: "SELL", type: "MARKET", quantity: qty });
        const exitPx = fillPrice(order, analysis.price, qty); // سعر البيع الفعلي المنفَّذ
        const msg = `بيع ${qty} ${b.asset} بقرار تحليلي جريء (ثقة ${ai.confidence}%: ${(ai.summary || "").slice(0, 90)}) — أمر #${order.orderId}`;
        log("trade", msg);
        actions.push(msg);
        // نسجّل كل بيع؛ الربح يُحسب فقط عند معرفة الدخول (مراكز البوت). ممتلكات المستخدم تُسجَّل بلا ربح
        const entryKnown = botPos ? botPos.entry : null;
        const r = entryKnown != null ? netRealized(entryKnown, exitPx, qty) : null; // صافٍ بعد الرسوم
        newTrades.push({
          symbol,
          entry: entryKnown,
          exit: +exitPx.toFixed(8),
          qty,
          pnlUsdt: r ? r.pnlUsdt : null,
          pnlPct: r ? r.pnlPct : null,
          feesUsdt: r ? r.feesUsdt : undefined,
          openedAt: botPos ? botPos.openedAt : null,
          closedAt: new Date().toISOString(),
          exitReason: botPos ? "بيع تحليلي جريء" : "بيع تحليلي (تصفية ممتلكات — تكلفة غير معروفة)",
          entryConfidence: botPos ? confFromReason(botPos.reason) : ai.confidence,
          entryReason: botPos ? botPos.reason : "أصل مملوك مسبقاً لم يفتحه البوت",
        });
        s.positions = s.positions.filter((p) => p.symbol !== symbol);
      }
    } catch (e) {
      log("error", `إدارة الممتلكات: ${String((e as Error).message).slice(0, 120)}`);
    }

    // ===== 2) البحث عن دخول جديد =====
    // 0 = بلا حد: مبلغ الصفقة والسقف اليومي يصيران بلا سقف
    const perTradeMax = s.perTradeUsdt > 0 ? s.perTradeUsdt : Number.POSITIVE_INFINITY;

    // كون الفحص: كل السوق (مرشّحون ديناميكيون) أو القائمة الثابتة
    let scanList: string[];
    if (s.tradeAllMarket) {
      const cap = s.maxScan > 0 ? s.maxScan : 12;
      try {
        const universe = await marketUniverse(cap);
        // ادمج قائمة المستخدم المفضّلة أولاً ثم أكثر السوق حركةً — بلا تكرار
        scanList = [...new Set([...s.symbols, ...universe])].slice(0, cap);
        log("info", `وضع كل السوق: فحص ${scanList.length} من أكثر العملات حركةً`);
      } catch (e) {
        scanList = s.symbols.slice(0, 8); // تعذّر جلب الكون → القائمة الثابتة احتياطاً
        log("error", `تعذّر جلب كون السوق (${String((e as Error).message).slice(0, 60)}) — عدت للقائمة`);
      }
    } else {
      scanList = s.symbols.slice(0, 8);
    }

    // تخطّى الرموز المقيّدة على المفتاح (تعلّمها من محاولات سابقة) — يوفّر استدعاءات AI ويمنع الأخطاء المتكررة
    const blockedSet = new Set(s.blocked || []);
    scanList = scanList.filter((sym) => !blockedSet.has(sym));

    // رتّب المرشّحين بالإشارة القواعدية (فحص مجاني)، واستشر AI لأقواهم فقط — يحافظ على حصة Gemini
    // المجانية من النفاد (نفادها = عجز البوت عن التقييم = لا صفقات مضاربة)، ثم ادخل صفقة قوية واحدة لكل نبضة.
    type Cand = { symbol: string; analysis: Awaited<ReturnType<typeof buildAnalysis>> };
    const candidates: Cand[] = [];
    for (const symbol of scanList) {
      if (s.positions.some((p) => p.symbol === symbol)) continue; // مركز قائم
      try {
        const analysis = await buildAnalysis(symbol, { scalp: true });
        if (s.screenMode !== "always" && analysis.rule.signal !== "BUY") continue;
        candidates.push({ symbol, analysis });
      } catch {
        /* لا زوج/بيانات لهذا الرمز */
      }
    }
    candidates.sort((a, b) => b.analysis.rule.score - a.analysis.rule.score);

    const MAX_AI_ENTRIES = 3; // سقف استشارات AI للدخول لكل نبضة (توفير الحصة المجانية)
    let aiUsed = 0;
    for (const { symbol, analysis } of candidates) {
      const dailyRemaining =
        s.dailyCapUsdt > 0 ? s.dailyCapUsdt - s.dailySpent : Number.POSITIVE_INFINITY;
      if (dailyRemaining < 10) {
        actions.push(`بلغ السقف اليومي (${s.dailyCapUsdt} USDT) — لا دخول جديد`);
        break;
      }
      if (aiUsed >= MAX_AI_ENTRIES) break; // حافظ على الحصة — البقية للنبضة القادمة

      try {
        aiUsed++;
        const { ai, error } = await getAiVerdict(analysis, s.strategy, lessonsTexts, market, perf, timing);
        if (!ai) {
          log("error", `${symbol}: تعذّر حكم AI — ${error}`);
          if (/429|quota|RESOURCE_EXHAUSTED/i.test(error || "")) {
            log("info", "حصة Gemini مُنهَكة هذه النبضة — تُستأنف التقييمات لاحقاً");
            break; // لا فائدة من محاولة بقية المرشّحين بنفس النبضة
          }
          continue;
        }
        if (ai.recommendation !== "BUY" || ai.confidence < s.minConfidence) {
          log("info", `${symbol}: إشارة قواعدية شراء لكن AI قال ${ai.recommendation} بثقة ${ai.confidence}% — تجاهُل`);
          continue;
        }

        // رصيد USDT المتاح فعلياً
        const acc = await getAccountInfo();
        const usdtFree = acc.balances.find((b) => b.asset === "USDT")?.free ?? 0;
        const amount = Math.floor(Math.min(perTradeMax, usdtFree, dailyRemaining) * 100) / 100;
        if (amount < 10) {
          log("info", `${symbol}: إشارة شراء مؤكدة لكن الرصيد المتاح (${usdtFree.toFixed(2)} USDT) غير كافٍ`);
          continue;
        }

        const order = await placeOrder({ symbol, side: "BUY", type: "MARKET", quoteOrderQty: amount });
        const fills = (order.fills || []) as { price: string; qty: string }[];
        const qty = parseFloat(order.executedQty || "0");
        const entry =
          fills.length && qty
            ? fills.reduce((sum, f) => sum + parseFloat(f.price) * parseFloat(f.qty), 0) / qty
            : analysis.price;

        // مضاربة سريعة: هدف قريب (+1.5%) ووقف ضيّق (−1%) — تعبئة أسرع واستفادة من التذبذب
        // نحترم هدف/وقف AI فقط إن كانا ضمن نطاق المضاربة الضيّق، وإلا نفرض المستويات السريعة
        const scalpTarget = entry * 1.015;
        const scalpStop = entry * 0.99;
        const target =
          ai.targets?.[0] && ai.targets[0] > entry && ai.targets[0] <= entry * 1.03
            ? ai.targets[0]
            : scalpTarget;
        const stopLoss =
          ai.stopLoss && ai.stopLoss < entry && ai.stopLoss >= entry * 0.982 ? ai.stopLoss : scalpStop;

        // ضع أمر OCO على Binance: جني الربح والوقف ينفّذان لحظياً عند بلوغهما — يلتقط تذبذب
        // المضاربة دون انتظار النبضة (كل 15 دقيقة)، وهو جوهر المضاربة السريعة الحقيقية.
        let ocoListId: number | undefined;
        let ocoOrders: number[] | undefined;
        try {
          const info = await getSymbolInfo(symbol);
          const tp = roundStep(target, info.tickSize);
          const sp = roundStep(stopLoss, info.tickSize);
          const slp = roundStep(stopLoss * 0.997, info.tickSize); // حدّ الوقف أدنى قليلاً لضمان التنفيذ
          const sellQty = roundStep(qty * 0.999, info.stepSize); // اترك غباراً للرسوم كي لا يفشل لنقص الرصيد
          const notionOk = sellQty * sp >= (info.minNotional || 0);
          if (sellQty > 0 && tp > entry && sp < entry && slp <= sp && notionOk) {
            const oco = await placeOcoSell({
              symbol,
              quantity: sellQty,
              takeProfitPrice: tp,
              stopPrice: sp,
              stopLimitPrice: slp,
            });
            ocoListId = oco.orderListId;
            ocoOrders = ((oco.orders || []) as { orderId: number }[]).map((o) => o.orderId);
          }
        } catch (e) {
          log(
            "info",
            `${symbol}: تعذّر وضع OCO (${String((e as Error).message).slice(0, 80)}) — يُدار الوقف/الهدف بالنبضات`
          );
        }

        s.positions.push({
          symbol,
          qty,
          entry: +entry.toFixed(8),
          stopLoss: +stopLoss.toFixed(8),
          target: +target.toFixed(8),
          openedAt: new Date().toISOString(),
          reason: `AI ثقة ${ai.confidence}%: ${ai.summary?.slice(0, 120) || ""}`,
          ocoListId,
          ocoOrders,
        });
        s.dailySpent += amount;

        const guard = ocoListId ? `OCO#${ocoListId} على المنصّة ⚡` : "إدارة بالنبضات";
        const msg = `شراء ${symbol} بمبلغ ${amount} USDT (كمية ${qty}، دخول ~${entry.toFixed(4)}، وقف ${stopLoss.toFixed(4)}، هدف ${target.toFixed(4)}، ${guard}) — ثقة AI ${ai.confidence}% — أمر #${order.orderId}`;
        log("trade", msg);
        actions.push(msg);
        break; // صفقة دخول قوية واحدة لكل نبضة — مضاربة مركّزة وتوفير للحصة (البقية محروسة بـ OCO)
      } catch (e) {
        const emsg = String((e as Error).message);
        // رمز مقيّد على المفتاح (إقليمياً/whitelist) → أضِفه لقائمة التخطّي فلا يُحاوَل مجدداً
        if (/whitelist/i.test(emsg)) {
          newBlocked.push(symbol);
          log("info", `${symbol}: مقيّد على مفتاح Binance — أُضيف لقائمة التخطّي التلقائي`);
        } else {
          log("error", `${symbol}: ${emsg.slice(0, 150)}`);
        }
      }
    }

    if (!actions.length) {
      log("info", "دورة فحص: لا فرص مطابقة للشروط ولا مراكز تستوجب إغلاقاً");
    }
  } finally {
    // دمج عند الحفظ: خُذ أحدث حقول المستخدم (إعدادات/استراتيجية/دروس/تشغيل) كما هي الآن،
    // واكتب فقط ما تملكه الدورة (مراكز/مصروف/سجلّها الجديد) — يمنع ضياع درس أو تعديل حُفظ أثناء الدورة
    let final: ApState = s;
    try {
      const fresh = await loadState();
      final = {
        ...fresh,
        positions: s.positions,
        dailySpent: s.dailySpent,
        dailyDate: s.dailyDate,
        sessionStartAt: s.sessionStartAt,
        log: [...fresh.log, ...newLog],
        trades: [...(fresh.trades || []), ...newTrades],
        blocked: [...new Set([...(fresh.blocked || []), ...newBlocked])],
      };
      foldHourStats(final, newTrades); // يطوي صفقات الدورة في خانات الساعة المتراكمة
    } catch {
      s.log = [...s.log, ...newLog];
      s.trades = [...(s.trades || []), ...newTrades];
      s.blocked = [...new Set([...(s.blocked || []), ...newBlocked])];
      foldHourStats(s, newTrades);
      final = s;
    }
    final.lastRunAt = new Date().toISOString();
    await saveState(final);
  }

  return { ran: true, actions };
}

// ============ الإقفال اليومي: 23:00 السعودية ============
// يغلق كل مراكز البوت سوقاً، يستخلص دروس اليوم من AI، يسجّل ملخّص اليوم، ويبدأ نظيفاً
async function getDailyLessons(trades: ClosedTrade[]): Promise<string[]> {
  if (!trades.length) return [];
  const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0).length;
  const system =
    "أنت «المضارب الآلي» تراجع صفقات يومك بصدق لتتعلّم منها وتتحسّن غداً. " +
    "استخلص دروساً عملية محددة قابلة للتطبيق (لا كلام عام مثل «كن حذراً») — مثل: أنماط دخول أو عملات تخسر لديك، أو قواعد توقيت. أجب بـJSON فقط بالعربية.";
  const userContent =
    `صفقات اليوم (${trades.length} صفقة، رابحة ${wins}):\n` +
    JSON.stringify(
      trades.map((t) => ({
        عملة: t.symbol,
        ربح_نسبة: t.pnlPct,
        ثقة_الدخول: t.entryConfidence,
        سبب_الخروج: t.exitReason,
      }))
    ) +
    `\n\nاستخلص 1-3 دروس موجزة عملية بالعربية من نتائج اليوم. أعد JSON حصراً: {"lessons":["درس موجز قابل للتطبيق"]}`;
  const { text } = await callAi(system, userContent);
  if (!text) return [];
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const j = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    return Array.isArray(j.lessons)
      ? j.lessons.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export interface DailyResult {
  ran: boolean;
  closed: number;
  realizedUsdt: number;
  lessons: string[];
  note: string;
}

export async function runDailyClose(): Promise<DailyResult> {
  const s = await loadState();
  if (!isConfigured()) return { ran: false, closed: 0, realizedUsdt: 0, lessons: [], note: "حساب غير مربوط" };

  const closed: ClosedTrade[] = [];

  // 1) أغلق كل مراكز البوت المفتوحة سوقاً
  if (s.positions.length) {
    // ألغِ كل أوامر OCO أولاً لتتحرّر الكميات المحتجَزة قبل البيع السوقي
    for (const pos of s.positions) {
      if (pos.ocoListId) {
        try {
          await cancelOcoList(pos.symbol, pos.ocoListId);
        } catch {
          /* ربما نُفِّذ أو أُلغي مسبقاً */
        }
        pos.ocoListId = undefined;
        pos.ocoOrders = undefined;
      }
    }
    let acc;
    try {
      acc = await getAccountInfo(); // بعد الإلغاء تعكس الأرصدة الكميات المتحرّرة
    } catch {
      acc = null;
    }
    for (const pos of [...s.positions]) {
      try {
        const info = await getSymbolInfo(pos.symbol);
        const free = acc?.balances.find((b) => b.asset === info.baseAsset)?.free ?? pos.qty;
        const qty = roundStep(Math.min(pos.qty, free), info.stepSize);
        if (qty <= 0) {
          s.positions = s.positions.filter((p) => p !== pos);
          continue;
        }
        const price = await getPrice(pos.symbol);
        const order = await placeOrder({ symbol: pos.symbol, side: "SELL", type: "MARKET", quantity: qty });
        const exec = parseFloat(order.executedQty || String(qty)) || qty;
        const exit = fillPrice(order, price, exec); // سعر البيع الفعلي المنفَّذ
        const r = netRealized(pos.entry, exit, exec); // صافٍ بعد الرسوم
        closed.push({
          symbol: pos.symbol,
          entry: pos.entry,
          exit: +exit.toFixed(8),
          qty: exec,
          pnlUsdt: r.pnlUsdt,
          pnlPct: r.pnlPct,
          feesUsdt: r.feesUsdt,
          openedAt: pos.openedAt,
          closedAt: new Date().toISOString(),
          exitReason: "إقفال يومي",
          entryConfidence: confFromReason(pos.reason),
          entryReason: pos.reason,
        });
        s.positions = s.positions.filter((p) => p !== pos);
      } catch (e) {
        s.log.push({
          t: new Date().toISOString(),
          level: "error",
          msg: `إقفال يومي ${pos.symbol}: ${String((e as Error).message).slice(0, 100)}`,
        });
      }
    }
  }
  s.trades = [...(s.trades || []), ...closed];
  foldHourStats(s, closed); // تعلّم توقيت إقفالات اليوم أيضاً

  // 2) ربح اليوم المحقق (كل صفقات اليوم بتوقيت الرياض، معروفة النتيجة)
  const today = riyadhDate();
  const todays = s.trades.filter((t) => t.pnlUsdt != null && riyadhDateOf(t.closedAt) === today);
  const realizedUsdt = +todays.reduce((a, t) => a + (t.pnlUsdt || 0), 0).toFixed(2);

  // 3) دروس اليوم من AI (تُلزم قرارات الغد)
  let lessons: string[] = [];
  if (todays.length) {
    try {
      lessons = await getDailyLessons(todays);
    } catch {
      lessons = [];
    }
    for (const l of lessons) s.lessons.push({ t: new Date().toISOString(), text: l });
    s.lessons = s.lessons.slice(-30);
  }

  // 4) سجّل اليوم في التاريخ
  const note = `${closed.length} إقفال، صافي ${realizedUsdt >= 0 ? "+" : ""}${realizedUsdt} USDT`;
  s.dailyHistory = [
    ...(s.dailyHistory || []),
    { date: today, realizedUsdt, closedCount: todays.length, lessons: lessons.length, note },
  ];

  // 5) بداية نظيفة
  s.dailySpent = 0;
  s.dailyDate = new Date().toISOString().slice(0, 10);
  s.log.push({
    t: new Date().toISOString(),
    level: "trade",
    msg: `🌙 إقفال يومي (23:00 السعودية): ${note}${lessons.length ? ` — تعلّم ${lessons.length} درساً` : ""}. المحفظة تبدأ نظيفة.`,
  });
  await saveState(s);

  return { ran: true, closed: closed.length, realizedUsdt, lessons, note };
}
