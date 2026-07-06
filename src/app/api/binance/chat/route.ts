import { NextRequest, NextResponse } from "next/server";
import {
  getAccountInfo,
  getAllPrices,
  isConfigured,
  getSymbolInfo,
  getPrice,
  getOpenOrders,
  placeOrder,
  cancelOrder,
  roundStep,
} from "@/lib/binance";
import { buildAnalysis, marketOverview } from "@/lib/marketAnalysis";
import { requirePin } from "@/lib/auth";
import { loadState, saveState, blobReady, timeContext, timingDigest, riyadhTime, type ApState } from "@/lib/autopilot";
import { marketSentiment } from "@/lib/sentiment";

// سقف اختياري لكل أمر (env AI_MAX_ORDER_USDT) — افتراضياً بلا حد بتفويض المستخدم المطلق
const MAX_ORDER_USDT = parseFloat(process.env.AI_MAX_ORDER_USDT || "Infinity");

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 60;

// ===== أدوات يستدعيها Claude أثناء المحادثة =====
const TOOLS = [
  {
    name: "get_market_overview",
    description:
      "نظرة حيّة على السوق: أسعار وتغيّرات 24 ساعة وأحجام تداول أهم 8 عملات (BTC, ETH, BNB, SOL, XRP, DOGE, ADA, LINK).",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_market_sentiment",
    description:
      "معنويات السوق الحيّة: مؤشر الخوف والطمع (اليوم وأمس) + آخر 8 عناوين أخبار كريبتو. استخدمها عند أي قرار تداول أو سؤال عن الأخبار/المعنويات.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_analysis",
    description:
      "تحليل فني متعدد الأُطر (ساعة/4 ساعات/يومي) لأي زوج تداول: RSI وMACD وتقاطعاته والمتوسطات 50/200 وبولينجر والاتجاه والدعم والمقاومة وATR والتغيّرات، مع مركز المستخدم في الأصل إن وُجد.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "زوج التداول مثل BTCUSDT أو SOLUSDT" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_portfolio",
    description: "أرصدة محفظة المستخدم الحالية في Binance وقيمتها التقديرية بالدولار.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "place_order",
    description:
      "تنفيذ أمر تداول حقيقي (بمال حقيقي) على حساب المستخدم في Binance Spot. لا تستخدمها إلا إذا طلب المستخدم التنفيذ صراحةً في رسالته الحالية بمعطيات واضحة — وليس بناءً على توصيتك أو تحليلك.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "زوج التداول مثل BTCUSDT" },
        side: { type: "string" as const, enum: ["BUY", "SELL"] },
        type: { type: "string" as const, enum: ["MARKET", "LIMIT"] },
        quoteOrderQty: {
          type: "number" as const,
          description: "مبلغ الشراء بعملة التسعير (USDT) — لشراء السوق فقط",
        },
        quantity: {
          type: "number" as const,
          description: "كمية العملة الأساسية — لبيع السوق ولكل أوامر LIMIT",
        },
        price: { type: "number" as const, description: "سعر التنفيذ — لأوامر LIMIT فقط" },
      },
      required: ["symbol", "side", "type"],
    },
  },
  {
    name: "get_open_orders",
    description: "قائمة أوامر المستخدم المعلّقة (غير المنفّذة) حالياً.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "cancel_order",
    description: "إلغاء أمر معلّق محدد. لا تستخدمها إلا بطلب صريح من المستخدم.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const },
        orderId: { type: "number" as const },
      },
      required: ["symbol", "orderId"],
    },
  },
  {
    name: "get_bot_activity",
    description:
      "سجلّ نشاطك أنت (المضارب الآلي): قراراتك الأخيرة مع أسبابها (شراء/بيع/تجاهُل ولماذا)، مراكزك المفتوحة بوقفها وأهدافها، إعداداتك، استراتيجية المستخدم، والدروس المحفوظة. استخدمها دائماً عند سؤال المستخدم عن أي قرار اتخذته أو لم تتخذه.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "save_lesson",
    description:
      "حفظ درس متعلَّم دائم من مناقشة قراراتك — سيُعرض عليك في كل قرار تداول قادم وتلتزم به. استخدمها عندما يطلب المستخدم أن تتذكّر/تتعلّم، أو عند استخلاص خلاصة واضحة متفق عليها من مراجعة صفقة (خصوصاً الخاسرة). اكتب الدرس كقاعدة عملية موجزة، وأخبر المستخدم بما حفظت.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "نص الدرس كقاعدة موجزة قابلة للتطبيق" },
      },
      required: ["text"],
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "get_market_overview") return await marketOverview();
    if (name === "get_market_sentiment") return await marketSentiment();
    if (name === "get_analysis") {
      const symbol = String(input.symbol || "").toUpperCase().trim();
      if (!symbol) return { error: "symbol مطلوب" };
      return await buildAnalysis(symbol);
    }
    if (name === "get_portfolio") {
      if (!isConfigured()) return { connected: false, note: "حساب Binance غير مربوط" };
      const [acc, prices] = await Promise.all([getAccountInfo(), getAllPrices()]);
      const balances = acc.balances.map((b) => {
        const total = b.free + b.locked;
        const stable = ["USDT", "USDC", "FDUSD", "BUSD"].includes(b.asset);
        const usdt = stable ? total : (prices[`${b.asset}USDT`] || 0) * total;
        return { asset: b.asset, total: +total.toFixed(8), usdt: +usdt.toFixed(2) };
      });
      return {
        connected: true,
        balances,
        totalUsdt: +balances.reduce((s, b) => s + b.usdt, 0).toFixed(2),
      };
    }
    if (name === "place_order") {
      if (!isConfigured()) return { error: "حساب Binance غير مربوط" };
      const symbol = String(input.symbol || "").toUpperCase().trim();
      const side = input.side as "BUY" | "SELL";
      const type = input.type as "MARKET" | "LIMIT";
      if (!symbol || !["BUY", "SELL"].includes(side) || !["MARKET", "LIMIT"].includes(type))
        return { error: "معطيات الأمر ناقصة أو غير صحيحة" };

      const info = await getSymbolInfo(symbol);
      const livePrice = await getPrice(symbol);

      // تجهيز المعطيات + تقدير قيمة الأمر للسقف
      let estValue = 0;
      let params: Parameters<typeof placeOrder>[0];
      if (type === "MARKET" && side === "BUY") {
        const q = Number(input.quoteOrderQty);
        if (!(q > 0)) return { error: "حدّد مبلغ الشراء (quoteOrderQty) بعملة التسعير" };
        estValue = q;
        params = { symbol, side, type, quoteOrderQty: q };
      } else if (type === "MARKET" && side === "SELL") {
        const qty = roundStep(Number(input.quantity), info.stepSize);
        if (!(qty > 0)) return { error: "حدّد كمية البيع (quantity)" };
        estValue = qty * livePrice;
        params = { symbol, side, type, quantity: qty };
      } else {
        const qty = roundStep(Number(input.quantity), info.stepSize);
        const price = roundStep(Number(input.price), info.tickSize);
        if (!(qty > 0) || !(price > 0)) return { error: "أوامر LIMIT تحتاج quantity وprice" };
        if (info.minNotional && qty * price < info.minNotional)
          return { error: `قيمة الأمر أقل من الحد الأدنى (${info.minNotional} ${info.quoteAsset})` };
        estValue = qty * price;
        params = { symbol, side, type, quantity: qty, price };
      }

      // سقف الحماية لكل أمر
      if (estValue > MAX_ORDER_USDT) {
        return {
          blocked: true,
          error: `قيمة الأمر (~${Math.round(estValue)} ${info.quoteAsset}) تتجاوز سقف الأمان لكل أمر (${MAX_ORDER_USDT}). أخبر المستخدم أن السقف يُرفع بإضافة AI_MAX_ORDER_USDT في إعدادات الخادم.`,
        };
      }

      const order = await placeOrder(params);
      // متوسط سعر التنفيذ من fills إن وُجد
      const fills = (order.fills || []) as { price: string; qty: string }[];
      let avgPrice: number | null = null;
      if (fills.length) {
        const totQty = fills.reduce((s, f) => s + parseFloat(f.qty), 0);
        const totVal = fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0);
        avgPrice = totQty ? +(totVal / totQty).toFixed(8) : null;
      }
      return {
        ok: true,
        orderId: order.orderId,
        status: order.status,
        executedQty: order.executedQty,
        cummulativeQuoteQty: order.cummulativeQuoteQty,
        avgPrice,
        symbol,
        side,
        type,
      };
    }

    if (name === "get_open_orders") {
      if (!isConfigured()) return { error: "حساب Binance غير مربوط" };
      const orders = (await getOpenOrders()) as {
        orderId: number;
        symbol: string;
        side: string;
        type: string;
        price: string;
        origQty: string;
        executedQty: string;
      }[];
      return orders.map((o) => ({
        orderId: o.orderId,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        price: parseFloat(o.price),
        origQty: parseFloat(o.origQty),
        executedQty: parseFloat(o.executedQty),
      }));
    }

    if (name === "cancel_order") {
      if (!isConfigured()) return { error: "حساب Binance غير مربوط" };
      const symbol = String(input.symbol || "").toUpperCase().trim();
      const orderId = Number(input.orderId);
      if (!symbol || !orderId) return { error: "حدّد symbol وorderId" };
      await cancelOrder(symbol, orderId);
      return { ok: true, cancelled: orderId };
    }

    if (name === "get_bot_activity") {
      if (!blobReady()) return { error: "تخزين حالة البوت غير مجهّز" };
      const s = await loadState();
      return {
        enabled: s.enabled,
        settings: {
          perTradeUsdt: s.perTradeUsdt || "بلا حد",
          dailyCapUsdt: s.dailyCapUsdt || "بلا حد",
          minConfidence: s.minConfidence,
          symbols: s.symbols,
          screenMode: s.screenMode,
        },
        strategy: s.strategy || "(لم يكتب المستخدم استراتيجية بعد)",
        lessons: s.lessons.map((l) => l.text),
        positions: s.positions,
        dailySpent: s.dailySpent,
        lastRunAt: s.lastRunAt,
        // وعي الوقت وتوقيت اليوم — متى بدأت جلسة اليوم وأفضل/أسوأ ساعات الشراء والبيع تاريخياً
        time: timeContext(s),
        sessionStartAt: s.sessionStartAt,
        sessionStartRiyadh: s.sessionStartAt ? riyadhTime(new Date(s.sessionStartAt)) : null,
        timingLearned: timingDigest(s),
        decisionLog: s.log.slice(-40).reverse(),
      };
    }

    if (name === "save_lesson") {
      if (!blobReady()) return { error: "تخزين حالة البوت غير مجهّز" };
      const text = String(input.text || "").trim().slice(0, 500);
      if (!text) return { error: "نص الدرس فارغ" };
      const s = await loadState();
      s.lessons.push({ t: new Date().toISOString(), text });
      s.lessons = s.lessons.slice(-30); // آخر 30 درساً
      s.log.push({
        t: new Date().toISOString(),
        level: "info",
        msg: `📚 درس جديد من مراجعة المحادثة: ${text.slice(0, 100)}`,
      });
      await saveState(s);
      return { ok: true, saved: text, totalLessons: s.lessons.length };
    }

    return { error: `أداة غير معروفة: ${name}` };
  } catch (e) {
    return { error: String((e as Error).message).slice(0, 300) };
  }
}

