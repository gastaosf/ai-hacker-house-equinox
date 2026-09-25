// Laptop stand-in for the phone: approves the agent's top-up requests with the dev admin key
// (only for wallets made by `pnpm setup --dev-wallet`). The real demo uses /approve + passkey.
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { SPENDING_LIMIT_POLICY, addr, call, invoke, readAllowance, signSmartEntry, simulateRaw, sym } from "../lib/stellar";
import { xdr } from "@stellar/stellar-sdk";

const topic = process.env.NEXT_PUBLIC_NTFY_TOPIC!;
const wallet = process.env.WALLET_ADDRESS!;
const admin = Keypair.fromSecret(process.env.DEV_ADMIN_SECRET!);
const payer = Keypair.fromSecret(process.env.FACILITATOR_SECRET!);
console.log(`listening on ntfy/${topic} for ${wallet}`);

const res = await fetch(`https://ntfy.sh/${topic}/json`);
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  const lines = buf.split("\n");
  buf = lines.pop()!;
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(JSON.parse(line).message); } catch { continue; }
    if (msg.type !== "topup" || msg.wallet !== wallet) continue;
    console.log(`request +${msg.amount}: ${msg.reason}`);
    const { limit } = await readAllowance(payer.publicKey(), wallet, msg.ruleId);
    const rule = await simulateRaw(payer.publicKey(), wallet, "get_context_rule", nativeToScVal(msg.ruleId, { type: "u32" }));
    const r = await invoke(payer, call(wallet, "execute", addr(SPENDING_LIMIT_POLICY), sym("set_spending_limit"),
      xdr.ScVal.scvVec([nativeToScVal(limit + BigInt(Math.round(msg.amount * 1e7)), { type: "i128" }), rule, addr(wallet)])),
      (e, exp) => signSmartEntry(e, exp, [0], [admin]));
    console.log(r.ok ? `✓ approved ${r.hash}` : `✗ ${r.error.slice(0, 300)}`);
  }
}
