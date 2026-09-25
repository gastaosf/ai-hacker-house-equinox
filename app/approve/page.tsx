"use client";

// The owner's phone. Holds the passkey (the wallet's admin signer). Listens for the agent's top-up
// requests over ntfy and raises the on-chain spending limit when the owner approves.
import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import type { SmartAccountKit } from "smart-account-kit";
import { Button } from "@/components/ui/button";
import {
  ACCOUNT_WASM_HASH, DEFAULT_ALLOWANCE_TUSDC, ED25519_VERIFIER, RELAYER_URL, RPC_URL, SPENDING_LIMIT_POLICY, STROOPS, WEBAUTHN_VERIFIER,
} from "@/lib/contracts";

const TOPIC = process.env.NEXT_PUBLIC_NTFY_TOPIC!;
const TUSDC = process.env.NEXT_PUBLIC_TUSDC!;
const AGENT_PUBKEY = process.env.NEXT_PUBLIC_AGENT_PUBKEY!;
const RULE_KEY = "allowance.agentRuleId";
const PAUSED_KEY = "allowance.limitBeforePause";
const PERIODS = { hour: "per hour", day: "per day", week: "per week" } as const;
type Period = keyof typeof PERIODS;

type Request = { amount: number; reason: string; wallet: string; ruleId: number };
type Phase =
  | { k: "boot" } | { k: "setup" } | { k: "working"; step: string } | { k: "ready" }
  | { k: "request"; req: Request } | { k: "approved"; hash: string; limit: number } | { k: "error"; msg: string };

const ntfy = (message: object) => fetch(`https://ntfy.sh/${TOPIC}`, { method: "POST", body: JSON.stringify(message) });