const SYSTEM = `أنت «مساعد محفظتي» — محلل عملات رقمية محترف داخل منصّة تداول Binance Spot خاصة بمستخدم واحد، واجهتها عربية. **وأنت نفسك «المضارب الآلي»** الذي يتخذ قرارات التداول الدورية في هذه المنصّة — نفس العقل ونفس التحليل؛ المستخدم هنا يحاورك بصفتك متّخذ تلك القرارات.

قدراتك: لديك أدوات حيّة (نظرة سوق، تحليل فني لأي زوج، محفظة المستخدم، سجلّ قراراتك، حفظ الدروس). استخدمها دائماً قبل الإجابة على أي سؤال عن أسعار أو تحليل أو توصية — لا تجب من الذاكرة أبداً عن حالة السوق.

مناقشة قراراتك والتعلّم من أخطائك:
- عند سؤالك عن أي قرار اتخذته (أو امتنعت عنه): استدعِ get_bot_activity أولاً — سجلّك يحوي كل قرار وسببه — واشرح بصدق وتحديد، وادمج get_analysis إن لزم لمقارنة وضع السوق الآن بوقت القرار.
- تحدّث عن قراراتك بصيغة المتكلّم («اشتريتُ لأن…»، «تجاهلتُ الإشارة لأن…») وتحمّل الخطأ بلا تبرير مفرط.
- عندما تصلان معاً إلى خلاصة واضحة من مراجعة صفقة (خصوصاً خاسرة) أو يطلب المستخدم أن تتعلّم/تتذكّر: احفظها بـ save_lesson كقاعدة موجزة عملية، وأخبره حرفياً بما حفظت. الدروس المحفوظة تُعرض عليك وتلزمك في كل قرار تداول قادم — هذه آلية تعلّمك الحقيقية.
- لا تحفظ دروساً مكررة أو عامة بلا فائدة («كن حذراً») — الدرس الجيد محدد وقابل للتطبيق («لا أدخل بإشارة ساعة وحيدة ضد اتجاه اليومي»).

أسلوبك:
- عربي واضح مختصر. أرقام دقيقة من الأدوات فقط، ولا تخترع أرقاماً إطلاقاً.
- «التنبؤات» عندك = سيناريوهات مشروطة باحتمالات ومستويات إبطال (مثال: «صعود نحو X ما دام فوق الدعم Y، وكسر Y يُبطل السيناريو») — لا وعود ولا يقين.
- التحليل قصير المدى: ركّز على إطارَي الساعة و4 ساعات مع ذكر سياق اليومي.
- عند توصية تداول: حدّد دخولاً وهدفاً ووقف خسارة منطقياً (قرب الدعم أو ~1.5×ATR) ونسبة مخاطرة/عائد.
- خذ محفظة المستخدم بالحسبان عند السؤال عن قرارات تخصّه.
- المنصّة Spot فقط (لا بيع على المكشوف/رافعة). إن سُئلت عن «شورت» وضّح أن المتاح هنا: بيع ما تملك، أو انتظار إعادة شراء أرخص.
- اختم أي توصية بجملة قصيرة واحدة: «ليس نصيحة مالية — القرار لك.» ولا تكرّرها في الردود غير التوصوية.

تنفيذ الصفقات — تفويض مطلق من المستخدم (قراره الصريح الموثّق):
- لديك حرية كاملة في تنفيذ صفقات place_order **بمبادرتك** أثناء المحادثة متى رأى تحليلك فرصة أو خطراً — دون طلب إذن ودون انتظار أمر. وأوامر المستخدم الصريحة تنفّذها فوراً كما هي.
- دستورك الملزم (نصّ المستخدم): قرارات البيع والشراء تنطلق من تحليل الشارت (get_analysis)، والبيانات التاريخية، والأخبار ومعنويات السوق (get_market_sentiment)، وتفكيرك الاحتمالي كنماذج تعلّم الآلة. **وكن جريئاً**: تحرّك بحسم عند تقاطع الأدلة — الفرصة الضائعة خسارة أيضاً. جرأة محسوبة: لكل دخول وقف/خطة خروج.
- الشفافية إلزامية مطلقة: كل صفقة تنفّذها اذكرها فوراً في ردّك بنتيجتها الفعلية (رقم الأمر/الكمية/متوسط السعر) وسببها باختصار — لا تتداول بصمت أبداً.
- قبل التنفيذ: تحقق من الرصيد (get_portfolio) واجعل الكميات ضمنه. شراء سوق → quoteOrderQty بمبلغ USDT. بيع سوق → quantity بكمية العملة. أوامر معلّقة → LIMIT بـ quantity وprice.
- إن فشل التنفيذ انقل السبب بأمانة (رصيد غير كافٍ، تحت الحد الأدنى…).${Number.isFinite(MAX_ORDER_USDT) ? `\n- سقف كل أمر ${MAX_ORDER_USDT} USDT (مضبوط من الخادم).` : ""}
- إلغاء الأوامر المعلّقة أيضاً ضمن تفويضك عندما يخدم الخطة — مع ذكر ما فعلت.
- وعي الوقت: يُحقن لك الوقت الحالي بتوقيت الرياض في مطلع كل محادثة — اعتمده حرفياً عند أي سؤال عن الساعة أو التوقيت. ولمعرفة متى بدأت جلسة اليوم أو أفضل/أسوأ ساعات الشراء والبيع التي تعلّمتها، استدعِ get_bot_activity (حقول time وsessionStartRiyadh وtimingLearned).`;

