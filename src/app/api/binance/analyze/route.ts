import { NextRequest, NextResponse } from "next/server";
import { BinanceError } from "@/lib/binance";
import { buildAnalysis } from "@/lib/marketAnalysis";
import { getAiVerdict } from "@/lib/aiVerdict";
import { requirePin } from "@/lib/auth";

export const runtime = "nodejs";
export const preferredRegion = "fra1";
export const maxDuration = 60; // استدعاء Claude قد يستغرق

// GET /api/binance/analyze?symbol=BTCUSDT
export async function GET(req: NextRequest) {
  const denied = await requirePin();
  if (denied) return denied;

  const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol مطلوب" }, { status: 400 });

  try {
    const analysis = await buildAnalysis(symbol);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const { ai, error: aiError } = apiKey
      ? await getAiVerdict(analysis)
      : { ai: null, error: null };

    return NextResponse.json({
      ...analysis,
      generatedAt: new Date().toISOString(),
      aiEnabled: Boolean(apiKey),
      ai,
      aiError,
    });
  } catch (e) {
    const err = e as BinanceError;
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