export default function Approve() {
  const kit = useRef<SmartAccountKit | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "boot" });
  const [wallet, setWallet] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState(1);
  const [limit, setLimit] = useState<{ limit: number; spent: number } | null>(null);
  // setup form
  const [amount, setAmount] = useState(String(DEFAULT_ALLOWANCE_TUSDC));
  const [period, setPeriod] = useState<Period>("day");
  // top-up form: the owner can approve a different amount than the agent asked for
  const [grant, setGrant] = useState("");
  // allowance editor: null = untouched, shows the current on-chain limit
  const [edit, setEdit] = useState<string | null>(null);
  const paused = limit?.limit === 0;

  async function refreshLimit(id: number) {
    const d = await kit.current!.policyClients.spendingLimit(SPENDING_LIMIT_POLICY).getSpendingLimitData(id);
    setLimit({ limit: Number(d.spending_limit) / STROOPS, spent: Number(d.cached_total_spent) / STROOPS });
  }

  useEffect(() => {
    (async () => {
      const { SmartAccountKit, IndexedDBStorage } = await import("smart-account-kit");
      kit.current = new SmartAccountKit({
        rpcUrl: RPC_URL,
        networkPassphrase: "Test SDF Network ; September 2015",
        accountWasmHash: ACCOUNT_WASM_HASH,
        webauthnVerifierAddress: WEBAUTHN_VERIFIER,
        ed25519VerifierAddress: ED25519_VERIFIER,
        relayerUrl: RELAYER_URL,
        storage: new IndexedDBStorage(),
        rpName: "Allowance",
      });
      const id = Number(localStorage.getItem(RULE_KEY) ?? 1);
      setRuleId(id);
      try {
        const restored = await kit.current.connectWallet();
        if (!restored) return setPhase({ k: "setup" });
        setWallet(kit.current.contractId!);
        setPhase({ k: "ready" });
        refreshLimit(id).catch(() => setTimeout(() => refreshLimit(id).catch(() => {}), 2000));
      } catch {
        setPhase({ k: "setup" });
      }
    })();
  }, []);

  // Tell the agent which wallet to spend from (it reads the latest announcement).
  useEffect(() => {
    if (wallet) ntfy({ type: "wallet", wallet, ruleId });
  }, [wallet, ruleId]);

  // Listen for the agent's requests once a wallet is connected.
  useEffect(() => {
    if (!wallet) return;
    // since=2m: also catch a request sent just before the page opened
    const es = new EventSource(`https://ntfy.sh/${TOPIC}/sse?since=2m`);
    es.onmessage = (m) => {
      try {
        const msg = JSON.parse(JSON.parse(m.data).message);
        if (msg.type !== "topup" || msg.wallet !== wallet) return;
        navigator.vibrate?.([200, 100, 200]);
        setGrant(String(msg.amount));
        setPhase({ k: "request", req: msg });
      } catch { /* not ours */ }
    };
    return () => es.close();
  }, [wallet]);

  async function setup() {
    const k = kit.current!;
    const { createCallContractContext, createEd25519Signer, createSpendingLimitParams, LEDGERS_PER_HOUR, LEDGERS_PER_DAY, LEDGERS_PER_WEEK } = await import("smart-account-kit");
    const ledgers = { hour: LEDGERS_PER_HOUR, day: LEDGERS_PER_DAY, week: LEDGERS_PER_WEEK }[period];
    const tusdc = Number(amount);
    if (!(tusdc > 0)) return setPhase({ k: "error", msg: "Allowance must be a positive number." });
    try {
      setPhase({ k: "working", step: "Creating your passkey + smart wallet…" });
      const created = await k.createWallet("Allowance", "owner", { autoSubmit: true });
      if (created.submitResult && !created.submitResult.success) throw new Error(created.submitResult.error.message);
      const contractId = created.contractId;

      setPhase({ k: "working", step: `Granting the agent ${tusdc} tUSDC ${PERIODS[period]}…` });
      const params = k.convertPolicyParams("spending_limit", createSpendingLimitParams(BigInt(Math.round(tusdc * STROOPS)), ledgers));
      const tx = await k.rules.add(
        createCallContractContext(TUSDC),
        "agent",
        [createEd25519Signer(ED25519_VERIFIER, Buffer.from(AGENT_PUBKEY, "hex"))],
        new Map([[SPENDING_LIMIT_POLICY, params]]),
      );
      const added = await k.signAndSubmitAdmin(tx);
      if (!added.success) throw new Error(added.error.message);
      const id = (await k.rules.count()) - 1;
      localStorage.setItem(RULE_KEY, String(id));
      setRuleId(id);

      setPhase({ k: "working", step: "Funding with 10 test USDC…" });
      const funded = await fetch("/api/fund", { method: "POST", body: JSON.stringify({ wallet: contractId }) });
      if (!funded.ok) throw new Error((await funded.json()).error);

      setWallet(contractId);
      await refreshLimit(id);
      setPhase({ k: "ready" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  /** Passkey-signed `set_spending_limit` on the agent's rule. Returns the tx hash. */
  async function writeLimit(id: number, newLimit: bigint) {
    const k = kit.current!;
    setPhase({ k: "working", step: "Confirm with your screen lock…" });
    const policy = k.policyClients.spendingLimit(SPENDING_LIMIT_POLICY);
    const { result: rule } = await k.rules.get(id);
    const res = await k.signAndSubmitAdmin(await policy.setSpendingLimit(newLimit, rule));
    if (!res.success) throw new Error(res.error.message);
    await refreshLimit(id);
    return res.hash;
  }

  async function approve(req: Request) {
    const extra = Number(grant);
    if (!(extra > 0)) return;
    try {
      const current = await kit.current!.policyClients.spendingLimit(SPENDING_LIMIT_POLICY).getSpendingLimitData(req.ruleId);
      const newLimit = current.spending_limit + BigInt(Math.round(extra * STROOPS));
      const hash = await writeLimit(req.ruleId, newLimit);
      ntfy({ type: "approved", hash });
      setPhase({ k: "approved", hash, limit: Number(newLimit) / STROOPS });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  // Pause = limit 0 on chain: every payment is refused until the owner resumes. Resume restores the previous limit.
  async function pause() {
    try {
      localStorage.setItem(PAUSED_KEY, String(limit?.limit ?? DEFAULT_ALLOWANCE_TUSDC));
      await writeLimit(ruleId, 0n);
      setPhase({ k: "ready" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }
  async function resume() {
    try {
      const restore = Number(localStorage.getItem(PAUSED_KEY)) || DEFAULT_ALLOWANCE_TUSDC;
      await writeLimit(ruleId, BigInt(Math.round(restore * STROOPS)));
      setPhase({ k: "ready" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  // Owner sets the limit directly. The window (hour/day/week) is fixed at setup; spent-so-far still counts against it.
  async function setAllowance() {
    const tusdc = Number(edit);
    if (!(tusdc >= 0) || edit === null || edit === "") return;
    try {
      await writeLimit(ruleId, BigInt(Math.round(tusdc * STROOPS)));
      setEdit(null);
      setPhase({ k: "ready" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  // Testnet only: mints 10 tUSDC into the wallet (the allowance caps spending; this is the money it spends)
  async function addFunds() {
    if (!wallet) return;
    try {
      setPhase({ k: "working", step: "Adding 10 test USDC…" });
      const r = await fetch("/api/fund", { method: "POST", body: JSON.stringify({ wallet }) });
      if (!r.ok) throw new Error((await r.json()).error);
      setPhase({ k: "ready" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  function decline() {
    if (!wallet) return;
    ntfy({ type: "declined", wallet });
    setPhase({ k: "ready" });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary font-serif text-lg font-semibold text-primary-foreground shadow-sm">A</span>
          <h1 className="font-semibold tracking-tight">Allowance</h1>
        </div>
        <span className="rounded-md border bg-card px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-2xs">owner · phone</span>
      </header>

      {wallet && (
        <div className="rounded-lg border border-border bg-card shadow-md p-4 font-mono text-xs text-muted-foreground">
          <div className="flex justify-between gap-4"><span>wallet</span><span className="select-all break-all text-right text-foreground">{wallet}</span></div>
          <div className="flex justify-between"><span>agent allowance</span>
            <span className="text-foreground">{limit ? `${(limit.limit - limit.spent).toFixed(2)} of ${limit.limit.toFixed(2)} left` : "…"}</span>
          </div>
          <div className="flex justify-between"><span>agent rule</span><span>#{ruleId}</span></div>
        </div>
      )}

      {phase.k === "boot" && <p className="text-muted-foreground">Loading wallet…</p>}

      {phase.k === "setup" && (
        <section className="space-y-4">
          <p>One-time setup: this phone becomes the owner of a smart wallet on Stellar testnet. Your passkey is the only key that can change the agent’s allowance.</p>
          <div className="rounded-lg border bg-card p-4 shadow-2xs">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Agent may spend</p>
            <div className="flex items-stretch gap-2">
              <label className="flex flex-1 items-baseline gap-1.5 rounded-md border px-3 focus-within:ring-2 focus-within:ring-ring/50">
                <input
                  type="number" inputMode="decimal" min="0" step="0.1" value={amount} onChange={(e) => setAmount(e.target.value)}
                  aria-label="Allowance amount in tUSDC" className="w-full bg-transparent py-2.5 font-serif text-3xl font-semibold tabular-nums outline-none"
                />
                <span className="text-sm text-muted-foreground">tUSDC</span>
              </label>
              <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Allowance period"
                className="rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                {Object.entries(PERIODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">rolling window, enforced by the spending_limit policy contract</p>
          </div>
          <Button size="lg" className="h-12 w-full text-base font-semibold shadow-md" onClick={setup} disabled={!(Number(amount) > 0)}>Create wallet with passkey</Button>
        </section>
      )}

      {phase.k === "working" && (
        <p className="flex items-center gap-3 font-mono text-sm"><span className="size-2 animate-pulse rounded-full bg-primary" />{phase.step}</p>
      )}

      {phase.k === "ready" && (
        <section className="space-y-4">
          <p className="flex items-center gap-3 font-mono text-sm text-muted-foreground">
            <span className={`size-2 rounded-full ${paused ? "bg-destructive" : "animate-pulse bg-success"}`} />
            {paused ? "Agent paused: every payment is refused on chain." : "Listening for requests from your agent…"}
          </p>
          {wallet && (
            <div className="rounded-lg border bg-card p-4 shadow-2xs">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Agent allowance</p>
              <div className="flex items-stretch gap-2">
                <label className="flex flex-1 items-baseline gap-1.5 rounded-md border px-3 focus-within:ring-2 focus-within:ring-ring/50">
                  <input
                    type="number" inputMode="decimal" min="0" step="0.1"
                    value={edit ?? (limit ? String(limit.limit) : "")} onChange={(e) => setEdit(e.target.value)} placeholder="…"
                    aria-label="New allowance in tUSDC" className="w-full bg-transparent py-2.5 font-serif text-3xl font-semibold tabular-nums outline-none"
                  />
                  <span className="text-sm text-muted-foreground">tUSDC</span>
                </label>
                <Button size="lg" className="h-auto px-5 font-semibold shadow-md" onClick={setAllowance}
                  disabled={edit === null || edit === "" || !(Number(edit) >= 0) || Number(edit) === limit?.limit}>
                  Set
                </Button>
              </div>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                {limit ? `${limit.spent.toFixed(2)} spent in the current window` : "reading current limit…"} · raise or lower it any time · signed with your passkey
              </p>
            </div>
          )}
          {paused
            ? <Button size="lg" className="h-12 w-full text-base font-semibold shadow-md" onClick={resume}>Resume agent</Button>
            : <Button size="lg" variant="outline" className="h-12 w-full text-base" onClick={pause}>Pause agent</Button>}
          <Button size="lg" variant="ghost" className="w-full" onClick={addFunds}>Add 10 test USDC to the wallet</Button>
        </section>
      )}

      {phase.k === "request" && (
        <section className="print-in space-y-5 rounded-xl border-2 border-primary bg-accent text-accent-foreground p-5">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-primary">Your agent is out of allowance</p>
          <p className="text-lg italic">“{phase.req.reason}”</p>
          <label className="flex items-baseline gap-2 rounded-md border bg-background px-3 focus-within:ring-2 focus-within:ring-ring/50">
            <span className="font-serif text-5xl font-semibold">+</span>
            <input
              type="number" inputMode="decimal" min="0" step="0.1" value={grant} onChange={(e) => setGrant(e.target.value)}
              aria-label="Amount to grant in tUSDC" className="w-full bg-transparent py-2 font-serif text-5xl font-semibold tabular-nums outline-none"
            />
            <span className="text-xl text-muted-foreground">tUSDC</span>
          </label>
          <p className="font-mono text-xs text-muted-foreground">
            agent asked for {phase.req.amount}{Number(grant) !== phase.req.amount && Number(grant) > 0 ? ` · you’re granting ${grant}` : ""}
          </p>
          <Button size="lg" className="h-14 w-full text-lg font-semibold shadow-md" onClick={() => approve(phase.req)} disabled={!(Number(grant) > 0)}>
            Approve {Number(grant) > 0 ? `+${grant} ` : ""}with passkey
          </Button>
          <Button size="lg" variant="ghost" className="w-full" onClick={decline}>Decline</Button>
        </section>
      )}

      {phase.k === "approved" && (
        <section className="space-y-4 text-center">
          <span className="stamp text-2xl text-success">Approved</span>
          <p className="font-mono text-sm">New limit {phase.limit.toFixed(2)} tUSDC</p>
          <a className="font-mono text-xs underline" href={`https://stellar.expert/explorer/testnet/tx/${phase.hash}`} target="_blank">view transaction ↗</a>
          <Button variant="ghost" className="w-full" onClick={() => setPhase({ k: "ready" })}>Done</Button>
        </section>
      )}

      {phase.k === "error" && (
        <section className="space-y-3">
          <p className="text-destructive">Something went wrong: {phase.msg}</p>
          <Button variant="outline" onClick={() => setPhase(wallet ? { k: "ready" } : { k: "setup" })}>Back</Button>
        </section>
      )}
    </main>
  );
}
