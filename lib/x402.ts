// x402 (exact / stellar) — client side for a smart-account payer, and an in-process facilitator.
import { Keypair, contract, nativeToScVal, Address, xdr } from "@stellar/stellar-sdk";
import { ExactStellarScheme as StellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { PASSPHRASE, RPC_URL, server, signSmartEntry } from "./stellar";

export const NETWORK = "stellar:testnet" as const;
export const X402_VERSION = 2;

/**
 * Client: build the exact-scheme payload (a SAC transfer from the smart account) and sign its auth entry
 * with the agent's session key under `ruleId`. Mirrors @x402/stellar's client, but emits the
 * OpenZeppelin AuthPayload signature instead of the stock ed25519 shape (x402 issue #3158).
 * Throws with the simulation error when the on-chain policy refuses (e.g. #3221 SpendingLimitExceeded).
 */
export async function createSmartAccountPayment(
  req: PaymentRequirements,
  wallet: string,
  ruleId: number,
  agent: Keypair,
): Promise<PaymentPayload> {
  const tx = await contract.AssembledTransaction.build({
    contractId: req.asset,
    method: "transfer",
    args: [
      nativeToScVal(wallet, { type: "address" }),
      nativeToScVal(req.payTo, { type: "address" }),
      nativeToScVal(req.amount, { type: "i128" }),
    ],
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    parseResultXdr: (r) => r,
  });
  const expiration = (await server.getLatestLedger()).sequence + Math.ceil(req.maxTimeoutSeconds / 5);
  // Auth entries are shared by reference with the envelope, so signing in place updates tx.built.
  const op = tx.built!.operations[0] as unknown as { auth: xdr.SorobanAuthorizationEntry[] };
  for (const entry of op.auth ?? []) {
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") continue;
    if (Address.fromScAddress(creds.address().address()).toString() !== wallet) continue;
    signSmartEntry(entry, expiration, [ruleId], [agent]);
  }
  await tx.simulate(); // enforcing-mode simulation: runs __check_auth + spending_limit policy
  if (tx.simulation && "error" in tx.simulation) throw new Error(String(tx.simulation.error));
  return { x402Version: X402_VERSION, accepted: req, payload: { transaction: tx.built!.toXDR() } };
}

/**
 * Facilitator: stock @x402/stellar verify/settle, with two smart-account fixes:
 * - policy contracts emit their own events during auth → only transfer events are checked (x402 #3352)
 * - fee ceiling raised: __check_auth calls the verifier + policy contracts (x402 #3515)
 */
type EventCheck = (events: xdr.DiagnosticEvent[], ...rest: string[]) => unknown;

let facilitator: StellarFacilitatorScheme | null = null;
export function getFacilitator() {
  if (facilitator) return facilitator;
  const secret = process.env.FACILITATOR_SECRET;
  if (!secret) throw new Error("FACILITATOR_SECRET missing");
  const f = new StellarFacilitatorScheme([createEd25519Signer(secret, NETWORK)], {
    rpcConfig: { url: RPC_URL },
    maxTransactionFeeStroops: 5_000_000,
  });
  // ponytail: instance patch of a private method — revisit if @x402/stellar ships smart-account support
  const target = f as unknown as { validateSimulationEvents: EventCheck };
  const original = target.validateSimulationEvents.bind(f);
  target.validateSimulationEvents = (events, ...rest) =>
    original(events.filter((d) => {
      const e = d.event();
      if (e.type().name !== "contract") return true;
      const t = e.body().v0().topics();
      return t[0]?.switch().name === "scvSymbol" && t[0].sym().toString() === "transfer";
    }), ...rest);
  return (facilitator = f);
}