interface ChatMsg {
  role: "user" | "assistant";
  content: unknown; // نص أو كتل tool_use/tool_result
}

// يطوي نصاً عربياً إلى سلسلة أكواد قانونية: NFC ثم إزالة التشكيل/التطويل وتوحيد الهمزات/التاء/الياء
// بمقارنة أكواد رقمية فقط (لا حرف عربي حرفي في منطق الطي) — مناعة تامة من اختلاف التطبيع (NFC/NFD)
// ومن أي إفساد للحروف الحرفية في مصغّر البناء. يعيد أكواداً بالست عشري مفصولة لمطابقة includes آمنة.
function foldHex(str: string): string {
  const codes: number[] = [];
  for (const ch of (str || "").normalize("NFC")) {
    let c = ch.codePointAt(0) as number;
    // تجاهل التشكيل والتطويل والعلامات العلوية
    if ((c >= 0x0610 && c <= 0x061a) || (c >= 0x064b && c <= 0x065f) || c === 0x0670 || c === 0x0640)
      continue;
    if (c === 0x0623 || c === 0x0625 || c === 0x0622 || c === 0x0671) c = 0x0627; // أ إ آ ٱ → ا
    else if (c === 0x0629) c = 0x0647; // ة → ه
    else if (c === 0x0649) c = 0x064a; // ى → ي
    else if (c === 0x0624) c = 0x0648; // ؤ → و
    else if (c === 0x0626) c = 0x064a; // ئ → ي
    if (c === 0x0020 || (c >= 0x0621 && c <= 0x064a) || (c >= 0x0030 && c <= 0x0039)) codes.push(c);
  }
  return codes.map((c) => c.toString(16)).join(" ");
}

