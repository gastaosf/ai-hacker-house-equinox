// Testnet faucet for the owner's new wallet: mints 10 tUSDC from the issuer.
import { Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { addr, call, invoke } from "@/lib/stellar";

export async function POST(req: Request) {
  const { wallet } = await req.json();
  if (typeof wallet !== "string" || !StrKey.isValidContract(wallet)) {
    return Response.json({ error: "wallet must be a C… contract address" }, { status: 400 });
  }
  const issuer = Keypair.fromSecret(process.env.ISSUER_SECRET!);
  const r = await invoke(issuer, call(process.env.NEXT_PUBLIC_TUSDC!, "mint", addr(wallet), nativeToScVal(100_000_000n, { type: "i128" })));
  return r.ok ? Response.json({ hash: r.hash }) : Response.json({ error: r.error }, { status: 500 });
}
