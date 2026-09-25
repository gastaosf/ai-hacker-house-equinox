// Paid endpoints. Read by GET /api (discovery), the paywall (price) and the agent (one tool per entry).
export const CATALOG = [
  { kind: "crypto", tool: "get_crypto_quote", param: "symbol", example: "BTC", source: "CoinGecko", price: 0.5,
    description: "Live price and 24h change for a crypto asset symbol, e.g. BTC." },
  { kind: "stock", tool: "get_stock_quote", param: "symbol", example: "AAPL", source: "Finnhub", price: 1,
    description: "Live price and daily change for a US stock ticker, e.g. AAPL." },
  { kind: "weather", tool: "get_weather", param: "city", example: "Lisbon", source: "Open-Meteo", price: 0.1,
    description: "Current temperature, conditions and wind for a city name, e.g. Lisbon." },
] as const;

export type Kind = (typeof CATALOG)[number]["kind"];
export const entry = (kind: Kind) => CATALOG.find((e) => e.kind === kind)!;
export const PRICES = CATALOG.map((e) => e.price);
export const PRICE_RANGE = `${Math.min(...PRICES)}–${Math.max(...PRICES)} tUSDC`;

// 6.4 tUSDC of items against the default 2 tUSDC/day allowance: the chain refuses part-way.
export const DEFAULT_TASK =
  "Build a short morning briefing. Buy every item: crypto XLM, BTC, ETH, SOL; stocks AAPL, NVDA, TSLA, MSFT; weather in Lisbon, New York, Tokyo, São Paulo.";