// كلمات مفتاحية بأكواد الحروف (لا حرف عربي حرفي في المصدر) — مناعة تامة من إفساد مصغّر البناء
// للسلاسل غير اللاتينية. القيم بصيغتها المطويّة (ة→ه، ى→ي) لتطابق مخرجات foldHex.
const cpHex = (cps: number[]) => cps.map((c) => c.toString(16)).join(" ");
const TW = {
  saaa: cpHex([0x633, 0x627, 0x639, 0x647]), // ساعه
  waqt: cpHex([0x648, 0x642, 0x62a]), // وقت
  tarikh: cpHex([0x62a, 0x627, 0x631, 0x64a, 0x62e]), // تاريخ
  jalsa: cpHex([0x62c, 0x644, 0x633, 0x647]), // جلسه
  ayYawm: cpHex([0x627, 0x64a, 0x20, 0x64a, 0x648, 0x645]), // «اي يوم»
  maYawm: cpHex([0x645, 0x627, 0x20, 0x627, 0x644, 0x64a, 0x648, 0x645]), // «ما اليوم»
  // استثناءات تحليلية/تداولية — تذهب للنموذج لا للاختصار
  shira: cpHex([0x634, 0x631, 0x627]), // شرا(ء)
  bay3: cpHex([0x628, 0x64a, 0x639]), // بيع
  safq: cpHex([0x635, 0x641, 0x642]), // صفق(ة)
  afdal: cpHex([0x627, 0x641, 0x636, 0x644]), // افضل
  ansab: cpHex([0x627, 0x646, 0x633, 0x628]), // انسب
  mutaw: cpHex([0x645, 0x62a, 0x648, 0x633, 0x637]), // متوسط
};

