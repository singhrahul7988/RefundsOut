// Money is always integer cents. Never use floats for amounts.

export type Cents = number;

/** Parse "219.00", "$1,219.50", "219" or 219 into integer cents. Returns null when it isn't a number. */
export function toCents(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cleaned.startsWith("-") ? -cents : cents;
}

/** cents * numerator / denominator, rounded half-up to a whole cent, using integers only. */
export function mulDivRoundHalfUp(cents: Cents, numerator: number, denominator: number): Cents {
  if (!Number.isInteger(cents) || !Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    throw new Error(`mulDivRoundHalfUp needs integers, got ${cents} * ${numerator} / ${denominator}`);
  }
  if (cents < 0 || numerator < 0) throw new Error("mulDivRoundHalfUp is for non-negative amounts");
  return Math.floor((cents * numerator * 2 + denominator) / (denominator * 2));
}

/** Integer cents to a decimal string PayPal accepts, e.g. 7300 -> "73.00". */
export function centsToValue(cents: Cents): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
