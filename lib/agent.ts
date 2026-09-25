// The agent: OpenAI tool loop that buys live data over x402 from a spend-capped smart account.
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
import { CATALOG, DEFAULT_TASK, entry, type Kind } from "./catalog";

export type AgentEvent =
  | { t: "start"; wallet: string; ruleId: number }
  | { t: "say"; text: string }
  | { t: "call"; item: string; path: string }
  | { t: "402"; item: string; price: number }
  | { t: "paid"; item: string; price: number; tx: string; quote: { summary?: string } }
  | { t: "refused"; item: string; code: number | null }
  | { t: "allowance"; limit: number; spent: number; periodLedgers: number }
  | { t: "topup_request"; amount: number; reason: string }
  | { t: "topup_approved"; limit: number }
  | { t: "topup_declined" }
  | { t: "topup_timeout" }
  | { t: "report"; text: string }
  | { t: "error"; text: string }
  | { t: "done" };


const PRICE_LIST = CATALOG.map((e) => `${e.kind} ${e.price}`).join(", ");
const SYSTEM = `You are a research agent that pays for data. Prices per call in tUSDC: ${PRICE_LIST}. Paid over x402 from your owner's smart wallet.
Your spending is capped by an on-chain policy you cannot change. If a data call reports ALLOWANCE_EXHAUSTED, call request_topup once with the smallest amount (in tUSDC) that covers the remaining items and a one-sentence reason addressed to your owner. If the owner declines, stop buying and report with what you have.
If a data call reports WALLET_EMPTY, the wallet itself has no tUSDC left: do not request a top-up (a higher allowance cannot help), stop buying, and report with what you have plus one line telling the owner to add funds on the owner page.
Call several tools in parallel when you can. When done, reply with the briefing as one compact markdown table (item, type, value, change or conditions) followed by one line stating what you spent.`;

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  ...CATALOG.map((e): OpenAI.Chat.ChatCompletionTool => ({
    type: "function",
    function: {
      name: e.tool,
      description: `${e.description} Costs ${e.price} tUSDC per call, paid automatically over x402.`,
      strict: true,
      parameters: {
        type: "object",
        properties: { [e.param]: { type: "string", description: `e.g. ${e.example}` } },
        required: [e.param],
        additionalProperties: false,
      },
    },
  })),
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

type Ctx = { origin: string; wallet: string; ruleId: number; task?: string; emit: (e: AgentEvent) => void };

async function allowance(ctx: Ctx) {
  const a = await readAllowance(process.env.MERCHANT_ADDRESS!, ctx.wallet, ctx.ruleId);
  ctx.emit({ t: "allowance", limit: toTusdc(a.limit), spent: toTusdc(a.spent), periodLedgers: a.periodLedgers });
  return a;
}

async function buy(ctx: Ctx, kind: Kind, item: string): Promise<string> {
  const agent = Keypair.fromSecret(process.env.AGENT_SECRET!);
  const { param } = entry(kind);
  const path = `/api/data/${kind}?${param}=${encodeURIComponent(item)}`;
  const url = ctx.origin + path;
  ctx.emit({ t: "call", item, path });
  const first = await fetch(url);
  if (first.status !== 402) return `unexpected status ${first.status}`;
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const req = required.accepts[0];
  const price = toTusdc(BigInt(req.amount));
  ctx.emit({ t: "402", item, price });

  let payload;
  try {
    payload = await createSmartAccountPayment(req, ctx.wallet, ctx.ruleId, agent);
  } catch (e) {
    const code = contractErrorCode(String((e as Error).message));
    ctx.emit({ t: "refused", item, code });
    if (code === 3221) return "ALLOWANCE_EXHAUSTED: the on-chain spending limit refused this payment (SpendingLimitExceeded #3221). Nothing was charged.";
    // token contract, not the policy: the wallet holds less than the price
    if (code === 10) return "WALLET_EMPTY: the wallet's tUSDC balance is too low to pay (token error #10). Nothing was charged.";
    throw e;
  }
  const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
  if (!paid.ok) return `payment failed: ${(await paid.json()).error}`;
  const quote = await paid.json();
  const settlement = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!);
  ctx.emit({ t: "paid", item, price, tx: settlement.transaction, quote });
  await allowance(ctx);
  return JSON.stringify(quote);
}

async function requestTopup(ctx: Ctx, amount: number, reason: string): Promise<string> {
  const before = await allowance(ctx);
  ctx.emit({ t: "topup_request", amount, reason });
  const since = Math.floor(Date.now() / 1000);
  await publish({ type: "topup", amount, reason, wallet: ctx.wallet, ruleId: ctx.ruleId });
  const reply = await waitForReply(since, ctx.wallet, 150_000, async () => (await readAllowance(
    process.env.MERCHANT_ADDRESS!, ctx.wallet, ctx.ruleId)).limit > before.limit);
  if (reply === "approved") {
    const after = await allowance(ctx);
    ctx.emit({ t: "topup_approved", limit: toTusdc(after.limit) });
    return `APPROVED: owner signed with their passkey; allowance is now ${toTusdc(after.limit)} tUSDC (spent ${toTusdc(after.spent)}). Continue.`;
  }
  if (reply === "declined") {
    ctx.emit({ t: "topup_declined" });
    return "DECLINED by owner. Stop buying.";
  }
  ctx.emit({ t: "topup_timeout" });
  return "No answer from owner in time. Stop buying.";
}

export const MODEL = "gpt-5.4-mini";

export async function runAgent(ctx: Ctx) {
  const client = new OpenAI();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: ctx.task ?? DEFAULT_TASK },
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
    let exhausted: "ALLOWANCE_EXHAUSTED" | "WALLET_EMPTY" | null = null;
    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      let content: string;
      const entry = CATALOG.find((e) => e.tool === call.function.name);
      if (exhausted && entry) {
        // one refusal per batch is enough; the rest would be refused the same way
        messages.push({ role: "tool", tool_call_id: call.id, content: `SKIPPED: ${exhausted} (see previous result).` });
        continue;
      }
      try {
        const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        content = entry
          ? await buy(ctx, entry.kind, String(input[entry.param]))
          : await requestTopup(ctx, Number(input.amount), String(input.reason));
      } catch (e) {
        content = `ERROR: ${(e as Error).message}`;
      }
      if (content.startsWith("ALLOWANCE_EXHAUSTED")) exhausted = "ALLOWANCE_EXHAUSTED";
      if (content.startsWith("WALLET_EMPTY")) exhausted = "WALLET_EMPTY";
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  ctx.emit({ t: "error", text: "Stopped after 25 turns." });
}
