import { describe, it, expect } from "vitest";
import {
  countCallsOnDay,
  DEMO_NOW,
} from "@/components/communication/phone/shared";

// H8 hub polish — the two pure helpers behind the truthful "Calls today" KPI
// and the real CSV export. Both parse dates in LOCAL time (setHours-based day
// bounds), so these assertions are timezone-independent.

describe("countCallsOnDay", () => {
  const call = (startedAt: string) => ({ startedAt });

  it("counts only the calls on the anchor's calendar day", () => {
    const anchor = new Date("2026-07-14T12:00:00");
    const calls = [
      call("2026-07-14T00:00:01"), // start of day → in
      call("2026-07-14T23:59:00"), // end of day → in
      call("2026-07-13T23:59:59"), // prior day → out
      call("2026-07-15T00:00:00"), // next day → out
    ];
    expect(countCallsOnDay(calls, anchor)).toBe(2);
  });

  it("uses the demo anchor so demo-seeded data reads a real 'today'", () => {
    const calls = [call("2026-05-30T10:00:00"), call("2026-05-29T10:00:00")];
    expect(countCallsOnDay(calls, DEMO_NOW)).toBe(1);
  });

  it("ignores unparseable timestamps and empty lists", () => {
    expect(
      countCallsOnDay([call("not-a-date")], new Date("2026-07-14T12:00:00")),
    ).toBe(0);
    expect(countCallsOnDay([], new Date())).toBe(0);
  });
});
