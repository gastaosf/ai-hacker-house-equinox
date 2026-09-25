// ntfy.sh as the message bus between the agent (server) and the owner's phone (/approve page).
const topicUrl = () => `https://ntfy.sh/${process.env.NEXT_PUBLIC_NTFY_TOPIC}`;

export async function publish(message: object) {
  await fetch(topicUrl(), { method: "POST", body: JSON.stringify(message) });
}

async function declinedSince(since: number, wallet: string) {
  const r = await fetch(`${topicUrl()}/json?poll=1&since=${since}`);
  return (await r.text()).split("\n").filter(Boolean).some((line) => {
    try {
      const m = JSON.parse(JSON.parse(line).message);
      return m.type === "declined" && m.wallet === wallet;
    } catch { return false; }
  });
}

/** Approval is read from the chain (the limit went up); a decline comes over ntfy, tagged with the wallet. */
export async function waitForReply(since: number, wallet: string, timeoutMs: number, approvedOnChain: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await approvedOnChain()) return "approved" as const;
    if (await declinedSince(since, wallet)) return "declined" as const;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout" as const;
}

/** The wallet the owner's phone announced most recently on /approve (ntfy keeps messages ~12h). */
export async function announcedWallet(): Promise<{ wallet: string; ruleId: number } | null> {
  const r = await fetch(`${topicUrl()}/json?poll=1&since=12h`, { cache: "no-store" });
  let found: { wallet: string; ruleId: number } | null = null;
  for (const line of (await r.text()).split("\n").filter(Boolean)) {
    try {
      const m = JSON.parse(JSON.parse(line).message);
      if (m.type === "wallet") found = { wallet: String(m.wallet), ruleId: Number(m.ruleId) };
    } catch { /* not ours */ }
  }
  return found;
}

/** Which wallet the agent spends from. Precedence: ?wallet= override → wallet announced by the owner's phone → env fallback. */
export async function resolveWallet(params: URLSearchParams) {
  const announced = await announcedWallet();
  const wallet = params.get("wallet") || announced?.wallet || process.env.WALLET_ADDRESS;
  const ruleId = Number(params.get("rule") ?? (announced && announced.wallet === wallet ? announced.ruleId : process.env.AGENT_RULE_ID ?? 1));
  return { wallet, ruleId };
}
