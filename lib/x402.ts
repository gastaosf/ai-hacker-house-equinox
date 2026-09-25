// x402 (exact / stellar) — client side for a smart-account payer, and an in-process facilitator.
import { Keypair, contract, nativeToScVal, Address, xdr } from "@stellar/stellar-sdk";
import { ExactStellarScheme as StellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { PASSPHRASE, RPC_URL, server, signSmartEntry } from "./stellar";
import { STROOPS } from "./contracts";
import { entry, type Kind } from "./catalog";

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

/** Paid data: rendered by the UI and read by the agent via `summary`. */
export type PaidData = { summary: string; source: string } & Record<string, unknown>;

/**
 * Server: 402 → verify → produce data → settle. Settles only once the data exists,
 * so an unknown item (produce → null) or a failing upstream never charges the payer.
 */
export async function paywall(req: Request, kind: Kind, description: string, produce: () => Promise<PaidData | null>) {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: process.env.NEXT_PUBLIC_TUSDC!,
    payTo: process.env.MERCHANT_ADDRESS!,
    amount: String(Math.round(entry(kind).price * STROOPS)),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
  const header = req.headers.get("PAYMENT-SIGNATURE");
  if (!header) {
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      error: "payment required",
      resource: { url: req.url, description, mimeType: "application/json" },
      accepts: [requirements],
    };
    return Response.json(body, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) } });
  }

  const payload = decodePaymentSignatureHeader(header);
  const facilitator = getFacilitator();
  const verified = await facilitator.verify(payload, requirements);
  if (!verified.isValid) return Response.json({ error: verified.invalidReason }, { status: 402 });

  let data: PaidData | null;
  try {
    data = await produce();
  } catch (e) {
    return Response.json({ error: `upstream failed: ${(e as Error).message}. Nothing charged.` }, { status: 502 });
  }
  if (!data) return Response.json({ error: `not found: ${description}. Nothing charged.` }, { status: 404 });

  const settled = await facilitator.settle(payload, requirements);
  if (!settled.success) return Response.json({ error: settled.errorReason }, { status: 402 });
  return Response.json(data, { headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) } });
}

/** fetch JSON or throw with the status — upstream failures become a 502 in paywall. */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json() as Promise<T>;
}
