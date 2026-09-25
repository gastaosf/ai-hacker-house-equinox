// x402-paid market data. Prices are DEMO DATA; the payment is a real testnet settlement.
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { getFacilitator, NETWORK, X402_VERSION } from "@/lib/x402";
import { PRICE_TUSDC, STROOPS } from "@/lib/contracts";

const PRICE_STROOPS = String(PRICE_TUSDC * STROOPS);

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: process.env.NEXT_PUBLIC_TUSDC!,
    payTo: process.env.MERCHANT_ADDRESS!,
    amount: PRICE_STROOPS,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

// Demo data: plausible reference prices with a small wobble. The product here is the payment, not the data.
const BASE: Record<string, number> = {
  XLM: 0.39, BTC: 112000, ETH: 4300, SOL: 215, AQUA: 0.0011, USDC: 1, EURC: 1.17, PYUSD: 1,
  ADA: 0.82, DOT: 4.1, LINK: 22.5, AVAX: 30.2,
};
function demoQuote(symbol: string) {
  const seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const stable = ["USDC", "PYUSD", "EURC"].includes(symbol);
  const wobble = stable ? ((seed % 7) - 3) / 10000 : ((seed % 600) - 300) / 10000;
  const base = BASE[symbol] ?? 1 + (seed % 5000) / 100;
  const price = base * (1 + wobble);
  return {
    symbol,
    price: Number(price.toPrecision(price < 1 ? 3 : 6)),
    change24h: `${(stable ? wobble * 100 : ((seed % 1200) - 600) / 100).toFixed(2)}%`,
    source: "demo data",
  };
}

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").toUpperCase().slice(0, 12);
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });

  const header = req.headers.get("PAYMENT-SIGNATURE");
  if (!header) {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      error: "payment required",
      resource: { url: req.url, description: `Quote for ${symbol}`, mimeType: "application/json" },
      accepts: [requirements()],
    };
    return Response.json(body, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) } });
  }

  const payload = decodePaymentSignatureHeader(header);
  const facilitator = getFacilitator();
  const verified = await facilitator.verify(payload, requirements());
  if (!verified.isValid) return Response.json({ error: verified.invalidReason }, { status: 402 });
  const settled = await facilitator.settle(payload, requirements());
  if (!settled.success) return Response.json({ error: settled.errorReason }, { status: 402 });

  return Response.json(demoQuote(symbol), { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) } });
}
