// Pre-PO seed data — RFQs (in-flight 3-vendor quotes) and Estimate
// Reservations (material reservations against approved customer estimates).
// These two row types live in the Pre-PO tab of the Purchase Orders page
// alongside `status: "draft"` POs from purchase-orders.ts (PRD §7.X).
//
// Drafts use the existing PurchaseOrder shape because they ARE pre-sent POs.
// RFQs and Estimate Reservations carry richer metadata that doesn't fit a
// PO yet — they get their own narrow types here.

export type PrePOLine = {
  itemSku: string;
  itemName: string;
  qty: number;
  uom: string;
};

export type EmailThreadEntry = {
  id: string;
  direction: "outbound" | "inbound";
  // What the message is — drives the chip color in the activity tab.
  kind:
    | "rfq_sent"          // RFQ request → vendor
    | "vendor_quote"      // Vendor's quote reply → us
    | "estimate_sent"     // Estimate → customer
    | "customer_reply"    // Customer reply (approval / question / decline)
    | "follow_up";        // Manual nudge / status check
  from: string;           // display name + email
  to: string[];           // display name + email (multi for group sends)
  subject: string;
  body: string;           // plain text; rendered with whitespace-pre-wrap
  sentAt: string;         // ISO timestamp
  attachments?: { label: string; kind: "pdf" | "xlsx" | "image" }[];
};

export type RFQQuote = {
  vendor: string;
  total: number;
  leadTimeDays: number;
  recommended: boolean;
};

export type RFQ = {
  id: string;
  rfqNumber: string;          // RFQ-####
  jobNumber?: string;
  customer?: string;
  site?: string;
  trade?: "locksmith" | "door" | "security" | "hvac" | "plumbing" | "multi";
  requestedAt: string;        // ISO timestamp
  responsesDueBy: string;     // ISO timestamp
  linesSummary: { items: number; units: number };
  lines: PrePOLine[];         // detailed items going out on the RFQ
  quotes: RFQQuote[];         // length 3 (per §7.2.B)
  status: "awaiting_quotes" | "ready_to_compare" | "winner_picked";
  emails: EmailThreadEntry[]; // RFQ-out + vendor-replies thread
};

export type EstimateReservation = {
  id: string;
  estimateNumber: string;     // EST-####
  jobNumber?: string;
  customer: string;
  customerEmail?: string;
  site?: string;
  trade?: "locksmith" | "door" | "security" | "hvac" | "plumbing" | "multi";
  approvedAt: string;         // ISO when the customer accepted the estimate
  reservedTotal: number;      // committed material spend awaiting PO conversion
  linesSummary: { items: number; units: number };
  lines: PrePOLine[];         // detailed items reserved on the estimate
  preferredVendor?: string;   // optional — defaults from price book
  emails: EmailThreadEntry[]; // estimate-out + customer-reply thread
  /** P2 lifecycle — reservations close ONLY via convert or manual dismiss. */
  status: "open" | "converted" | "dismissed";
  convertedPurchaseOrderId?: string;
  convertedPoNumber?: string;
  /** Context for the operator's human call (an approved estimate's reservation
   *  stays open even when the lead is lost — the row shows why). */
  estimateStatus?: string;
  leadStatus?: string;
};

