"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEvent } from "@/lib/agent";
import { DEFAULT_TASK, PRICE_RANGE } from "@/lib/catalog";
import { Button } from "@/components/ui/button";

const explorer = (kind: "tx" | "contract", id: string) => `https://stellar.expert/explorer/testnet/${kind}/${id}`;
const short = (s: string) => `${s.slice(0, 5)}…${s.slice(-5)}`;
// ponytail: mirrors smart-account-kit's constants without pulling the kit into this bundle
const LEDGERS_PER_HOUR = 720, LEDGERS_PER_DAY = 17280;
const period = (ledgers: number) =>
  ledgers >= LEDGERS_PER_DAY ? `${Math.round(ledgers / LEDGERS_PER_DAY)}d` : `${Math.max(1, Math.round(ledgers / LEDGERS_PER_HOUR))}h`;
type Allowance = { limit: number; spent: number; periodLedgers: number };

type Status = "idle" | "running" | "waiting" | "done";
type Stage = 0 | 1 | 2 | 3; // none, paying, refused, owner

export default function Dashboard() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<Stage>(0);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [task, setTask] = useState(DEFAULT_TASK);
  // absolute URL for the QR: only known in the browser, null during SSR
  const approveUrl = useSyncExternalStore(() => () => {}, () => `${location.origin}/approve`, () => null);
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
    const es = new EventSource(`/api/agent?task=${encodeURIComponent(task)}`);
    source.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as AgentEvent;
      if (e.t === "start") setWallet(e.wallet);
      if (e.t === "allowance") setAllowance({ limit: e.limit, spent: e.spent, periodLedgers: e.periodLedgers });
      if (e.t === "paid") setStage((s) => (s === 0 ? 1 : s));
      if (e.t === "refused" && e.code === 3221) setStage(2);
      if (e.t === "topup_request") { setStage(3); setStatus("waiting"); }
      if (e.t === "topup_approved" || e.t === "topup_declined" || e.t === "topup_timeout") setStatus("running");
      if (e.t === "done") { setStatus("done"); es.close(); return; }
      setEvents((prev) => [...prev, e]);
    };
    es.onerror = () => {
      setEvents((prev) => [...prev, { t: "error", text: "Lost the connection to /api/agent." }]);
      setStatus("done");
      es.close();
    };
  }

  const paidEvents = events.filter((e) => e.t === "paid");
  const total = paidEvents.reduce((sum, e) => sum + e.price, 0);
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

          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Task for the agent</span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={busy}
              rows={3}
              className="w-full resize-y rounded-lg border bg-card px-3 py-2.5 text-sm leading-relaxed shadow-2xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={run} disabled={busy || !task.trim()} className="h-12 px-7 text-base font-semibold shadow-md">
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
            <dt>policy</dt><dd>OpenZeppelin spending_limit · rolling {allowance ? period(allowance.periodLedgers) : "window"}</dd>
            <dt>price</dt><dd>{PRICE_RANGE} per call · HTTP 402</dd>
            <dt>data</dt><dd>live: CoinGecko · Finnhub · Open-Meteo · <a className="underline decoration-dotted hover:text-foreground" href="/api" target="_blank">/api</a></dd>
            <dt>owner</dt><dd><a className="underline decoration-dotted hover:text-foreground" href="/approve">/approve</a> on your phone — passkey holder, approves top-ups</dd>
          </dl>

          {approveUrl && (
            <a href="/approve" className="flex w-fit items-center gap-3 rounded-lg border bg-card p-2 pr-4 shadow-2xs hover:border-primary">
              {/* ponytail: hosted QR image; inline a QR lib if this ever needs to work offline */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=72x72&margin=0&data=${encodeURIComponent(approveUrl)}`}
                alt="QR code for the owner page" width={72} height={72} className="rounded-sm"
              />
              <span className="font-mono text-[11px] leading-snug text-muted-foreground">scan on your phone<br />to become the owner</span>
            </a>
          )}
        </section>

        <section aria-label="Agent receipt" className="rise min-w-0 [animation-delay:120ms]">
          <div className="receipt-wrap mx-auto max-w-xl">
          <div className="receipt rounded-t-lg">
            <div className="flex items-end justify-between border-b border-dashed px-6 pt-5 pb-4 font-mono">
              <div>
                <p className="text-sm font-bold tracking-[0.3em]">AGENT RECEIPT</p>
                <p className="mt-1 text-[11px] text-muted-foreground">merchant · /api/data/*</p>
              </div>
              <p className="text-[11px] text-muted-foreground" suppressHydrationWarning>{new Date().toISOString().slice(0, 10)}</p>
            </div>
            <div ref={tape} className="h-[56vh] min-h-80 overflow-y-auto px-6 py-4 font-mono text-[13px] leading-6" aria-live="polite">
              {events.length === 0 && <p className="py-20 text-center text-muted-foreground">— press “Run agent” —</p>}
              {events.map((e, i) => <Line key={i} e={e} />)}
            </div>
            <div className="flex justify-between border-t border-dashed px-6 pt-3 font-mono text-sm font-bold">
              <span>{paidEvents.length} paid call{paidEvents.length === 1 ? "" : "s"}</span>
              <span>TOTAL {total.toFixed(2)} tUSDC</span>
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

function Gauge({ allowance, status }: { allowance: Allowance | null; status: Status }) {
  const left = allowance ? Math.max(0, allowance.limit - allowance.spent) : null;
  const pct = allowance && allowance.limit > 0 ? Math.min(100, (allowance.spent / allowance.limit) * 100) : 0;
  const paused = allowance?.limit === 0;
  return (
    <div className="rounded-lg border bg-card p-5 shadow-md">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-muted-foreground">Allowance left{allowance ? ` this ${period(allowance.periodLedgers)}` : ""}</span>
        <span className="font-mono text-xs text-muted-foreground">{allowance ? `${allowance.spent.toFixed(2)} / ${allowance.limit.toFixed(2)} spent` : "—"}</span>
      </div>
      <p className={`mt-1 font-serif text-6xl font-semibold tabular-nums tracking-tight transition-colors ${left === 0 ? "text-destructive" : ""}`}>
        {left === null ? "—" : left.toFixed(2)} <span className="font-sans text-xl font-normal text-muted-foreground">tUSDC</span>
      </p>
      <div
        className={`mt-4 h-7 overflow-hidden rounded-sm bg-primary ${status === "waiting" ? "animate-pulse" : ""}`}
        role="meter" aria-valuemin={0} aria-valuemax={allowance?.limit ?? 0} aria-valuenow={left ?? 0} aria-label="Allowance left"
      >
        <div className="h-full bg-muted ring-1 ring-border ring-inset transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        {paused ? "paused by owner · limit is 0" : "amber = what the agent can still spend · set by the owner, enforced on chain"}
      </p>
    </div>
  );
}

function Line({ e }: { e: AgentEvent }) {
  const row = "print-in";
  switch (e.t) {
    case "call":
      return <p className={`${row} text-muted-foreground`}>GET {e.path}</p>;
    case "402":
      return <p className={`${row} text-muted-foreground`}>  ↳ 402 Payment Required · {e.price} tUSDC</p>;
    case "paid":
      return (
        <p className={`${row} flex justify-between gap-3 font-semibold`}>
          <span>✓ {e.item} · {e.quote.summary}</span>
          <a className="font-normal text-muted-foreground underline decoration-dotted hover:text-foreground" href={explorer("tx", e.tx)} target="_blank">tx {short(e.tx)} ↗</a>
        </p>
      );
    case "refused":
      if (e.code === 10) return (
        <div className={`${row} my-5 text-center`}>
          <span className="stamp text-lg text-destructive">Wallet empty</span>
          <p className="mt-2 text-xs text-muted-foreground">{e.item}: #10 tUSDC balance too low · nothing charged · add funds on /approve</p>
        </div>
      );
      return (
        <div className={`${row} my-5 text-center`}>
          <span className="stamp text-lg text-destructive">Refused by chain</span>
          <p className="mt-2 text-xs text-muted-foreground">
            {e.item}: #{e.code}{e.code === 3221 ? " SpendingLimitExceeded" : ""} · nothing charged
          </p>
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
