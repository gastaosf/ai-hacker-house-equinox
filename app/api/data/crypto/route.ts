// x402-paid crypto quote. Live data from CoinGecko; the payment is a real testnet settlement.
import { getJson, paywall } from "@/lib/x402";

// ponytail: common symbols skip the /search round trip
const IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", XLM: "stellar", SOL: "solana", USDC: "usd-coin", EURC: "euro-coin",
  PYUSD: "paypal-usd", ADA: "cardano", DOT: "polkadot", LINK: "chainlink", AVAX: "avalanche-2", AQUA: "aquarius",
};
const CG = "https://api.coingecko.com/api/v3";

async function quote(symbol: string) {
  const id = IDS[symbol] ?? (await getJson<{ coins: { id: string; symbol: string }[] }>(`${CG}/search?query=${encodeURIComponent(symbol)}`))
    .coins.find((c) => c.symbol.toUpperCase() === symbol)?.id;
  if (!id) return null;
  const r = await getJson<Record<string, { usd: number; usd_24h_change: number }>>(
    `${CG}/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`);
  const p = r[id];
  if (!p) return null;
  const change = `${p.usd_24h_change >= 0 ? "+" : ""}${p.usd_24h_change.toFixed(2)}%`;
  const price = Number(p.usd.toPrecision(p.usd < 1 ? 3 : 6));
  return { symbol, price, change24h: change, summary: `$${price.toLocaleString("en-US")} (${change})`, source: "CoinGecko" };
}

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").toUpperCase().slice(0, 12);
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
  return paywall(req, "crypto", `Crypto quote for ${symbol}`, () => quote(symbol));
}
