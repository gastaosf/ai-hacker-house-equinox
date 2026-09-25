"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const PRICE = 0.25;
const explorer = (kind: "tx" | "contract", id: string) => `https://stellar.expert/explorer/testnet/${kind}/${id}`;
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;

type Status = "idle" | "running" | "waiting" | "done";

export default function Dashboard() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [allowance, setAllowance] = useState<{ limit: number; spent: number } | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const tape = useRef<HTMLDivElement>(null);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    tape.current?.scrollTo({ top: tape.current.scrollHeight, behavior: "smooth" });
  }, [events]);
  useEffect(() => () => source.current?.close(), []);

  function run() {
    source.current?.close();
    setEvents([]);
    setStatus("running");
    const es = new EventSource("/api/agent");
    source.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AgentEvent;
      if (e.t === "start") setWallet(e.wallet);
      if (e.t === "allowance") setAllowance({ limit: e.limit, spent: e.spent });
      if (e.t === "topup_request") setStatus("waiting");
      if (e.t === "topup_approved" || e.t === "topup_declined") setStatus("running");
      if (e.t === "done") { setStatus("done"); es.close(); return; }
      setEvents((prev) => [...prev, e]);
    };
    es.onerror = () => { setStatus("done"); es.close(); };
  }

  const paid = events.filter((e) => e.t === "paid").length;

  return (
    <main className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:py-16">
      <section className="flex flex-col gap-8">
        <header className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-signal">Stellar testnet · x402 · smart account</p>
          <h1 className="font-heading text-6xl leading-[0.9] sm:text-7xl">
            An agent<br />with an <em className="text-signal">allowance</em>.
          </h1>
          <p className="max-w-md text-muted-foreground">
            It pays for every API call on its own. The chain—not the app—caps what it can spend.
            When it runs dry, it asks the owner, who approves with a passkey on their phone.
          </p>
        </header>

        <Gauge allowance={allowance} status={status} />

        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={run} disabled={status === "running" || status === "waiting"} className="h-12 px-8 font-mono uppercase tracking-widest">
            {status === "idle" ? "Run agent" : status === "done" ? "Run again" : "Running…"}
          </Button>
          <StatusBadge status={status} />
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-xs text-muted-foreground">
          <dt>wallet</dt>
          <dd>{wallet ? <a className="underline decoration-dotted hover:text-foreground" href={explorer("contract", wallet)} target="_blank">{short(wallet)}</a> : "—"}</dd>
          <dt>policy</dt><dd>spending_limit · rolling 24h · OpenZeppelin smart account</dd>
          <dt>price</dt><dd>{PRICE} tUSDC per quote · HTTP 402</dd>
          <dt>data</dt><dd>demo prices; payments are real testnet transactions</dd>
        </dl>
      </section>

      <section aria-label="Agent receipt" className="min-w-0">
        <div className="receipt mx-auto max-w-xl rounded-t-sm">
          <div className="border-b border-dashed border-ink/30 px-6 pt-6 pb-4 text-center font-mono">
            <p className="text-sm font-semibold tracking-[0.35em]">AGENT RECEIPT</p>
            <p className="mt-1 text-[11px] opacity-60">{new Date().toISOString().slice(0, 10)} · merchant /api/data</p>
          </div>
          <div ref={tape} className="h-[58vh] min-h-80 overflow-y-auto px-6 py-4 font-mono text-[13px] leading-6" aria-live="polite">
            {events.length === 0 && <p className="py-16 text-center opacity-40">— waiting for the agent —</p>}
            {events.map((e, i) => <Line key={i} e={e} />)}
          </div>
          <div className="flex justify-between border-t border-dashed border-ink/30 px-6 pt-3 font-mono text-sm font-semibold">
            <span>{paid} × {PRICE}</span>
            <span>TOTAL {(paid * PRICE).toFixed(2)} tUSDC</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function Gauge({ allowance, status }: { allowance: { limit: number; spent: number } | null; status: Status }) {
  const blocks = allowance ? Math.round(allowance.limit / PRICE) : 8;
  const used = allowance ? Math.round(allowance.spent / PRICE) : 0;
  const left = allowance ? allowance.limit - allowance.spent : null;
  return (
    <div className="rounded-lg border border-border bg-card/60 p-5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">Allowance left</span>
        <span className="font-mono text-xs text-muted-foreground">{allowance ? `${allowance.spent.toFixed(2)} / ${allowance.limit.toFixed(2)} spent` : "—"}</span>
      </div>
      <p className={`mt-1 font-heading text-6xl tabular-nums transition-colors ${left === 0 ? "text-deny" : ""}`}>
        {left === null ? "—" : left.toFixed(2)} <span className="text-2xl text-muted-foreground">tUSDC</span>
      </p>
      <div className="mt-4 flex gap-1" role="meter" aria-valuemin={0} aria-valuemax={blocks} aria-valuenow={blocks - used} aria-label="Allowance blocks left">
        {Array.from({ length: blocks }, (_, i) => (
          <span
            key={i}
            className={`h-6 flex-1 rounded-[3px] transition-colors duration-500 ${i < used ? "bg-border" : "bg-signal"} ${status === "waiting" && i >= used ? "animate-pulse" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "waiting")
    return <Badge className="pulse-ring bg-signal font-mono text-black">waiting for owner’s passkey</Badge>;
  if (status === "running") return <Badge variant="outline" className="font-mono">agent working</Badge>;
  return null;
}

function Line({ e }: { e: AgentEvent }) {
  const row = "print-in";
  switch (e.t) {
    case "call":
      return <p className={`${row} opacity-50`}>GET /api/data?symbol={e.symbol}</p>;
    case "402":
      return <p className={`${row} opacity-70`}>  402 Payment Required · {e.price} tUSDC</p>;
    case "paid": {
      const q = e.quote as { price?: number; change24h?: string };
      return (
        <p className={`${row} flex justify-between gap-3 font-semibold`}>
          <span>✓ {e.symbol.padEnd(6, " ")} ${q.price}</span>
          <a className="font-normal underline decoration-dotted opacity-70 hover:opacity-100" href={explorer("tx", e.tx)} target="_blank">tx {short(e.tx)} ↗</a>
        </p>
      );
    }
    case "refused":
      return (
        <div className={`${row} my-4 text-center`}>
          <span className="stamp text-deny text-lg">Refused by chain</span>
          <p className="mt-2 text-xs opacity-70">{e.symbol}: #{e.code} SpendingLimitExceeded · nothing charged</p>
        </div>
      );
    case "topup_request":
      return (
        <p className={`${row} my-3 border-l-2 border-signal bg-signal/15 px-3 py-2`}>
          → asks owner for +{e.amount} tUSDC<br />
          <span className="italic opacity-80">“{e.reason}”</span>
        </p>
      );
    case "topup_approved":
      return (
        <div className={`${row} my-4 text-center`}>
          <span className="stamp text-ok text-lg">Approved · passkey</span>
          <p className="mt-2 text-xs opacity-70">new limit {e.limit.toFixed(2)} tUSDC</p>
        </div>
      );
    case "topup_declined":
      return <div className={`${row} my-4 text-center`}><span className="stamp text-deny">Owner declined</span></div>;
    case "say":
      return <p className={`${row} my-2 italic opacity-70`}>» {e.text}</p>;
    case "report":
      return <pre className={`${row} mt-4 whitespace-pre-wrap border-t border-dashed border-ink/30 pt-4 text-xs`}>{e.text}</pre>;
    case "error":
      return <p className={`${row} text-deny`}>! {e.text}</p>;
    default:
      return null;
  }
}
