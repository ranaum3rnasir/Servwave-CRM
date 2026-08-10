// Owned phone numbers (Phone module — Numbers view).
//
// `OwnedNumber` is the UI-facing shape of an org-owned tracking/receiving
// number. It moved here from NumbersView.tsx (slice 7) so the data seam
// (lib/api/communication.ts) can map GET /api/communication/numbers rows
// without importing a component; NumbersView re-exports it for compatibility.

export type NumberType = "Local · Primary" | "Local" | "Toll-free";
export type NumberStatus = "active" | "paused";

export type OwnedNumber = {
  id: string;
  number: string; // formatted, e.g. "(555) 555-0208"
  tag?: string; // small label under the number
  type: NumberType;
  flowId: string; // "" = no flow assigned
  adGroupId?: string; // "" / undefined = no ad group assigned
  status: NumberStatus;
  createdAt: string; // ISO
  /** Texting-capable (wire `sms_enabled`) — gates the SMS composer (§5.4). */
  smsEnabled?: boolean;
};
