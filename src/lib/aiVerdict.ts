// حُكم Claude المنظّم على تحليل فني — مشترك بين مسار /analyze ومحرّك المضاربة الآلية
import type { MarketAnalysis } from "@/lib/marketAnalysis";
import type { MarketMood } from "@/lib/sentiment";

export interface AiVerdict {
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;
  horizon: string;
  entry: number | null;
  targets: number[];
  stopLoss: number | null;
  summary: string;
  reasons: string[];
  risks: string[];
}

// قارئ JSON متسامح — يعالج الأعطاب الشائعة في مخرجات النماذج (أحرف تحكّم داخل النصوص،
// فواصل زائدة، علامات اقتباس ذكية) قبل الاستسلام. يعيد الكائن أو null.
function parseLenientJson(raw: string): unknown | null {
  const attempts: string[] = [raw];

  // إصلاح 1: أحرف التحكّم الحرفية (أسطر/جدولة) داخل النصوص = أشهر سبب لـ«Expected ',' or '}'»
  const noCtrl = raw.replace(/[\x00-\x1F]+/g, " ");
  attempts.push(noCtrl);

  // إصلاح 2: إزالة الفواصل الزائدة قبل } أو ] + توحيد الاقتباس الذكي
  const cleaned = noCtrl
    .replace(/[“”„‟]/g, '"')
    .replace(/,\s*([}\]])/g, "$1");
  attempts.push(cleaned);

  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* جرّب الإصلاح التالي */
    }
  }
  return null;
}

// ===== مزوّدو الذكاء الاصطناعي — Gemini (مجاني) أو Anthropic =====
// كلاهما يعيد نص الرد الخام أو خطأ؛ التحليل موحّد بعدهما
async function callGemini(
  key: string,
  system: string,
  userContent: string
): Promise<{ text: string | null; error: string | null }> {
  // حكم البوت له موديله المستقل (حصة منفصلة عن الدردشة) — 2.5 أخفّ وكافٍ للقرار المنظّم
  const model = process.env.GEMINI_MODEL_BOT || "gemini-2.5-flash";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            // موديلات 3.x «تفكّر» وتستهلك توكنات قبل الجواب — سقف عالٍ يمنع البتر
            maxOutputTokens: 6144,
            responseMimeType: "application/json", // يُلزم مخرجات JSON نظيفة
            temperature: 0.7,
          },
        }),
      }
    );
    if (!res.ok) return { text: null, error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const cand = data?.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") return { text: null, error: "استجابة Gemini مبتورة (MAX_TOKENS)" };
    if (data?.promptFeedback?.blockReason)
      return { text: null, error: `Gemini حجب الطلب: ${data.promptFeedback.blockReason}` };
    // استبعاد أجزاء «التفكير» (thought) — نأخذ نص الجواب فقط
    const text: string = (cand?.content?.parts || [])
      .filter((p: { thought?: boolean }) => !p.thought)
      .map((p: { text?: string }) => p.text || "")
      .join("")
      .trim();
    if (!text) return { text: null, error: "استجابة Gemini فارغة" };
    return { text, error: null };
  } catch (e) {
    return { text: null, error: `Gemini: ${String((e as Error).message).slice(0, 150)}` };
  }
}

async function callAnthropic(
  key: string,
  system: string,
  userContent: string
): Promise<{ text: string | null; error: string | null }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 2500, // لا temperature: موديلات كلود 5 لا تقبله
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) return { text: null, error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    if (data?.stop_reason === "max_tokens") return { text: null, error: "استجابة AI مبتورة (max_tokens)" };
    const text: string = (data?.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text || "")
      .join("\n")
      .trim();
    return { text, error: null };
  } catch (e) {
    return { text: null, error: `Anthropic: ${String((e as Error).message).slice(0, 150)}` };
  }
}

// استدعاء AI موحّد (Gemini أولاً وإلا Anthropic) — يعيد نص الرد الخام. مشترك بين الحكم والدروس
export async function callAi(
  system: string,
  userContent: string
): Promise<{ text: string | null; error: string | null }> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey)
    return { text: null, error: "لا مفتاح AI مضبوط (GEMINI_API_KEY أو ANTHROPIC_API_KEY)" };
  return geminiKey
    ? callGemini(geminiKey, system, userContent)
    : callAnthropic(anthropicKey as string, system, userContent);
}

