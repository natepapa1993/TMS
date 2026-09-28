/**
 * Currency rules, with no database (the browser uses them too). One home currency, USD: reports, margins
 * and RPM are in USD. A MXN or CAD amount is converted with a rate written as "units of that currency per
 * 1 USD" (18.45 MXN per USD, 1.37 CAD per USD), stored × 10,000 (184500, 13700).
 *
 * Which rate converts an amount, in this order:
 *   1. the rate stored on the invoice when it was issued;
 *   2. otherwise the company's latest rate for that currency (Settings → Company; every invoice issued
 *      with a rate also updates it);
 *   3. otherwise a built-in default (MXN 18.00, CAD 1.37), labelled "default" so it is never silent.
 * Amounts in different currencies are never added together without converting them first.
 */

export const CURRENCIES = ["USD", "MXN", "CAD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const HOME_CURRENCY: Currency = "USD";
export const SYMBOL: Record<string, string> = { USD: "$", MXN: "MX$", CAD: "CA$" };
export const DEFAULT_RATES_E4: Record<string, number> = { MXN: 180000, CAD: 13700 };
/** Sanity bounds for a typed rate, so "0.054" (USD per peso, the wrong way round) is caught. */
export const RATE_BOUNDS: Record<string, [number, number]> = { MXN: [5, 50], CAD: [0.8, 2.5] };

export type FxRateSource = "home" | "invoice" | "company" | "default";
export type FxRates = Partial<Record<string, { rateE4: number; at: string }>>;

export const isCurrency = (c: unknown): c is Currency => typeof c === "string" && (CURRENCIES as readonly string[]).includes(c);

/** "$1,234.50", "MX$53,100.00", "CA$2,590.00"; with `code`, non-USD amounts end in the ISO code ("CA$2,590.00 CAD"). */
export function money(cents: number | null | undefined, currency = "USD", opts: { code?: boolean; decimals?: 0 | 2 } = {}) {
  if (cents == null) return "";
  const d = opts.decimals ?? 2;
  const body = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const out = `${cents < 0 ? "-" : ""}${SYMBOL[currency] ?? `${currency} `}${body}`;
  return opts.code && currency !== "USD" ? `${out} ${currency}` : out;
}

/** "18.4500 MXN per USD" */
export const rateLabel = (rateE4: number, currency: string) => `${(rateE4 / 10000).toFixed(4)} ${currency} per USD`;

/** Parse a typed rate ("18.45") for a currency; throws a plain-English message when it can't be right. */
export function parseRate(input: string | number | null | undefined, currency: string): number {
  const n = typeof input === "number" ? input : Number(String(input ?? "").replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`enter the exchange rate: ${currency} per 1 USD (e.g. ${currency === "CAD" ? "1.37" : "18.45"})`);
  const b = RATE_BOUNDS[currency];
  if (b && (n < b[0] || n > b[1])) throw new Error(`${n} ${currency} per USD doesn't look right — type how many ${currency} buy 1 USD (e.g. ${currency === "CAD" ? "1.37" : "18.45"})`);
  return Math.round(n * 10000);
}

/** Convert to USD with a rate × 10,000 (foreign per USD). USD passes through. */
export function toHome(cents: number, currency: string, rateE4: number | null | undefined): number {
  if (!currency || currency === HOME_CURRENCY) return cents;
  if (!rateE4 || rateE4 <= 0) throw new Error(`no exchange rate for ${currency}`);
  return Math.round((cents * 10000) / rateE4);
}

/** The rate for an amount: the invoice's own, else the company's latest, else the default. */
export function pickRate(currency: string, invoiceRateE4: number | null | undefined, company: FxRates | null | undefined): { rateE4: number; source: FxRateSource } {
  if (!currency || currency === HOME_CURRENCY) return { rateE4: 10000, source: "home" };
  if (invoiceRateE4 && invoiceRateE4 > 0) return { rateE4: invoiceRateE4, source: "invoice" };
  const c = company?.[currency]?.rateE4;
  if (c && c > 0) return { rateE4: c, source: "company" };
  return { rateE4: DEFAULT_RATES_E4[currency] ?? 10000, source: "default" };
}

/** Totals kept apart by currency: never add pesos to dollars. */
export function sumByCurrency<T>(rows: T[], currency: (r: T) => string, cents: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const c = currency(r) || "USD";
    out[c] = (out[c] ?? 0) + cents(r);
  }
  return out;
}

/** "$1,000.00 · MX$53,100.00" — USD first, then MXN, then CAD; zero currencies left out (all zero → "$0.00"). */
export function formatTotals(totals: Record<string, number>, opts: { code?: boolean } = {}) {
  const keys = Object.keys(totals)
    .filter((k) => totals[k] !== 0)
    .sort((a, b) => (CURRENCIES as readonly string[]).indexOf(a) - (CURRENCIES as readonly string[]).indexOf(b));
  if (!keys.length) return money(0, "USD");
  return keys.map((k) => money(totals[k], k, opts)).join(" · ");
}

/** One line saying how foreign amounts were converted, e.g. "MXN at 18.4500 (invoice rate) · CAD at 1.3700 (company rate)". */
export function fxNote(used: { currency: string; rateE4: number; source: FxRateSource }[]) {
  const seen = new Map<string, { currency: string; rateE4: number; source: FxRateSource }>();
  for (const u of used) if (u.currency !== HOME_CURRENCY) seen.set(`${u.currency}|${u.rateE4}|${u.source}`, u);
  const label: Record<FxRateSource, string> = { home: "", invoice: "rate on the invoice", company: "company rate, Settings → Company", default: "built-in default rate — set yours in Settings → Company" };
  return [...seen.values()].map((u) => `${u.currency} at ${(u.rateE4 / 10000).toFixed(4)} (${label[u.source]})`).join(" · ");
}
