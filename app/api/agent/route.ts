// Runs one agent session and streams its events to the log page as Server-Sent Events.
import { runAgent, type AgentEvent } from "@/lib/agent";

export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet") || process.env.WALLET_ADDRESS;
  const ruleId = Number(url.searchParams.get("rule") ?? process.env.AGENT_RULE_ID ?? 1);
  if (!wallet) return Response.json({ error: "no wallet configured" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runAgent({ origin: url.origin, wallet, ruleId, emit });
      } catch (e) {
        emit({ t: "error", text: String((e as Error).message).slice(0, 300) });
      }
      emit({ t: "done" });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
