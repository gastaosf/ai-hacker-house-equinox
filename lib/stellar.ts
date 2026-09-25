// Server-side Stellar helpers: raw Soroban invocations + smart-account (OpenZeppelin) auth signing.
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { computeEntryAuthDigest } from "smart-account-kit";

import { ACCOUNT_WASM_HASH, ED25519_VERIFIER, RPC_URL, SPENDING_LIMIT_POLICY } from "./contracts";
export { ACCOUNT_WASM_HASH, ED25519_VERIFIER, RPC_URL, SPENDING_LIMIT_POLICY };
export const PASSPHRASE = Networks.TESTNET;
export const server = new rpc.Server(RPC_URL);

export const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const addr = (a: string) => new Address(a).toScVal();

/** On-chain Signer::External(verifier, key) */
export function externalSigner(verifier: string, key: Buffer): xdr.ScVal {
  return xdr.ScVal.scvVec([sym("External"), addr(verifier), xdr.ScVal.scvBytes(key)]);
}

export const ed25519Signer = (kp: Keypair) => externalSigner(ED25519_VERIFIER, Buffer.from(kp.rawPublicKey()));

/** Install params for the spending_limit policy (map keys in canonical order). */
export function spendingLimitParams(limit: bigint, periodLedgers: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("period_ledgers"), val: nativeToScVal(periodLedgers, { type: "u32" }) }),
    new xdr.ScMapEntry({ key: sym("spending_limit"), val: nativeToScVal(limit, { type: "i128" }) }),
  ]);
}

/**
 * Sign a smart-account auth entry with Ed25519 external signers.
 * Writes AuthPayload { context_rule_ids, signers: { Signer => sig(auth_digest) } } into the entry.
 */
export function signSmartEntry(
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number,
  ruleIds: number[],
  keypairs: Keypair[],
) {
  const { authDigest } = computeEntryAuthDigest(PASSPHRASE, entry, expiration, ruleIds);
  const signers = xdr.ScVal.scvMap(
    keypairs.map((kp) => new xdr.ScMapEntry({ key: ed25519Signer(kp), val: xdr.ScVal.scvBytes(kp.sign(authDigest)) })),
  );
  entry.credentials().address().signature(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: sym("context_rule_ids"),
        val: xdr.ScVal.scvVec(ruleIds.map((id) => nativeToScVal(id, { type: "u32" }))),
      }),
      new xdr.ScMapEntry({ key: sym("signers"), val: signers }),
    ]),
  );
}

export type InvokeResult = { ok: true; hash: string; returnValue?: xdr.ScVal } | { ok: false; error: string };

/** Decode "Error(Contract, #3221)" style failures into something readable. */
export function contractErrorCode(msg: string): number | null {
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

/**
 * Build → simulate → (sign smart-account auth entries via `signAuth`) → re-simulate → submit → wait.
 * `source` pays fees and signs the envelope.
 */
export async function invoke(
  source: Keypair,
  op: xdr.Operation,
  signAuth?: (entry: xdr.SorobanAuthorizationEntry, expiration: number) => void,
): Promise<InvokeResult> {
  const sequence = (await server.getAccount(source.publicKey())).sequenceNumber();
  // fresh Account per build: TransactionBuilder.build() bumps the sequence it is given
  const build = (o: xdr.Operation) =>
    new TransactionBuilder(new Account(source.publicKey(), sequence), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(o).setTimeout(60).build();

  let tx = build(op);
  let sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };

  if (signAuth) {
    const expiration = (await server.getLatestLedger()).sequence + 100;
    const auth = (sim.result?.auth ?? []).map((e) => {
      if (e.credentials().switch().name === "sorobanCredentialsAddress") signAuth(e, expiration);
      return e;
    });
    const body = op.body().invokeHostFunctionOp();
    tx = build(Operation.invokeHostFunction({ func: body.hostFunction(), auth }));
    sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") return { ok: false, error: JSON.stringify(sent.errorResult) };
  const res = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (res.status !== "SUCCESS") return { ok: false, error: `tx ${sent.hash} ${res.status}` };
  return { ok: true, hash: sent.hash, returnValue: res.returnValue };
}

export const call = (contractId: string, method: string, ...args: xdr.ScVal[]) =>
  new Contract(contractId).call(method, ...args);

export async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && !(await r.text()).includes("already funded")) throw new Error(`friendbot failed for ${pub}`);
}

/** Read-only contract call via simulation (any funded account works as the nominal source). */
export async function simulateRaw(sourcePub: string, contractId: string, method: string, ...args: xdr.ScVal[]) {
  const tx = new TransactionBuilder(await server.getAccount(sourcePub), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(call(contractId, method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result!.retval;
}

export const simulateRead = async (sourcePub: string, contractId: string, method: string, ...args: xdr.ScVal[]) =>
  scValToNative(await simulateRaw(sourcePub, contractId, method, ...args));

/** Current allowance of the agent rule, in stroops (1 tUSDC = 10_000_000). */
export async function readAllowance(sourcePub: string, wallet: string, ruleId: number) {
  const d = await simulateRead(sourcePub, SPENDING_LIMIT_POLICY, "get_spending_limit_data",
    nativeToScVal(ruleId, { type: "u32" }), addr(wallet));
  return { limit: BigInt(d.spending_limit), spent: BigInt(d.cached_total_spent) };
}

export const toTusdc = (stroops: bigint) => Number(stroops) / 1e7;