export const rfqs: RFQ[] = [
  {
    id: "rfq_0042",
    rfqNumber: "RFQ-0042",
    jobNumber: "J-1872",
    customer: "Chase Bank · Park Slope Branch",
    site: "247 7th Ave, Brooklyn · Vault hardware refresh",
    trade: "locksmith",
    requestedAt: "2026-05-26T10:00:00Z",
    responsesDueBy: "2026-05-29T17:00:00Z",
    linesSummary: { items: 4, units: 28 },
    lines: [
      { itemSku: "ASA-MUL-C-114", itemName: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin", qty: 12, uom: "EA" },
      { itemSku: "KAB-PEAKS-IC-T7", itemName: "Kaba Peaks Preferred IC 7-Pin Cylinder", qty: 8, uom: "EA" },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", qty: 4, uom: "EA" },
      { itemSku: "SCH-COM-DLR", itemName: "Schlage Commercial Dead Lock Rim", qty: 4, uom: "EA" },
    ],
    quotes: [
      { vendor: "ASA / Mul-T-Lock NA", total: 4_280.5, leadTimeDays: 5, recommended: true },
      { vendor: "ADI / Anixter", total: 4_590.0, leadTimeDays: 4, recommended: false },
      { vendor: "Stanley Security", total: 4_140.0, leadTimeDays: 9, recommended: false },
    ],
    status: "ready_to_compare",
    emails: [
      {
        id: "em_rfq42_out_1",
        direction: "outbound",
        kind: "rfq_sent",
        from: "Dana Whitfield <dana.whitfield@servwave.example.com>",
        to: [
          "quotes@asamultilock.com",
          "ny-quotes@adi-anixter.com",
          "commercial@stanleysecurity.com",
        ],
        subject: "RFQ-0042 · Vault hardware refresh · Chase Bank Park Slope · Quotes due May 29",
        body:
`Hi team,

Please quote the attached vault hardware list for Chase Bank Park Slope (J-1872). 28 units across 4 SKUs, install window June 8–10.

Need pricing + lead time back by EOD Friday 5/29.

- Dana Whitfield
   ServWave · Brooklyn HQ`,
        sentAt: "2026-05-26T10:00:00Z",
        attachments: [{ label: "RFQ-0042-lines.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq42_in_1",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Maria Velez <mvelez@asamultilock.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0042 · Quote attached · 5-day lead",
        body:
`Dana,

Quote attached. $4,280.50 all-in for the 4 SKUs, 5 business days from PO. We have the Mul-T-Lock IC cores in NY stock — strikes ship from PA.

Let me know if you want net-30 or standard 2/10 net 30.

Maria`,
        sentAt: "2026-05-27T14:18:00Z",
        attachments: [{ label: "ASA-Quote-Q88412.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq42_in_2",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Tom Bryce <tbryce@adi-anixter.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0042 · ADI quote",
        body:
`Hey Dana - $4,590 even, can have everything on the truck Wednesday. 4-day lead.

— Tom`,
        sentAt: "2026-05-27T16:42:00Z",
        attachments: [{ label: "ADI-Q-552288.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq42_in_3",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Janet Liu <jliu@stanleysecurity.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0042 · Stanley quote · best pricing",
        body:
`Dana,

We can do the bundle for $4,140 but the Schlage rim deadlocks are on a 9-day lead (factory direct). Let me know if you want to split the PO — we can ship the cylinders and strikes ahead.

Janet`,
        sentAt: "2026-05-28T09:05:00Z",
        attachments: [{ label: "Stanley-Quote-RFQ0042.pdf", kind: "pdf" }],
      },
    ],
  },
  {
    id: "rfq_0043",
    rfqNumber: "RFQ-0043",
    jobNumber: "J-1874",
    customer: "Brooklyn Brewery",
    site: "79 N 11th St, Brooklyn · Walk-in cooler service",
    trade: "hvac",
    requestedAt: "2026-05-27T08:30:00Z",
    responsesDueBy: "2026-05-30T17:00:00Z",
    linesSummary: { items: 3, units: 12 },
    lines: [
      { itemSku: "HVC-CAP-45-5", itemName: "Dual Run Capacitor 45/5 MFD 440V", qty: 2, uom: "EA" },
      { itemSku: "HVC-FIL-20X25-M11", itemName: "Pleated Air Filter 20x25x1, MERV 11", qty: 8, uom: "EA" },
      { itemSku: "HVC-R410A-25LB", itemName: "R-410A Refrigerant, 25 lb Cylinder", qty: 2, uom: "CYL" },
    ],
    quotes: [
      { vendor: "Ferguson HVAC", total: 1_842.0, leadTimeDays: 3, recommended: true },
      { vendor: "Johnstone Supply", total: 1_910.5, leadTimeDays: 2, recommended: false },
      { vendor: "United Refrigeration", total: 1_795.0, leadTimeDays: 6, recommended: false },
    ],
    status: "ready_to_compare",
    emails: [
      {
        id: "em_rfq43_out_1",
        direction: "outbound",
        kind: "rfq_sent",
        from: "Dana Whitfield <dana.whitfield@servwave.example.com>",
        to: [
          "brooklyn@fergusonhvac.com",
          "ny-counter@johnstonesupply.com",
          "ne-quotes@uri.com",
        ],
        subject: "RFQ-0043 · Brooklyn Brewery walk-in cooler · capacitor + filters + R-410A",
        body:
`Hi all,

Standard quote request for 3 SKUs on the attached. Walk-in down at Brooklyn Brewery, need it back on Tuesday.

3-day lead is the ceiling — anything faster is preferred.

- Dana`,
        sentAt: "2026-05-27T08:30:00Z",
        attachments: [{ label: "RFQ-0043-cooler.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq43_in_1",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Dan Reyes <dreyes@fergusonhvac.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0043 · Ferguson · 3-day, $1,842",
        body:
`Quote $1,842. Capacitor + filters in stock, R-410A cylinders coming in tomorrow AM. Will-call ready by Friday close.`,
        sentAt: "2026-05-27T11:24:00Z",
        attachments: [{ label: "FH-Q-99841.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq43_in_2",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Sasha Ng <sng@johnstonesupply.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0043 · Johnstone NY · 2-day",
        body:
`$1,910.50 — everything in NY-Maspeth. Pick up tomorrow if you want it.`,
        sentAt: "2026-05-27T13:50:00Z",
        attachments: [{ label: "JS-Q-30771.pdf", kind: "pdf" }],
      },
      {
        id: "em_rfq43_in_3",
        direction: "inbound",
        kind: "vendor_quote",
        from: "Kelly Burns <kburns@uri.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: RFQ-0043 · URI quote · 6-day on the refrigerant",
        body:
`$1,795 — cheapest of the 3 you'll see, but the R-410A cylinders are 6 days out, coming from PA DC. Caps + filters could ship today.`,
        sentAt: "2026-05-27T16:08:00Z",
        attachments: [{ label: "URI-Q-558821.pdf", kind: "pdf" }],
      },
    ],
  },
  {
    id: "rfq_0044",
    rfqNumber: "RFQ-0044",
    jobNumber: "J-1876",
    customer: "Sweetgreen · Williamsburg",
    site: "240 Bedford Ave, Brooklyn · POS counter rebuild",
    trade: "multi",
    requestedAt: "2026-05-28T11:45:00Z",
    responsesDueBy: "2026-06-02T17:00:00Z",
    linesSummary: { items: 6, units: 41 },
    lines: [
      { itemSku: "DSC-NEO-HS2128", itemName: "DSC PowerSeries Neo HS2128 Alarm Panel", qty: 1, uom: "EA" },
      { itemSku: "HID-PROX-26", itemName: "HID ProxPoint Plus Reader, Wiegand 26", qty: 6, uom: "EA" },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", qty: 6, uom: "EA" },
      { itemSku: "LCN-4040XP-AL", itemName: "LCN 4040XP Surface Door Closer, Aluminum", qty: 4, uom: "EA" },
      { itemSku: "PLB-COP-3-4-L", itemName: "Copper Pipe, Type L, 3/4 in × 10 ft", qty: 20, uom: "FT" },
      { itemSku: "DOR-WGT-CMB-FRP", itemName: "Weight-Combo FRP Door, 36×84 in", qty: 4, uom: "EA" },
    ],
    quotes: [], // still out — awaiting vendor responses
    status: "awaiting_quotes",
    emails: [
      {
        id: "em_rfq44_out_1",
        direction: "outbound",
        kind: "rfq_sent",
        from: "Dana Whitfield <dana.whitfield@servwave.example.com>",
        to: [
          "quotes@asamultilock.com",
          "ny-quotes@adi-anixter.com",
          "commercial@stanleysecurity.com",
        ],
        subject: "RFQ-0044 · Sweetgreen Williamsburg · POS counter rebuild · 6 SKUs · Due 6/2",
        body:
`Team,

Counter rebuild at Sweetgreen Williamsburg — 6 SKUs across security, door, and plumbing. Spec sheet attached. Best price + lead by EOD Tuesday 6/2 please.

Will run a 3-way compare and pick a winner by Wednesday.

- Dana`,
        sentAt: "2026-05-28T11:45:00Z",
        attachments: [
          { label: "RFQ-0044-sweetgreen.pdf", kind: "pdf" },
          { label: "site-layout.pdf", kind: "pdf" },
        ],
      },
    ],
  },
];

export const estimateReservations: EstimateReservation[] = [
  {
    id: "est_5521",
    estimateNumber: "EST-5521",
    jobNumber: "J-1877",
    customer: "NYC Department of Education · PS-321",
    customerEmail: "facilities-ps321@schools.nyc.gov",
    site: "180 7th Ave, Brooklyn · Lobby door hardware",
    trade: "door",
    approvedAt: "2026-05-25T16:20:00Z",
    reservedTotal: 6_482.0,
    status: "open",
    linesSummary: { items: 9, units: 14 },
    lines: [
      { itemSku: "LCN-4040XP-AL", itemName: "LCN 4040XP Surface Door Closer, Aluminum", qty: 4, uom: "EA" },
      { itemSku: "HES-1006-630", itemName: "HES 1006 Electric Strike, 12/24 VDC, 630 Finish", qty: 2, uom: "EA" },
      { itemSku: "SCH-COM-DLR", itemName: "Schlage Commercial Dead Lock Rim", qty: 2, uom: "EA" },
      { itemSku: "ASA-MUL-C-114", itemName: "Mul-T-Lock C-Series Cylinder, IC Core, 6-Pin", qty: 2, uom: "EA" },
      { itemSku: "DOR-WGT-CMB-FRP", itemName: "Weight-Combo FRP Door, 36×84 in", qty: 1, uom: "EA" },
      { itemSku: "KAB-PEAKS-IC-T7", itemName: "Kaba Peaks Preferred IC 7-Pin Cylinder", qty: 1, uom: "EA" },
      { itemSku: "SVC-LCK-LBR-HR", itemName: "Locksmith labor — installation", qty: 1, uom: "HR" },
      { itemSku: "SVC-REKEY-RES", itemName: "Rekey service — residential", qty: 1, uom: "JOB" },
    ],
    preferredVendor: "Stanley Security",
    emails: [
      {
        id: "em_est5521_out_1",
        direction: "outbound",
        kind: "estimate_sent",
        from: "Dana Whitfield <dana.whitfield@servwave.example.com>",
        to: ["facilities-ps321@schools.nyc.gov"],
        subject: "Estimate EST-5521 · PS-321 Lobby Door Hardware · $6,482",
        body:
`Hi Ms. Carter,

Attached is the estimate for the PS-321 lobby door hardware refresh as discussed on site Tuesday. Total is $6,482 including labor, parts, and a same-day rekey of the perimeter cylinders.

Lead time is 5–7 business days for materials once approved. Please reply with "approved" or any change requests and we'll get the PO out the same day.

Best,
Dana Whitfield
ServWave — Brooklyn HQ`,
        sentAt: "2026-05-22T14:00:00Z",
        attachments: [
          { label: "EST-5521.pdf", kind: "pdf" },
          { label: "site-photos.pdf", kind: "pdf" },
        ],
      },
      {
        id: "em_est5521_in_1",
        direction: "inbound",
        kind: "customer_reply",
        from: "Linda Carter <lcarter@schools.nyc.gov>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: Estimate EST-5521 · approved",
        body:
`Dana - approved as quoted. PO number on our end is NYCDOE-2026-04482, please reference it on the invoice. Install window May 30 - June 5, weekday mornings before 8am.

Thanks,
Linda Carter
NYCDOE Facilities`,
        sentAt: "2026-05-25T16:20:00Z",
      },
    ],
  },
  {
    id: "est_5524",
    estimateNumber: "EST-5524",
    customer: "Hudson Yards Condo Bldg 12B",
    customerEmail: "manager@hy12b.com",
    site: "517 W 35th St, NY · Unit 1604 plumbing rough-in",
    trade: "plumbing",
    approvedAt: "2026-05-27T09:00:00Z",
    reservedTotal: 2_165.5,
    status: "open",
    linesSummary: { items: 5, units: 22 },
    lines: [
      { itemSku: "PLB-COP-3-4-L", itemName: "Copper Pipe, Type L, 3/4 in × 10 ft", qty: 14, uom: "FT" },
      { itemSku: "PLB-PEX-1-2-RED", itemName: "PEX-A Tubing, 1/2 in × 100 ft, Red", qty: 3, uom: "ROLL" },
      { itemSku: "SVC-LCK-LBR-HR", itemName: "Plumber labor — rough-in", qty: 4, uom: "HR" },
      { itemSku: "HVC-FIL-20X25-M11", itemName: "Pleated Air Filter 20x25x1, MERV 11", qty: 1, uom: "EA" },
    ],
    preferredVendor: "Winsupply",
    emails: [
      {
        id: "em_est5524_out_1",
        direction: "outbound",
        kind: "estimate_sent",
        from: "Dana Whitfield <dana.whitfield@servwave.example.com>",
        to: ["manager@hy12b.com"],
        subject: "Estimate EST-5524 · Unit 1604 plumbing rough-in · $2,165.50",
        body:
`Hi Marcus,

Estimate for the Unit 1604 rough-in attached. $2,165.50 covers copper, PEX, labor (4 hours), and a filter swap on the in-line for the HVAC tie-in.

Available to start the week of June 1 — reply approved and we'll lock the slot.

- Dana`,
        sentAt: "2026-05-26T10:30:00Z",
        attachments: [{ label: "EST-5524.pdf", kind: "pdf" }],
      },
      {
        id: "em_est5524_in_1",
        direction: "inbound",
        kind: "customer_reply",
        from: "Marcus Bell <manager@hy12b.com>",
        to: ["dana.whitfield@servwave.example.com"],
        subject: "Re: Estimate EST-5524 · approved · Monday 6/1 works",
        body:
`Approved. Monday 6/1 8am access is fine, ping the front desk on arrival.

— Marcus`,
        sentAt: "2026-05-27T09:00:00Z",
      },
    ],
  },
];
