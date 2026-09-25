// The agent: Claude tool loop that buys quotes over x402 from a spend-capped smart account.
import OpenAI from "openai";
import { Keypair } from "@stellar/stellar-sdk";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { contractErrorCode, readAllowance, toTusdc } from "./stellar";
import { createSmartAccountPayment } from "./x402";
import { publish, waitForReply } from "./ntfy";

export type AgentEvent =
  | { t: "start"; wallet: string; ruleId: number }
  | { t: "say"; text: string }
  | { t: "call"; symbol: string }
  | { t: "402"; symbol: string; price: number }
  | { t: "paid"; symbol: string; tx: string; quote: unknown }
  | { t: "refused"; symbol: string; code: number | null }
  | { t: "allowance"; limit: number; spent: number }
  | { t: "topup_request"; amount: number; reason: string }
  | { t: "topup_approved"; limit: number }
  | { t: "topup_declined" }
  | { t: "report"; text: string }
  | { t: "error"; text: string }
  | { t: "done" };

export const ASSETS = ["XLM", "BTC", "ETH", "SOL", "AQUA", "USDC", "EURC", "PYUSD", "ADA", "DOT", "LINK", "AVAX"];
const TASK = `Build a short market snapshot for these ${ASSETS.length} assets: ${ASSETS.join(", ")}. Get a quote for every one of them.`;

const SYSTEM = `You are a research agent that pays for data. Every get_quote call costs 0.25 tUSDC, paid over x402 from your owner's smart wallet.
Your spending is capped by an on-chain policy you cannot change. If get_quote reports ALLOWANCE_EXHAUSTED, call request_topup once with the smallest amount (in tUSDC) that covers the remaining quotes and a one-sentence reason addressed to your owner. If the owner declines, stop buying and report with what you have.
Call get_quote for several assets in parallel when you can. When done, reply with the snapshot as a compact markdown table (asset, price, 24h change) followed by one line stating what you spent. Mention that prices are demo data.`;

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_quote",
      description: "Buy the current quote for one asset symbol. Costs 0.25 tUSDC per call, paid automatically over x402.",
      strict: true,
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "Ticker, e.g. XLM" } },
        required: ["symbol"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_topup",
      description: "Ask the wallet owner to raise your on-chain allowance. Blocks until they approve (passkey) or decline.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Extra allowance in tUSDC" },
          reason: { type: "string", description: "One sentence for the owner" },
        },
        required: ["amount", "reason"],
        additionalProperties: false,
      },
    },
  },
];

type Ctx = { origin: string; wallet: string; ruleId: number; emit: (e: AgentEvent) => void };

async function allowance(ctx: Ctx) {
  const a = await readAllowance(process.env.MERCHANT_ADDRESS!, ctx.wallet, ctx.ruleId);
  ctx.emit({ t: "allowance", limit: toTusdc(a.limit), spent: toTusdc(a.spent) });
  return a;
}

async function getQuote(ctx: Ctx, symbol: string): Promise<string> {
  const agent = Keypair.fromSecret(process.env.AGENT_SECRET!);
  const url = `${ctx.origin}/api/data?symbol=${encodeURIComponent(symbol)}`;
  ctx.emit({ t: "call", symbol });
  const first = await fetch(url);
  if (first.status !== 402) return `unexpected status ${first.status}`;
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const req = required.accepts[0];
  ctx.emit({ t: "402", symbol, price: toTusdc(BigInt(req.amount)) });

  let payload;
  try {
    payload = await createSmartAccountPayment(req, ctx.wallet, ctx.ruleId, agent);
  } catch (e) {
    const code = contractErrorCode(String((e as Error).message));
    ctx.emit({ t: "refused", symbol, code });
    if (code === 3221) return "ALLOWANCE_EXHAUSTED: the on-chain spending limit refused this payment (SpendingLimitExceeded #3221). Nothing was charged.";
    throw e;
  }
  const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
  if (!paid.ok) return `payment failed: ${(await paid.json()).error}`;
  const quote = await paid.json();
  const settlement = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!);
  ctx.emit({ t: "paid", symbol, tx: settlement.transaction, quote });
  await allowance(ctx);
  return JSON.stringify(quote);
}

async function requestTopup(ctx: Ctx, amount: number, reason: string): Promise<string> {
  const before = await allowance(ctx);
  ctx.emit({ t: "topup_request", amount, reason });
  const since = Math.floor(Date.now() / 1000);
  await publish({ type: "topup", amount, reason, wallet: ctx.wallet, ruleId: ctx.ruleId });
  const reply = await waitForReply(since, 150_000, async () => (await readAllowance(
    process.env.MERCHANT_ADDRESS!, ctx.wallet, ctx.ruleId)).limit > before.limit);
  if (reply === "approved") {
    const after = await allowance(ctx);
    ctx.emit({ t: "topup_approved", limit: toTusdc(after.limit) });
    return `APPROVED: owner signed with their passkey; allowance is now ${toTusdc(after.limit)} tUSDC (spent ${toTusdc(after.spent)}). Continue.`;
  }
  ctx.emit({ t: "topup_declined" });
  return reply === "declined" ? "DECLINED by owner. Stop buying." : "No answer from owner in time. Stop buying.";
}

export const MODEL = "gpt-5.4-mini";

export async function runAgent(ctx: Ctx) {
  const client = new OpenAI();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: TASK },
  ];
  ctx.emit({ t: "start", wallet: ctx.wallet, ruleId: ctx.ruleId });
  await allowance(ctx);

  for (let turn = 0; turn < 25; turn++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      tools,
      messages,
    });
    const message = response.choices[0].message;
    const text = message.content?.trim() ?? "";
    if (!message.tool_calls?.length) return ctx.emit(text ? { t: "report", text } : { t: "error", text: "Empty model reply." });
    if (text) ctx.emit({ t: "say", text });

    messages.push(message);
    // sequential on purpose: one wallet, one payment at a time, readable log
    let exhausted = false;
    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      let content: string;
      if (exhausted && call.function.name === "get_quote") {
        // one refusal per batch is enough; the rest would be refused the same way
        messages.push({ role: "tool", tool_call_id: call.id, content: "SKIPPED: allowance exhausted (see previous result)." });
        continue;
      }
      try {
        const input = JSON.parse(call.function.arguments) as { symbol?: string; amount?: number; reason?: string };
        content = call.function.name === "get_quote"
          ? await getQuote(ctx, String(input.symbol))
          : await requestTopup(ctx, Number(input.amount), String(input.reason));
      } catch (e) {
        content = `ERROR: ${(e as Error).message}`;
      }
      if (content.startsWith("ALLOWANCE_EXHAUSTED")) exhausted = true;
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  ctx.emit({ t: "error", text: "Stopped after 25 turns." });
}
