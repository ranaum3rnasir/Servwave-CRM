import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VendorCard } from "../VendorCard";
import type { Vendor } from "@/lib/api/inventory";
import type { VendorSpend } from "@/lib/inventory/vendor-spend";

const vendor = {
  id: "v1",
  name: "ADI",
  category: "Security",
  paymentTerms: "Net 30",
  leadTimeDays: 3,
  transmitMethod: "portal",
  status: "active",
} as unknown as Vendor;
const spend = {
  ytd: 1200,
  ytdPoCount: 4,
  lastOrderedAt: null,
} as unknown as VendorSpend;

describe("VendorCard re-skin (token guard)", () => {
  it("renders the vendor name + Active badge and uses NO raw emerald/rounded-lg classes", () => {
    const { container } = render(
      <VendorCard
        vendor={vendor}
        spend={spend}
        shareOfYTD={0.4}
        topShareOfYTD={1}
        onClick={() => {}}
      />,
    );
    expect(container.textContent).toContain("ADI");
    expect(container.textContent).toContain("Active");
    const html = container.innerHTML;
    expect(html).not.toMatch(/emerald-\d+/);
    expect(html).not.toMatch(/\brounded-lg\b/);
  });
});
