import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrePODetailDialog } from "@/components/inventory/PrePODetailDialog";
import type { EstimateReservation } from "@/lib/api/inventory";

const reservation: EstimateReservation = {
  id: "est_res_1",
  estimateNumber: "EST-5521",
  jobNumber: "J-1870",
  customer: "Equinox Hudson Yards",
  customerEmail: "ops@equinox.test",
  site: "33 Hudson Yards, NY · Lobby 1",
  trade: "security",
  approvedAt: "2026-05-26T12:00:00Z",
  reservedTotal: 4200,
  linesSummary: { items: 1, units: 4 },
  lines: [{ itemSku: "SKU-001", itemName: "Deadbolt", qty: 4, uom: "ea" }],
  preferredVendor: "ADI / Anixter",
  emails: [],
  status: "open",
};

describe("PrePODetailDialog — Convert to Purchase Order", () => {
  it("invokes onConvertToPO with the reservation when the primary action is clicked", () => {
    const onConvertToPO = vi.fn();
    render(
      <PrePODetailDialog
        open
        onClose={() => {}}
        row={{ kind: "reservation", data: reservation }}
        onConvertToPO={onConvertToPO}
      />,
    );

    fireEvent.click(screen.getByText("Convert to Purchase Order"));

    expect(onConvertToPO).toHaveBeenCalledTimes(1);
    expect(onConvertToPO).toHaveBeenCalledWith(reservation);
  });
});
