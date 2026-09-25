"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/agent";
import { PRICE_TUSDC } from "@/lib/contracts";
import { Button } from "@/components/ui/button";

const explorer = (kind: "tx" | "contract", id: string) => `https://stellar.expert/explorer/testnet/${kind}/${id}`;
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;

type Status = "idle" | "running" | "waiting" | "done";
type Stage = 0 | 1 | 2 | 3; // none, paying, refused, owner

export default function Dashboard() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<Stage>(0);
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
    setStage(0);
    setStatus("running");
    const es = new EventSource("/api/agent");
    source.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AgentEvent;
      if (e.t === "start") setWallet(e.wallet);
      if (e.t === "allowance") setAllowance({ limit: e.limit, spent: e.spent });
      if (e.t === "paid") setStage((s) => (s === 0 ? 1 : s));
      if (e.t === "refused") setStage(2);
      if (e.t === "topup_request") { setStage(3); setStatus("waiting"); }
      if (e.t === "topup_approved" || e.t === "topup_declined" || e.t === "topup_timeout") setStatus("running");
      if (e.t === "done") { setStatus("done"); es.close(); return; }
      setEvents((prev) => [...prev, e]);
    };
    es.onerror = () => { setStatus("done"); es.close(); };
  }

  const paid = events.filter((e) => e.t === "paid").length;
  const busy = status === "running" || status === "waiting";

  return (
    <div className="flex flex-1 flex-col">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-6 sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary font-serif text-lg font-semibold text-primary-foreground shadow-sm">A</span>
          <span className="font-semibold tracking-tight">Allowance</span>
        </div>
        <div className="hidden gap-2 font-mono text-[11px] sm:flex">
          {["Stellar testnet", "x402", "Smart account"].map((t) => (
            <span key={t} className="rounded-md border bg-card px-2 py-1 text-muted-foreground shadow-2xs">{t}</span>
          ))}
        </div>
      </nav>

      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:py-14">
        <section className="flex flex-col gap-7">
          <header className="rise space-y-4">
            <h1 className="font-serif text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl">
              An AI agent with an <em className="text-primary">allowance</em>.
            </h1>
            <p className="max-w-md text-lg text-muted-foreground">
              It pays for every API call by itself. The blockchain—not the app—caps what it can spend.
              When it runs dry, it has to ask you.
            </p>
          </header>

          <Steps stage={stage} />
          <Gauge allowance={allowance} status={status} />

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={run} disabled={busy} className="h-12 px-7 text-base font-semibold shadow-md">
              {status === "idle" ? "Run agent" : status === "done" ? "Run again" : "Agent running…"}
            </Button>
            {status === "waiting" && (
              <span className="pulse-ring rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground">
                waiting for owner’s passkey
              </span>
            )}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-xs text-muted-foreground">
            <dt>wallet</dt>
            <dd>{wallet ? <a className="underline decoration-dotted hover:text-foreground" href={explorer("contract", wallet)} target="_blank">{short(wallet)}</a> : "—"}</dd>
            <dt>policy</dt><dd>OpenZeppelin spending_limit · rolling 24h</dd>
            <dt>price</dt><dd>{PRICE_TUSDC} tUSDC per quote · HTTP 402</dd>
            <dt>data</dt><dd>demo prices · payments are real testnet transactions</dd>
          </dl>
        </section>

        <section aria-label="Agent receipt" className="rise min-w-0 [animation-delay:120ms]">
          <div className="receipt-wrap mx-auto max-w-xl">
          <div className="receipt rounded-t-lg">
            <div className="flex items-end justify-between border-b border-dashed px-6 pt-5 pb-4 font-mono">
              <div>
                <p className="text-sm font-bold tracking-[0.3em]">AGENT RECEIPT</p>
                <p className="mt-1 text-[11px] text-muted-foreground">merchant · /api/data</p>
              </div>
              <p className="text-[11px] text-muted-foreground">{new Date().toISOString().slice(0, 10)}</p>
            </div>
            <div ref={tape} className="h-[56vh] min-h-80 overflow-y-auto px-6 py-4 font-mono text-[13px] leading-6" aria-live="polite">
              {events.length === 0 && <p className="py-20 text-center text-muted-foreground">— press “Run agent” —</p>}
              {events.map((e, i) => <Line key={i} e={e} />)}
            </div>
            <div className="flex justify-between border-t border-dashed px-6 pt-3 font-mono text-sm font-bold">
              <span>{paid} × {PRICE_TUSDC.toFixed(2)}</span>
              <span>TOTAL {(paid * PRICE_TUSDC).toFixed(2)} tUSDC</span>
            </div>
          </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Steps({ stage }: { stage: Stage }) {
  const steps = [
    ["Pays per call", "x402 · tUSDC"],
    ["Chain says no", "spending limit"],
    ["You approve", "passkey"],
  ];
  return (
    <ol className="grid grid-cols-3 gap-2">
      {steps.map(([title, sub], i) => {
        const n = (i + 1) as Stage;
        const active = stage === n;
        const done = stage > n;
        return (
          <li
            key={title}
            className={`rounded-lg border px-3 py-2.5 transition-all duration-500 ${
              active ? "border-primary bg-accent text-accent-foreground shadow-md" : done ? "bg-card" : "bg-card opacity-60"
            }`}
          >
            <p className="font-mono text-[10px] text-muted-foreground">0{n}</p>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="font-mono text-[10px] text-muted-foreground">{sub}</p>
          </li>
        );
      })}
    </ol>
  );
}

function Gauge({ allowance, status }: { allowance: { limit: number; spent: number } | null; status: Status }) {
  const blocks = allowance ? Math.max(1, Math.round(allowance.limit / PRICE_TUSDC)) : 4;
  const used = allowance ? Math.round(allowance.spent / PRICE_TUSDC) : 0;
  const left = allowance ? allowance.limit - allowance.spent : null;
  return (
    <div className="rounded-lg border bg-card p-5 shadow-md">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-muted-foreground">Allowance left today</span>
        <span className="font-mono text-xs text-muted-foreground">{allowance ? `${allowance.spent.toFixed(2)} / ${allowance.limit.toFixed(2)} spent` : "—"}</span>
      </div>
      <p className={`mt-1 font-serif text-6xl font-semibold tabular-nums tracking-tight transition-colors ${left === 0 ? "text-destructive" : ""}`}>
        {left === null ? "—" : left.toFixed(2)} <span className="font-sans text-xl font-normal text-muted-foreground">tUSDC</span>
      </p>
      <div className="mt-4 flex gap-1.5" role="meter" aria-valuemin={0} aria-valuemax={blocks} aria-valuenow={blocks - used} aria-label="Paid calls left">
        {Array.from({ length: blocks }, (_, i) => (
          <span
            key={i}
            className={`h-7 flex-1 rounded-sm transition-colors duration-500 ${i < used ? "bg-muted ring-1 ring-border ring-inset" : "bg-primary"} ${status === "waiting" && i >= used ? "animate-pulse" : ""}`}
          />
        ))}
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">one block = one paid call ({PRICE_TUSDC} tUSDC)</p>
    </div>
  );
}

function Line({ e }: { e: AgentEvent }) {
  const row = "print-in";
  switch (e.t) {
    case "call":
      return <p className={`${row} text-muted-foreground`}>GET /api/data?symbol={e.symbol}</p>;
    case "402":
      return <p className={`${row} text-muted-foreground`}>  ↳ 402 Payment Required · {e.price} tUSDC</p>;
    case "paid": {
      const q = e.quote as { price?: number };
      return (
        <p className={`${row} flex justify-between gap-3 font-semibold`}>
          <span>✓ {e.symbol.padEnd(6, " ")} ${q.price}</span>
          <a className="font-normal text-muted-foreground underline decoration-dotted hover:text-foreground" href={explorer("tx", e.tx)} target="_blank">tx {short(e.tx)} ↗</a>
        </p>
      );
    }
    case "refused":
      return (
        <div className={`${row} my-5 text-center`}>
          <span className="stamp text-lg text-destructive">Refused by chain</span>
          <p className="mt-2 text-xs text-muted-foreground">{e.symbol}: #{e.code} SpendingLimitExceeded · nothing charged</p>
        </div>
      );
    case "topup_request":
      return (
        <p className={`${row} my-3 rounded-md border-l-4 border-primary bg-accent px-3 py-2 text-accent-foreground`}>
          → asks owner for +{e.amount} tUSDC<br />
          <span className="italic">“{e.reason}”</span>
        </p>
      );
    case "topup_approved":
      return (
        <div className={`${row} my-5 text-center`}>
          <span className="stamp text-lg text-success">Approved · passkey</span>
          <p className="mt-2 text-xs text-muted-foreground">new limit {e.limit.toFixed(2)} tUSDC</p>
        </div>
      );
    case "topup_timeout":
      return <div className={`${row} my-5 text-center`}><span className="stamp text-muted-foreground">No answer from owner</span></div>;
    case "topup_declined":
      return <div className={`${row} my-5 text-center`}><span className="stamp text-destructive">Owner declined</span></div>;
    case "say":
      return <p className={`${row} my-2 italic text-muted-foreground`}>» {e.text}</p>;
    case "report":
      return <pre className={`${row} mt-4 whitespace-pre-wrap border-t border-dashed pt-4 text-xs`}>{e.text}</pre>;
    case "error":
      return <p className={`${row} text-destructive`}>! {e.text}</p>;
    default:
      return null;
  }
}
