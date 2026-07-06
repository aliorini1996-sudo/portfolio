import { NextResponse } from "next/server";
import { requirePin } from "@/lib/auth";
import {
  getAccountInfo,
  getAllPrices,
  getSymbolInfo,
  placeOrder,
  cancelOcoList,
  roundStep,
  isConfigured,
} from "@/lib/binance";
import { loadState, saveState, blobReady, netRealized, ClosedTrade } from "@/lib/autopilot";

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 120;

const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD"]);

// POST — التصفية الشاملة: بيع كل العملات غير المستقرة سوقاً والبدء من جديد بالدستور
// محمي بـ PIN (فعل حسّاس يدوي فقط — لا يستدعيه أي جدول)
export async function POST() {
  const denied = await requirePin();
  if (denied) return denied;
  if (!isConfigured()) return NextResponse.json({ error: "حساب Binance غير مربوط" }, { status: 400 });
  if (!blobReady()) return NextResponse.json({ error: "تخزين Blob غير مجهّز" }, { status: 503 });

  const s = await loadState();

  // ألغِ كل أوامر OCO المحتجِزة للكميات أولاً كي يتمكّن البيع السوقي من تصفية كل شيء
  for (const pos of s.positions || []) {
    if (pos.ocoListId) {
      try {
        await cancelOcoList(pos.symbol, pos.ocoListId);
      } catch {
        /* ربما نُفِّذ أو أُلغي مسبقاً */
      }
    }
  }

  const [acc, prices] = await Promise.all([getAccountInfo(), getAllPrices()]);

  const sold: string[] = [];
  const skipped: string[] = [];
  const newTrades: ClosedTrade[] = [];

  for (const b of acc.balances) {
    if (STABLES.has(b.asset)) continue;
    const symbol = `${b.asset}USDT`;
    const price = prices[symbol];
    if (!price) {
      skipped.push(`${b.asset}: لا يوجد زوج ${symbol}`);
      continue;
    }
    try {
      const info = await getSymbolInfo(symbol);
      const qty = roundStep(b.free, info.stepSize);
      const value = qty * price;
      if (qty <= 0) {
        skipped.push(`${b.asset}: كمية غير قابلة للبيع`);
        continue;
      }
      if (info.minNotional && value < info.minNotional) {
        skipped.push(`${b.asset}: قيمة ~${value.toFixed(2)}$ تحت الحد الأدنى (${info.minNotional}) — غبار يتعذّر بيعه`);
        continue;
      }

      const botPos = s.positions.find((p) => p.symbol === symbol);
      const order = await placeOrder({ symbol, side: "SELL", type: "MARKET", quantity: qty });

      // متوسط سعر التنفيذ الفعلي
      const fills = (order.fills || []) as { price: string; qty: string }[];
      const execQty = parseFloat(order.executedQty || String(qty)) || qty;
      const exitPrice =
        fills.length && execQty
          ? fills.reduce((sum, f) => sum + parseFloat(f.price) * parseFloat(f.qty), 0) / execQty
          : price;

      const entryKnown = botPos ? botPos.entry : null;
      const r = entryKnown != null ? netRealized(entryKnown, exitPrice, execQty) : null; // صافٍ بعد الرسوم
      newTrades.push({
        symbol,
        entry: entryKnown,
        exit: +exitPrice.toFixed(8),
        qty: execQty,
        pnlUsdt: r ? r.pnlUsdt : null,
        pnlPct: r ? r.pnlPct : null,
        feesUsdt: r ? r.feesUsdt : undefined,
        openedAt: botPos ? botPos.openedAt : null,
        closedAt: new Date().toISOString(),
        exitReason: "تصفية شاملة (بدء من جديد)",
        entryConfidence: null,
        entryReason: botPos ? botPos.reason : "أصل مملوك — تصفية شاملة بأمر المستخدم",
      });
      sold.push(`${b.asset}: بيع ${execQty} بـ~${value.toFixed(2)}$ (أمر #${order.orderId})`);
    } catch (e) {
      skipped.push(`${b.asset}: فشل البيع — ${String((e as Error).message).slice(0, 100)}`);
    }
  }

  // تحديث الحالة: امسح المراكز، سجّل الصفقات والحدث، صفّر عدّاد اليوم للبدء نظيفاً
  s.positions = [];
  s.trades = [...(s.trades || []), ...newTrades];
  s.dailySpent = 0;
  s.dailyDate = new Date().toISOString().slice(0, 10);
  s.log.push({
    t: new Date().toISOString(),
    level: "trade",
    msg: `🧹 تصفية شاملة بأمر المستخدم: بيع ${sold.length} أصل${skipped.length ? `، تعذّر ${skipped.length}` : ""} — تبدأ المحفظة من جديد بالدستور.`,
  });
  await saveState(s);

  return NextResponse.json({ ok: true, soldCount: sold.length, sold, skipped });
}
