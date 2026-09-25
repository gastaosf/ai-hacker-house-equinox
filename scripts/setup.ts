// One-time testnet setup → writes .env.local.
//   pnpm setup             keys + tUSDC asset/SAC + merchant trustline
//   pnpm setup --dev-wallet  also deploys a smart account whose admin is an ed25519 key (laptop testing, no phone)
import { Address, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  ACCOUNT_WASM_HASH, PASSPHRASE, SPENDING_LIMIT_POLICY, addr, call, ed25519Signer, friendbot, invoke, server,
  signSmartEntry, spendingLimitParams, sym,
} from "../lib/stellar";

const must = <T extends { ok: boolean }>(label: string, r: T) => {
  if (!r.ok) throw new Error(`${label}: ${(r as { error?: string }).error}`);
  console.log("✓", label);
  return r as Extract<T, { ok: true }>;
};

const [facilitator, issuer, merchant, agent] = Array.from({ length: 4 }, () => Keypair.random());
await Promise.all([facilitator, issuer, merchant].map((k) => friendbot(k.publicKey())));
console.log("✓ friendbot");

const asset = new Asset("TUSDC", issuer.publicKey());
const sac = asset.contractId(PASSPHRASE);
must("tUSDC contract", await invoke(issuer, Operation.createStellarAssetContract({ asset })));

const acct = await server.getAccount(merchant.publicKey());
const trust = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
  .addOperation(Operation.changeTrust({ asset })).setTimeout(60).build();
trust.sign(merchant);
await server.pollTransaction((await server.sendTransaction(trust)).hash);
console.log("✓ merchant trustline");

const env: Record<string, string> = {
  FACILITATOR_SECRET: facilitator.secret(),
  ISSUER_SECRET: issuer.secret(),
  MERCHANT_ADDRESS: merchant.publicKey(),
  AGENT_SECRET: agent.secret(),
  NEXT_PUBLIC_TUSDC: sac,
  NEXT_PUBLIC_AGENT_PUBKEY: Buffer.from(agent.rawPublicKey()).toString("hex"),
  NEXT_PUBLIC_NTFY_TOPIC: `allowance-${randomBytes(8).toString("hex")}`,
};

if (process.argv.includes("--dev-wallet")) {
  const admin = Keypair.random();
  const deployed = must("dev smart account", await invoke(facilitator, Operation.createCustomContract({
    address: new Address(facilitator.publicKey()),
    wasmHash: Buffer.from(ACCOUNT_WASM_HASH, "hex"),
    salt: randomBytes(32),
    constructorArgs: [xdr.ScVal.scvVec([ed25519Signer(admin)]), xdr.ScVal.scvMap([])],
  })));
  const wallet = Address.fromScVal(deployed.returnValue!).toString();
  must("mint 10 tUSDC", await invoke(issuer, call(sac, "mint", addr(wallet), nativeToScVal(100_000_000n, { type: "i128" }))));
  must("agent rule (2 tUSDC/day)", await invoke(facilitator, call(wallet, "add_context_rule",
    xdr.ScVal.scvVec([sym("CallContract"), addr(sac)]),
    xdr.ScVal.scvString("agent"),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([ed25519Signer(agent)]),
    xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: addr(SPENDING_LIMIT_POLICY), val: spendingLimitParams(20_000_000n, 17280) })]),
  ), (e, exp) => signSmartEntry(e, exp, [0], [admin])));
  Object.assign(env, { WALLET_ADDRESS: wallet, AGENT_RULE_ID: "1", DEV_ADMIN_SECRET: admin.secret() });
}

writeFileSync(".env.local", Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log("✓ wrote .env.local\n", env);
