"use client";

// The owner's phone. Holds the passkey (the wallet's admin signer). Listens for the agent's top-up
// requests over ntfy and raises the on-chain spending limit when the owner approves.
import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import type { SmartAccountKit } from "smart-account-kit";
import { Button } from "@/components/ui/button";
import {
  ACCOUNT_WASM_HASH, ED25519_VERIFIER, RELAYER_URL, RPC_URL, SPENDING_LIMIT_POLICY, STROOPS, WEBAUTHN_VERIFIER,
} from "@/lib/contracts";

const TOPIC = process.env.NEXT_PUBLIC_NTFY_TOPIC!;
const TUSDC = process.env.NEXT_PUBLIC_TUSDC!;
const AGENT_PUBKEY = process.env.NEXT_PUBLIC_AGENT_PUBKEY!;
const RULE_KEY = "allowance.agentRuleId";

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
        refreshLimit(id).catch(() => {});
      } catch {
        setPhase({ k: "setup" });
      }
    })();
  }, []);

  // Listen for the agent's requests once a wallet is connected.
  useEffect(() => {
    if (!wallet) return;
    const es = new EventSource(`https://ntfy.sh/${TOPIC}/sse`);
    es.onmessage = (m) => {
      try {
        const msg = JSON.parse(JSON.parse(m.data).message);
        if (msg.type !== "topup" || msg.wallet !== wallet) return;
        navigator.vibrate?.([200, 100, 200]);
        setPhase({ k: "request", req: msg });
      } catch { /* not ours */ }
    };
    return () => es.close();
  }, [wallet]);

  async function setup() {
    const k = kit.current!;
    const { createCallContractContext, createEd25519Signer, createSpendingLimitParams, LEDGERS_PER_DAY } = await import("smart-account-kit");
    try {
      setPhase({ k: "working", step: "Creating your passkey + smart wallet…" });
      const created = await k.createWallet("Allowance", "owner", { autoSubmit: true });
      if (created.submitResult && !created.submitResult.success) throw new Error(created.submitResult.error.message);
      const contractId = created.contractId;

      setPhase({ k: "working", step: "Granting the agent a 2 tUSDC/day allowance…" });
      const params = k.convertPolicyParams("spending_limit", createSpendingLimitParams(BigInt(2 * STROOPS), LEDGERS_PER_DAY));
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

  async function approve(req: Request) {
    const k = kit.current!;
    try {
      setPhase({ k: "working", step: "Confirm with your screen lock…" });
      const policy = k.policyClients.spendingLimit(SPENDING_LIMIT_POLICY);
      const current = await policy.getSpendingLimitData(req.ruleId);
      const newLimit = current.spending_limit + BigInt(Math.round(req.amount * STROOPS));
      const { result: rule } = await k.rules.get(req.ruleId);
      const res = await k.signAndSubmitAdmin(await policy.setSpendingLimit(newLimit, rule));
      if (!res.success) throw new Error(res.error.message);
      ntfy({ type: "approved", hash: res.hash });
      await refreshLimit(req.ruleId);
      setPhase({ k: "approved", hash: res.hash, limit: Number(newLimit) / STROOPS });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  function decline() {
    ntfy({ type: "declined" });
    setPhase({ k: "ready" });
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-heading text-4xl">Allowance</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">owner</span>
      </header>

      {wallet && (
        <div className="rounded-lg border border-border bg-card/60 p-4 font-mono text-xs text-muted-foreground">
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
          <Button size="lg" className="w-full" onClick={setup}>Create wallet with passkey</Button>
        </section>
      )}

      {phase.k === "working" && (
        <p className="flex items-center gap-3 font-mono text-sm"><span className="size-2 animate-pulse rounded-full bg-signal" />{phase.step}</p>
      )}

      {phase.k === "ready" && (
        <p className="flex items-center gap-3 font-mono text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-ok" /> Listening for requests from your agent…
        </p>
      )}

      {phase.k === "request" && (
        <section className="print-in space-y-5 rounded-xl border-2 border-signal bg-signal/10 p-5">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-signal">Your agent is out of allowance</p>
          <p className="font-heading text-6xl">+{phase.req.amount} <span className="text-2xl text-muted-foreground">tUSDC</span></p>
          <p className="text-lg italic">“{phase.req.reason}”</p>
          <Button size="lg" className="h-14 w-full bg-signal text-lg text-black hover:bg-signal/90" onClick={() => approve(phase.req)}>
            Approve with passkey
          </Button>
          <Button size="lg" variant="ghost" className="w-full" onClick={decline}>Decline</Button>
        </section>
      )}

      {phase.k === "approved" && (
        <section className="space-y-4 text-center">
          <span className="stamp text-2xl text-ok">Approved</span>
          <p className="font-mono text-sm">New limit {phase.limit.toFixed(2)} tUSDC</p>
          <a className="font-mono text-xs underline" href={`https://stellar.expert/explorer/testnet/tx/${phase.hash}`} target="_blank">view transaction ↗</a>
          <Button variant="ghost" className="w-full" onClick={() => setPhase({ k: "ready" })}>Done</Button>
        </section>
      )}

      {phase.k === "error" && (
        <section className="space-y-3">
          <p className="text-deny">Something went wrong: {phase.msg}</p>
          <Button variant="outline" onClick={() => setPhase(wallet ? { k: "ready" } : { k: "setup" })}>Back</Button>
        </section>
      )}
    </main>
  );
}
