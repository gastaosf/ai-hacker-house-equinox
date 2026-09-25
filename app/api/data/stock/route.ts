// x402-paid stock quote. Live data from Finnhub; the payment is a real testnet settlement.
import { getJson, paywall } from "@/lib/x402";

async function quote(symbol: string) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY missing");
  const q = await getJson<{ c: number; dp: number | null }>(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (!q.c) return null; // Finnhub answers unknown tickers with zeros
  const change = `${(q.dp ?? 0) >= 0 ? "+" : ""}${(q.dp ?? 0).toFixed(2)}%`;
  return { symbol, price: q.c, change, summary: `$${q.c.toLocaleString("en-US")} (${change})`, source: "Finnhub" };
}

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").toUpperCase().slice(0, 12);
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
  return paywall(req, "stock", `Stock quote for ${symbol}`, () => quote(symbol));
}
