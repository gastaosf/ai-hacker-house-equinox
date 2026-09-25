# Allowance

**An AI agent with an allowance.** It pays for every API call by itself, over [x402](https://www.x402.org), from a smart wallet on Stellar. The blockchain, not the app, caps what it can spend. When it runs dry, it has to ask its owner, who approves with a passkey on their phone.

## What happens in a run

1. The owner opens **`/approve`** on a phone, picks what the agent may spend (say **2 tUSDC per day**, or per hour, or per week) and taps once. That creates a passkey smart wallet (OpenZeppelin smart account), grants the agent a rule with a **spending-limit policy** for that amount, and funds it with 10 test USDC.
2. On the dashboard **`/`** you give the agent a task: crypto prices, stock quotes, weather, anything the API sells. Calls cost **0.1 to 1 tUSDC** depending on the endpoint, so the agent has to budget.
3. The agent calls `/api/data/…`, gets **HTTP 402**, signs a tUSDC transfer with its session key, and retries. The data comes back with the settlement tx in the `PAYMENT-RESPONSE` header. Live data, real testnet transactions.
4. When the next call would cross the limit, the chain **refuses** the signature (`SpendingLimitExceeded`, error `#3221`). Nothing is charged. The agent can't override this: the limit lives in a policy contract, not in a prompt.
5. The agent asks the owner for a top-up with a one-line reason. The phone buzzes. The owner can grant what was asked, **more, or less**, and **approves with their passkey**, which raises the on-chain limit. The agent picks up where it left off, or stops if declined.
6. It ends with a briefing table and a line stating what it spent.

```
agent ──GET──▶ /api/data/crypto?symbol=BTC ──402 PAYMENT-REQUIRED──▶ agent
agent ──sign transfer (session key, rule #1)──▶ Stellar: __check_auth → spending_limit policy
   ├─ under limit  → PAYMENT-SIGNATURE ──▶ merchant verifies + settles ──▶ 200 + data
   └─ over limit   → #3221 refused ──▶ ntfy ──▶ owner's phone ──passkey──▶ set_spending_limit
```

## The API

`GET /api` lists what the merchant sells (HTML in a browser, JSON for agents). No API keys: pay per request.

| endpoint | param | source | price |
|---|---|---|---|
| `/api/data/crypto` | `symbol` (BTC, XLM, …) | CoinGecko | 0.5 tUSDC |
| `/api/data/stock` | `symbol` (AAPL, NVDA, …) | Finnhub | 1 tUSDC |
| `/api/data/weather` | `city` (Lisbon, Tokyo, …) | Open-Meteo | 0.1 tUSDC |

Prices live in `lib/catalog.ts`; the paywall, the `/api` page and the agent's tools all read from there.

The merchant settles the payment only after the upstream data arrives. An unknown ticker or a failing upstream returns 404/502 and charges nothing.

## What the owner controls

Everything below is a passkey-signed contract call, not an app setting:

- **The allowance**: amount and window (hour / day / week), chosen at setup.
- **Top-ups**: approve the amount the agent asked for, or a different one, or decline.
- **Pause**: sets the limit to 0 on chain, so every payment is refused until resumed. The cheapest kill switch there is.

The agent's key is scoped to `CallContract(tUSDC)` under this one rule. It can pay this token, within the cap, and nothing else: no other contract, no rule changes, no adding signers.

## Stack

- **Stellar testnet**: [smart-account-kit](https://github.com/stellar/smart-account-kit) (OpenZeppelin smart accounts), passkeys via WebAuthn verifier, `spending_limit` policy, SDF relayer for gas.
- **x402**: `@x402/core` + `@x402/stellar`, exact scheme, in-process facilitator. Two small patches for smart-account payers in `lib/x402.ts`.
- **Agent**: OpenAI tool loop (`lib/agent.ts`), one tool per catalogue entry plus `request_topup`.
- **Phone ↔ agent**: [ntfy.sh](https://ntfy.sh) as a zero-setup message bus. Approval itself is read from the chain, not from the message.
- Next.js 16, React 19, Tailwind 4, shadcn.

## Run it

```bash
pnpm install
pnpm setup              # testnet keys, tUSDC asset, merchant trustline → .env.local
# add OPENAI_API_KEY and FINNHUB_API_KEY to .env.local (see .env.example)
pnpm dev
```

Open `/approve` on a phone (or `pnpm setup --dev-wallet` + `pnpm dev-approve` to stand in for the phone from a laptop), then `/` to run the agent.

`pnpm check` makes one real paid purchase against the running app and asserts the on-chain allowance moved by exactly the price.

## Why this matters

Agents that hold keys can spend without limit. Prompt-level budgets are suggestions. Here the budget is a contract the agent's key cannot change: the chain says no, and the only way past it is a human with a passkey. Every top-up is an explicit, signed, auditable decision.