export async function getAiVerdict(
  analysis: MarketAnalysis,
  strategy?: string,
  lessons?: string[],
  market?: MarketMood,
  performance?: string,
  timing?: string
): Promise<{ ai: AiVerdict | null; error: string | null }> {
  const strategyBlock = strategy?.trim()
    ? "\n\nقواعد المستخدم الإلزامية (استراتيجيته وتجاربه وتحليلاته السابقة) — التزم بها حرفياً، وعند تعارضها مع تقديرك قدِّمها وبيّن ذلك في الأسباب:\n" +
      strategy.trim()
    : "";

  const lessonsBlock = lessons?.length
    ? "\n\nدروس متعلَّمة من مراجعة صفقاتك السابقة (أخطاء لا تُكرَّر — التزم بها):\n" +
      lessons.map((l) => `- ${l}`).join("\n")
    : "";

  // سجلّ أدائك الفعلي — تعلَّم منه: ارفع حذرك حيث تخسر تكراراً، وادعم ثقتك حيث تربح
  const performanceBlock = performance?.trim()
    ? "\n\nأداؤك الحقيقي على صفقاتك المغلقة السابقة (تعلَّم منه فعلياً — إن كانت عملة أو نمط دخول يخسر لديك مراراً فارفع عتبتك فيه أو تجنّبه، وإن كان يربح باطّراد فكن أجرأ فيه؛ هذا سجلّك أنت لا كلام عام):\n" +
      performance.trim()
    : "";

  // وعي الوقت وتعلّم توقيت اليوم — الساعة الآن + أفضل/أسوأ ساعات الدخول والخروج تاريخياً
  const timingBlock = timing?.trim()
    ? "\n\nوعي الوقت وتوقيت اليوم (بتوقيت الرياض) — أنت مضارب سريع (scalping) يستفيد من تذبذب اليوم؛ استعمل هذا: فضّل الدخول في ساعاتك الرابحة تاريخياً وارفع عتبتك أو تجنّب الدخول في ساعاتك الخاسرة، وراقب الساعة الحالية:\n" +
      timing.trim()
    : "";

  const system =
    "أنت «المضارب الآلي» — متداول عملات رقمية محترف **مضارب سريع (scalper)** يدير أموال المستخدم بتفويض كامل ومطلق منه، هدفه اقتناص تذبذب اليوم بصفقات سريعة (دخول وخروج خلال ساعات لا أيام) بأهداف قريبة ووقف ضيّق.\n" +
    "دستورك الملزم (نصّ المستخدم): قرارات البيع والشراء تنطلق من: (1) تحليل الشارت — المؤشرات متعددة الأُطر المعطاة (RSI، MACD وتقاطعاته، المتوسطات 50/200، بولينجر، الدعم/المقاومة، ATR على أُطر قصيرة 5د/15د/ساعة للمضاربة)، (2) البيانات التاريخية — الشموع والتغيّرات المعطاة، (3) الأخبار — العناوين المعطاة في market.headlines، (4) معنويات السوق — مؤشر الخوف والطمع المعطى واتجاهه، (5) توقيت اليوم — ساعاتك الرابحة/الخاسرة تاريخياً، (6) تفكيرك الاحتمالي الذي يوازن كل الأدلة كنماذج تعلّم الآلة.\n" +
    "كن جريئاً وسريعاً: عندما تتقاطع الأدلة تحرّك بحسم — الفرصة الضائعة خسارة، والتردد عيب. اقتنص الزخم قصير المدى ولا تنتظر تأكيدات بطيئة.\n" +
    "الجرأة المحسوبة لا التهور: لكل دخول وقف خسارة ضيّق محدد وأهداف قريبة واقعية، ولا تخترع أرقاماً غير معطاة.\n" +
    "أجب بـJSON فقط دون أي نص خارجه." +
    strategyBlock +
    lessonsBlock +
    performanceBlock +
    timingBlock;

  const userContent =
    `حلّل وأعطِ قرارك:\n${JSON.stringify(market ? { ...analysis, market } : analysis)}\n\n` +
    `أعد JSON بهذه البنية حصراً:\n` +
    `{"recommendation":"BUY|SELL|HOLD","confidence":0-100,"horizon":"قصير|متوسط|طويل",` +
    `"entry":رقم أو null,"targets":[أرقام],"stopLoss":رقم أو null,` +
    `"summary":"جملتان تلخّصان الوضع","reasons":["سبب"],"risks":["خطر"]}\n` +
    `⚠️ إلزامي: كل الحقول النصية (summary وreasons وrisks وhorizon) بالعربية الفصحى حصراً. ممنوع أي لغة أخرى (لا إنجليزية ولا روسية) في قيم JSON.`;

  const { text, error } = await callAi(system, userContent);
  if (error || !text) return { ai: null, error: error || "استجابة فارغة" };

  // النص قد يأتي بأسوار markdown أو نص حوله — نلتقط أول كائن JSON متوازن
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = parseLenientJson(clean.slice(start, end + 1));
    if (parsed) return { ai: parsed as AiVerdict, error: null };
    return { ai: null, error: `JSON غير صالح رغم الإصلاح: ${clean.slice(start, start + 90)}…` };
  }
  return { ai: null, error: `استجابة بلا JSON: ${clean.slice(0, 80)}…` };
}