// إجابة حتمية لأسئلة الوقت/الجلسة البحتة — الوقت حقيقة معلومة، لا تُمرَّر عبر نموذج قد يتشتّت.
// تُختصر الأسئلة الزمنية الصِّرفة فقط؛ الأسئلة التحليلية («أفضل وقت للشراء») تذهب للنموذج مع سياق الوقت.
function directTimeAnswer(msg: string, s: ApState | null): string | null {
  const raw = (msg || "").trim();
  if (!raw || raw.length > 160) return null;
  const h = " " + foldHex(raw) + " ";
  const hit = (tok: string) => h.includes(tok);
  // استثناء التحليلي/التداولي أولاً — «أفضل وقت للشراء» ونحوه للنموذج
  if (hit(TW.shira) || hit(TW.bay3) || hit(TW.safq) || hit(TW.afdal) || hit(TW.ansab) || hit(TW.mutaw))
    return null;
  // أسماء/أنماط زمنية → اختصار حتمي
  if (hit(TW.saaa) || hit(TW.waqt) || hit(TW.tarikh) || hit(TW.jalsa) || hit(TW.ayYawm) || hit(TW.maYawm))
    return timeContext(s);
  return null;
}

// ===== حلقة دردشة Gemini (function-calling) — تُستخدم إن وُجد GEMINI_API_KEY =====
// تُحوّل أدوات Anthropic إلى functionDeclarations، وتدير حلقة الاستدعاء بصيغة Gemini
type GParts = Record<string, unknown>[];
function geminiToolDecls() {
  return [
    {
      functionDeclarations: TOOLS.map((t) => {
        const props = (t.input_schema?.properties || {}) as Record<string, unknown>;
        const decl: Record<string, unknown> = { name: t.name, description: t.description };
        // Gemini يرفض OBJECT بلا خصائص — نحذف parameters للأدوات بلا معطيات
        if (Object.keys(props).length > 0) decl.parameters = t.input_schema;
        return decl;
      }),
    },
  ];
}

