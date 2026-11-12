import { describe, expect, it } from "vitest";
import { normalizePurchaseTime } from "@/import/sales";

describe("normalizePurchaseTime", () => {
  it("keeps ISO-style times", () => {
    expect(normalizePurchaseTime("2026-07-02 10:15")).toBe("2026-07-02 10:15:00");
    expect(normalizePurchaseTime("2026-07-02T10:15:30Z")).toBe("2026-07-02 10:15:30");
    expect(normalizePurchaseTime("2026-07-02")).toBe("2026-07-02 00:00:00");
  });

  it("reads US slash dates as month/day", () => {
    expect(normalizePurchaseTime("10/16/2026 18:05")).toBe("2026-10-16 18:05:00");
    expect(normalizePurchaseTime("3/4/2026 9:07 PM")).toBe("2026-03-04 21:07:00");
    expect(normalizePurchaseTime("3/4/2026 12:30 am")).toBe("2026-03-04 00:30:00");
  });

  it("switches to day/month when the first number can't be a month", () => {
    expect(normalizePurchaseTime("16/10/2026 18:05")).toBe("2026-10-16 18:05:00");
  });

  it("returns null instead of throwing on unreadable values", () => {
    for (const bad of ["", "  ", "yesterday", "13/13/2026", "2026-02-30 10:00", "10/16/2026 25:00"]) expect(normalizePurchaseTime(bad)).toBeNull();
  });
});
