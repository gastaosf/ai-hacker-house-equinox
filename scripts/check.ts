// Runnable check: one real x402 purchase against the running app (default http://localhost:3000),
// asserting the on-chain allowance moved by exactly the price.
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { readAllowance } from "../lib/stellar";
import { createSmartAccountPayment } from "../lib/x402";

const origin = process.argv[2] ?? "http://localhost:3000";
const wallet = process.env.WALLET_ADDRESS!;
const ruleId = Number(process.env.AGENT_RULE_ID ?? 1);
const merchant = process.env.MERCHANT_ADDRESS!;

const before = await readAllowance(merchant, wallet, ruleId);
const url = `${origin}/api/data?symbol=XLM`;
const first = await fetch(url);
assert.equal(first.status, 402);
const req = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!).accepts[0];
const payload = await createSmartAccountPayment(req, wallet, ruleId, Keypair.fromSecret(process.env.AGENT_SECRET!));
const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
assert.equal(paid.status, 200, await paid.clone().text());
const after = await readAllowance(merchant, wallet, ruleId);
assert.equal(after.spent - before.spent, BigInt(req.amount));
console.log("✓ paid", await paid.json(), `allowance ${Number(after.limit - after.spent) / 1e7} left`);