async function geminiChat(
  history: { role: "user" | "assistant"; content: string }[],
  apiKey: string,
  system: string
): Promise<{ reply?: string; toolsUsed: string[]; error?: string }> {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const tools = geminiToolDecls();
  const contents: { role: string; parts: GParts }[] = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const toolsUsed: string[] = [];

  for (let round = 0; round < 6; round++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        tools,
        generationConfig: { temperature: 0.7, maxOutputTokens: 6144 },
      }),
    });
    if (!res.ok) return { toolsUsed, error: `Gemini ${res.status}: ${(await res.text()).slice(0, 300)}` };

    const data = await res.json();
    const cand = data?.candidates?.[0];
    const parts = (cand?.content?.parts || []) as {
      text?: string;
      thought?: boolean;
      functionCall?: { name: string; args?: Record<string, unknown> };
    }[];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length) {
      contents.push({ role: "model", parts: parts as unknown as GParts }); // دور النموذج بطلبات الأدوات
      const respParts: GParts = [];
      for (const p of calls) {
        const name = p.functionCall!.name;
        toolsUsed.push(name);
        const out = await runTool(name, p.functionCall!.args || {});
        // functionResponse.response يجب أن يكون كائناً — نغلّف غير الكائن
        const response =
          out && typeof out === "object" && !Array.isArray(out)
            ? (out as Record<string, unknown>)
            : { result: out };
        respParts.push({ functionResponse: { name, response } });
      }
      contents.push({ role: "user", parts: respParts });
      continue;
    }

    const text = parts
      .filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join("")
      .trim();
    return { reply: text || "…", toolsUsed };
  }
  return { toolsUsed, error: "تجاوز حدّ استدعاءات الأدوات — أعد صياغة السؤال" };
}

