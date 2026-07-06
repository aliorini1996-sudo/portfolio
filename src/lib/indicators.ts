// حساب المؤشرات الفنية من الأسعار التاريخية
// كل الدوال تعمل على مصفوفة أسعار الإغلاق (الأقدم أولاً)

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      // أول قيمة = متوسط بسيط
      const slice = values.slice(i - period + 1, i + 1);
      prev = slice.reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

// مؤشر القوة النسبية RSI (14 افتراضياً)
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD: خط الماكد وخط الإشارة والهيستوجرام
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: (number | null)[] = values.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? (emaFast[i] as number) - (emaSlow[i] as number) : null
  );
  const macdVals = macdLine.map((v) => (v === null ? 0 : v));
  const signalLineRaw = ema(macdVals, signal);
  const signalLine = macdLine.map((v, i) => (v === null ? null : signalLineRaw[i]));
  const hist = macdLine.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - (signalLine[i] as number) : null
  );
  return { macd: macdLine, signal: signalLine, hist };
}

// آخر قيمة غير فارغة في مصفوفة
export function last(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

export interface TechSummary {
  price: number;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macdHist: number | null;
  trend: "up" | "down" | "sideways";
  signals: { label: string; tone: "bullish" | "bearish" | "neutral" }[];
  score: number; // -100 .. +100 مؤشر تجميعي
}

// تلخيص فني كامل لسهم من أسعاره التاريخية
export function summarize(closes: number[]): TechSummary | null {
  if (closes.length < 30) return null;
  const price = closes[closes.length - 1];
  const s50 = last(sma(closes, 50));
  const s200 = last(sma(closes, 200));
  const r = last(rsi(closes, 14));
  const m = macd(closes);
  const mHist = last(m.hist);

  const signals: TechSummary["signals"] = [];
  let score = 0;

  // اتجاه بناءً على المتوسطات
  let trend: TechSummary["trend"] = "sideways";
  if (s50 !== null) {
    if (price > s50) {
      trend = "up";
      score += 20;
      signals.push({ label: "السعر فوق متوسط 50 يوم", tone: "bullish" });
    } else {
      trend = "down";
      score -= 20;
      signals.push({ label: "السعر تحت متوسط 50 يوم", tone: "bearish" });
    }
  }
  if (s200 !== null) {
    if (price > s200) {
      score += 15;
      signals.push({ label: "السعر فوق متوسط 200 يوم (اتجاه طويل صاعد)", tone: "bullish" });
    } else {
      score -= 15;
      signals.push({ label: "السعر تحت متوسط 200 يوم (اتجاه طويل هابط)", tone: "bearish" });
    }
  }
  if (s50 !== null && s200 !== null) {
    if (s50 > s200) {
      score += 10;
      signals.push({ label: "تقاطع ذهبي: متوسط 50 فوق 200", tone: "bullish" });
    } else {
      score -= 10;
      signals.push({ label: "تقاطع موت: متوسط 50 تحت 200", tone: "bearish" });
    }
  }

  // RSI
  if (r !== null) {
    if (r >= 70) {
      score -= 15;
      signals.push({ label: `RSI = ${r.toFixed(0)} (تشبّع شرائي — احتمال تصحيح)`, tone: "bearish" });
    } else if (r <= 30) {
      score += 15;
      signals.push({ label: `RSI = ${r.toFixed(0)} (تشبّع بيعي — احتمال ارتداد)`, tone: "bullish" });
    } else {
      signals.push({ label: `RSI = ${r.toFixed(0)} (منطقة محايدة)`, tone: "neutral" });
    }
  }

  // MACD
  if (mHist !== null) {
    if (mHist > 0) {
      score += 15;
      signals.push({ label: "MACD إيجابي (زخم صاعد)", tone: "bullish" });
    } else {
      score -= 15;
      signals.push({ label: "MACD سلبي (زخم هابط)", tone: "bearish" });
    }
  }

  score = Math.max(-100, Math.min(100, score));

  return { price, sma50: s50, sma200: s200, rsi14: r, macdHist: mHist, trend, signals, score };
}

// ==================== امتدادات تحليل الكريبتو (شموع متعددة الأُطر) ====================

export interface Candle {
  t: number; // وقت الفتح (ms)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// نطاقات بولينجر (20، 2σ) — يعيد موقع السعر داخل النطاق واتساعه
export function bollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const price = closes[closes.length - 1];
  return {
    upper,
    mid,
    lower,
    percentB: upper === lower ? 0.5 : (price - lower) / (upper - lower),
    width: mid ? (upper - lower) / mid : 0,
  };
}

// متوسط المدى الحقيقي ATR بتمهيد وايلدر — مقياس تقلّب لاقتراح وقف الخسارة
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// دعم/مقاومة من أدنى قاع وأعلى قمة في آخر نافذة شموع
export function supportResistance(candles: Candle[], window = 30) {
  const slice = candles.slice(-window);
  if (!slice.length) return { support: null as number | null, resistance: null as number | null };
  return {
    support: Math.min(...slice.map((c) => c.l)),
    resistance: Math.max(...slice.map((c) => c.h)),
  };
}

// نسبة التغيّر عبر آخر n شمعة
export function changePct(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const then = closes[closes.length - 1 - n];
  return then ? ((closes[closes.length - 1] - then) / then) * 100 : null;
}

// كشف تقاطع MACD في آخر شمعتين
export function macdCross(closes: number[]): "bullish" | "bearish" | "none" {
  const { macd: line, signal } = macd(closes);
  const pts: { l: number; s: number }[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (line[i] !== null && signal[i] !== null) pts.push({ l: line[i] as number, s: signal[i] as number });
  }
  if (pts.length < 2) return "none";
  const prev = pts[pts.length - 2];
  const cur = pts[pts.length - 1];
  if (prev.l <= prev.s && cur.l > cur.s) return "bullish";
  if (prev.l >= prev.s && cur.l < cur.s) return "bearish";
  return "none";
}
