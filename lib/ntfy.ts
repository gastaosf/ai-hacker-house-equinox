// ntfy.sh as the message bus between the agent (server) and the owner's phone (/approve page).
const topicUrl = () => `https://ntfy.sh/${process.env.NEXT_PUBLIC_NTFY_TOPIC}`;

export async function publish(message: object) {
  await fetch(topicUrl(), { method: "POST", body: JSON.stringify(message) });
}

async function declinedSince(since: number) {
  const r = await fetch(`${topicUrl()}/json?poll=1&since=${since}`);
  return (await r.text()).split("\n").filter(Boolean).some((line) => {
    try { return JSON.parse(JSON.parse(line).message).type === "declined"; } catch { return false; }
  });
}

/** Approval is read from the chain (the limit went up); a decline comes over ntfy. */
export async function waitForReply(since: number, timeoutMs: number, approvedOnChain: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await approvedOnChain()) return "approved" as const;
    if (await declinedSince(since)) return "declined" as const;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout" as const;
}