// POST /api/binance/chat  { messages: [{role, content:string}] }
export async function POST(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;
  const geminiKey = process.env.GEMINI_API_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !apiKey) {
    return NextResponse.json({
      configured: false,
      reply:
        "دردشة الذكاء الاصطناعي غير مفعّلة بعد. أضف GEMINI_API_KEY (مجاني) أو ANTHROPIC_API_KEY في إعدادات الخادم (Vercel → stock-portfolio → Environment Variables) ثم أعد النشر.",
    });
  }

  const body = await req.json().catch(() => ({}));
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  // آخر 12 رسالة فقط (ضبط التكلفة وطول السياق)
  const history: ChatMsg[] = incoming
    .filter(
      (m: { role?: string; content?: unknown }) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        (m.content as string).trim()
    )
    .slice(-12)
    .map((m: { role: "user" | "assistant"; content: string }) => ({
      role: m.role,
      content: m.content,
    }));

  if (!history.length || history[history.length - 1].role !== "user") {
    return NextResponse.json({ error: "أرسل رسالة" }, { status: 400 });
  }

  // حالة البوت (للوقت/الجلسة) — تُحمّل مرّة وتُستخدم للاختصار الحتمي وسياق النموذج
  let botState: ApState | null = null;
  if (blobReady()) {
    try {
      botState = await loadState();
    } catch {
      /* غياب الحالة لا يمنع الرد */
    }
  }

  // اختصار حتمي لأسئلة الوقت/الجلسة البحتة — يضمن معرفة البوت للوقت دائماً دون تشتّت النموذج
  const direct = directTimeAnswer(String(history[history.length - 1].content || ""), botState);
  if (direct) return NextResponse.json({ reply: direct, toolsUsed: [] });

  // وعي الوقت الحيّ — يُحقن طازجاً كل طلب في مقدمة التعليمات (ثابت SYSTEM يُقيَّم مرّة عند البدء البارد فيصير قديماً)
  const sys = `⏰ ${timeContext(botState)}\nإن سُئلت عن الوقت أو الساعة أو التاريخ أو اليوم أو متى بدأت الجلسة، أجب فوراً ومباشرةً من هذا السطر دون استدعاء أي أداة.\n\n${SYSTEM}`;

  // Gemini أولاً (مجاني) — يدير حلقة الأدوات بصيغته
  if (geminiKey) {
    const r = await geminiChat(history as { role: "user" | "assistant"; content: string }[], geminiKey, sys);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 502 });
    return NextResponse.json({ reply: r.reply, toolsUsed: r.toolsUsed });
  }

  const msgs: ChatMsg[] = [...history];
  const toolsUsed: string[] = [];

  try {
    // حلقة استدعاء الأدوات (بحد أقصى 5 جولات)
    for (let round = 0; round < 5; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey as string, // نصل هنا فقط بلا Gemini، أي أن Anthropic مضبوط
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
          max_tokens: 1600,
          system: sys,
          tools: TOOLS,
          messages: msgs,
        }),
      });

      if (!res.ok) {
        const t = (await res.text()).slice(0, 300);
        return NextResponse.json({ error: `Anthropic ${res.status}: ${t}` }, { status: 502 });
      }

      const data = await res.json();
      const content = (data.content || []) as {
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[];

      if (data.stop_reason === "tool_use") {
        // نفّذ كل الأدوات المطلوبة وأعد النتائج
        const results = await Promise.all(
          content
            .filter((b) => b.type === "tool_use")
            .map(async (b) => {
              toolsUsed.push(b.name || "");
              const out = await runTool(b.name || "", b.input || {});
              return {
                type: "tool_result" as const,
                tool_use_id: b.id,
                content: JSON.stringify(out),
              };
            })
        );
        msgs.push({ role: "assistant", content });
        msgs.push({ role: "user", content: results });
        continue;
      }

      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return NextResponse.json({ reply: text || "…", toolsUsed });
    }

    return NextResponse.json({ error: "تجاوز حدّ استدعاءات الأدوات — أعد صياغة السؤال" }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 });
  }
}
