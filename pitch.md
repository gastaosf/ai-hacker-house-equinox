# Allowance: 60-second live demo

## Before you go on stage (2 min)

- [ ] Laptop: https://agent-allowance-ten.vercel.app open and refreshed. The gauge shows a number, not "—".
- [ ] Phone: `/approve` open, wallet connected, showing "Listening for requests…". Vibration on, screen lock ready.
- [ ] **Set the allowance so the chain refuses early.** On the phone, set it to about *spent + 1.5* (the card shows "X spent in the current window"). That leaves room for a few purchases before the refusal.
- [ ] Wallet has money: if the receipt ever says "Wallet empty", tap **Add 10 test USDC** on the phone.
- [ ] Task box: use a short one so it fits in 60s:
  `Morning briefing: BTC, ETH, NVDA, AAPL, and the weather in Lisbon and Tokyo.`

---

## Script

**[0:00 to 0:10] The problem**
*(Dashboard on screen.)*

> AI agents are starting to pay for things. Give one a wallet today and it can spend everything in it. A budget in the prompt is a suggestion, not a limit.

**[0:10 to 0:25] Pay per call**
*(Click **Run agent**. Receipt starts printing.)*

> This agent has an allowance. It buys live data (crypto, stocks, weather) and pays for every single API call itself, over x402. The server answers "402 Payment Required", the agent signs a USDC transfer from its smart wallet, and gets the data. Each of these lines is a real Stellar transaction; you can click through to the explorer.

**[0:25 to 0:40] The chain says no**
*(Refused stamp appears. Gauge hits zero.)*

> And here it runs out. That refusal isn't my server. It's the smart wallet's spending-limit policy on chain. The agent's key cannot get past it, no matter what the prompt says. Nothing was charged.

**[0:40 to 0:55] You approve**
*(Phone buzzes. Hold it up to the audience.)*

> So it does the only thing it can: it asks me. I get the request and its reason on my phone. I can grant exactly what it asked, more, or less. I approve with my passkey…
*(Approve. "Approved" stamp on the receipt, agent keeps buying.)*
> …the limit moves on chain, and the agent picks up where it left off.

**[0:55 to 1:00] Close**
*(Report table prints.)*

> Agents that pay their own way, with limits they can't break. That's Allowance.

---

## If something goes wrong

| On screen | Say | Do |
|---|---|---|
| "Wallet empty" stamp | "The allowance is fine, the wallet itself is empty. That's the token contract saying no." | Phone: **Add 10 test USDC**, run again |
| No refusal, all items bought | "It stayed inside its budget this time." | Phone: lower the allowance, run again |
| Phone doesn't buzz | *(Keep talking about the policy.)* | Reload `/approve`; it replays requests from the last 2 minutes |
| "No wallet yet" | | Open `/approve` on the phone so it announces the wallet |

## One-liners for Q&A

- **What else can the agent do?** Nothing but pay this one token, within the cap. Its key is scoped to a single contract call under one rule. It can't add signers or change its own limit.
- **Why Stellar?** Smart accounts with policy contracts and passkey signers are built in, fees are tiny, and settlement takes seconds, which is what per-request payments need.
- **Is the money real?** Real transactions on testnet. tUSDC is a test asset we issue. Swapping in Circle's testnet USDC is a config change.
- **What if the owner says no?** The agent stops buying and reports with what it has.
