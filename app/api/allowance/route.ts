// Current on-chain allowance of the wallet the agent would use, so the dashboard can show it without a run.
import { StrKey } from "@stellar/stellar-sdk";
import { resolveWallet } from "@/lib/ntfy";
import { readAllowance, toTusdc } from "@/lib/stellar";

export async function GET(req: Request) {
  const { wallet, ruleId } = await resolveWallet(new URL(req.url).searchParams);
  if (!wallet || !StrKey.isValidContract(wallet)) return Response.json({ error: "no wallet yet" }, { status: 404 });
  try {
    const a = await readAllowance(process.env.MERCHANT_ADDRESS!, wallet, ruleId);
    return Response.json(
      { wallet, ruleId, limit: toTusdc(a.limit), spent: toTusdc(a.spent), periodLedgers: a.periodLedgers },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 502 });
  }
}
