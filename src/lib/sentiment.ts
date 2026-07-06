// معنويات السوق والأخبار — مصادر مجانية بلا مفاتيح
// Fear & Greed من alternative.me + عناوين الأخبار من RSS (CoinDesk ثم Cointelegraph احتياطاً)

export interface MarketMood {
  fearGreed: { value: number; label: string } | null;
  fearGreedYesterday: { value: number; label: string } | null;
  headlines: string[];
}

export async function marketSentiment(): Promise<MarketMood> {
  const mood: MarketMood = { fearGreed: null, fearGreedYesterday: null, headlines: [] };

  // مؤشر الخوف والطمع (اليوم وأمس لاتجاه المعنويات)
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=2", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const d = (j?.data || []) as { value: string; value_classification: string }[];
      if (d[0]) mood.fearGreed = { value: +d[0].value, label: d[0].value_classification };
      if (d[1]) mood.fearGreedYesterday = { value: +d[1].value, label: d[1].value_classification };
    }
  } catch {
    /* غير معطِّل */
  }

  // عناوين الأخبار — أهم 8
  const feeds = [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
  ];
  for (const url of feeds) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "field-sales-portfolio/1.0" },
      });
      if (!r.ok) continue;
      const xml = await r.text();
      let titles = [...xml.matchAll(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/g)].map((m) => m[1]);
      if (titles.length < 3)
        titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) =>
          m[1].replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        );
      // أول عنوان عادة اسم الموقع نفسه
      mood.headlines = titles.slice(1, 9).map((t) => t.trim()).filter(Boolean);
      if (mood.headlines.length) break;
    } catch {
      /* جرّب المصدر التالي */
    }
  }

  return mood;
}
