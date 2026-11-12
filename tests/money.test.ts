import { describe, expect, it } from "vitest";
import { centsToValue, mulDivRoundHalfUp, toCents } from "@/lib/money";

describe("money", () => {
  it("parses prices into integer cents", () => {
    expect(toCents("219.00")).toBe(21900);
    expect(toCents("$1,219.5")).toBe(121950);
    expect(toCents("89")).toBe(8900);
    expect(toCents(73.1)).toBe(7310);
    expect(toCents("two-nineteen")).toBeNull();
    expect(toCents("")).toBeNull();
  });

  it("divides with half-up rounding using integers only", () => {
    expect(mulDivRoundHalfUp(21900, 1, 3)).toBe(7300);
    expect(mulDivRoundHalfUp(34900, 1, 3)).toBe(11633); // 116.333… -> 116.33
    expect(mulDivRoundHalfUp(100, 1, 8)).toBe(13); // 12.5 -> 13
    expect(mulDivRoundHalfUp(8900, 100, 100)).toBe(8900);
  });

  it("formats cents the way PayPal expects", () => {
    expect(centsToValue(7300)).toBe("73.00");
    expect(centsToValue(11633)).toBe("116.33");
    expect(centsToValue(5)).toBe("0.05");
    expect(() => centsToValue(-1)).toThrow();
  });
});
