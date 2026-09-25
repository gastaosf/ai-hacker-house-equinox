// Discovery: what this merchant sells over x402. Free, no payment. JSON for agents, HTML for people.
import { CATALOG, PRICE_RANGE } from "@/lib/catalog";
import { NETWORK, X402_VERSION } from "@/lib/x402";

export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const doc = {
    x402Version: X402_VERSION,
    network: NETWORK,
    asset: { symbol: "tUSDC", contract: process.env.NEXT_PUBLIC_TUSDC },
    payTo: process.env.MERCHANT_ADDRESS,
    endpoints: CATALOG.map((e) => ({
      path: `/api/data/${e.kind}`,
      method: "GET",
      params: { [e.param]: "string" },
      price: `${e.price} tUSDC`,
      description: e.description,
      source: e.source,
      example: `${origin}/api/data/${e.kind}?${e.param}=${encodeURIComponent(e.example)}`,
    })),
    flow: "GET → 402 with PAYMENT-REQUIRED header → retry with PAYMENT-SIGNATURE → 200 with PAYMENT-RESPONSE. Not charged on 404/502.",
  };
  if (!req.headers.get("accept")?.includes("text/html")) return Response.json(doc);

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rows = doc.endpoints.map((e) => `
    <tr><td><code>GET ${e.path}</code></td><td><code>${Object.keys(e.params)[0]}</code></td><td>${esc(e.description)}</td><td>${e.source}</td><td><b>${e.price}</b></td>
    <td><a href="${e.example}">try ↗</a></td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allowance · API</title>
<style>
  :root{color-scheme:light;--fg:#2b2b2b;--mute:#6b6f7a;--line:#e5e6ea;--amber:#e6a100;--card:#fff}
  body{margin:0;padding:40px 24px;font:15px/1.55 system-ui,sans-serif;color:var(--fg);max-width:56rem;margin-inline:auto}
  h1{font-family:Georgia,"Source Serif 4",serif;font-size:2.4rem;margin:0 0 .25rem}
  h1 em{color:var(--amber);font-style:italic} p{color:var(--mute);margin:.25rem 0}
  code,pre{font-family:ui-monospace,Menlo,monospace;font-size:13px} pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow:auto}
  table{width:100%;border-collapse:collapse;margin:1.5rem 0;background:var(--card);border:1px solid var(--line);border-radius:6px}
  th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line);vertical-align:top} th{border-top:0;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--mute)}
  a{color:inherit} dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute)} dd{margin:0;color:var(--fg);word-break:break-all}
</style></head><body>
<h1>Allowance <em>API</em></h1>
<p>Paid data over <a href="https://www.x402.org">x402</a>. Calls cost <b>${PRICE_RANGE}</b> on ${doc.network}. No API keys: pay per request.</p>
<table><thead><tr><th>endpoint</th><th>param</th><th>returns</th><th>source</th><th>price</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<dl><dt>asset</dt><dd>${doc.asset.contract}</dd><dt>pay to</dt><dd>${doc.payTo}</dd><dt>x402</dt><dd>v${doc.x402Version} · scheme exact · fees sponsored</dd></dl>
<h3>Flow</h3>
<pre>${esc(doc.flow)}

$ curl -i ${doc.endpoints[0].example}
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Miw…      # what to pay, to whom

$ curl -H "PAYMENT-SIGNATURE: &lt;signed transfer&gt;" ${doc.endpoints[0].example}
HTTP/1.1 200 OK
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLC…      # settlement tx hash
{"symbol":"BTC","price":84585,"change24h":"+1.25%","summary":"$84,585 (+1.25%)","source":"CoinGecko"}</pre>
<p>Same document as JSON: <code>curl -H "Accept: application/json" ${origin}/api</code> · <a href="/">dashboard</a></p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
