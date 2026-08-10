// Signature value object — what gets stamped onto a signed doc.
//
// In production these would persist to the server with the doc record
// (pickup ticket, PO, approval, etc.). For the prototype they are returned
// from <SignatureField> to the parent dialog, which holds them in local
// state until the doc is closed/exported.
//
// "Adopt" semantics mirror DocuSign: a signer types their full name once,
// the rendered script-font representation becomes their reusable signature,
// and subsequent docs offer one-tap "Apply my signature". The adopted name
// lives in localStorage under the signer's user id for the prototype — in
// production this lives on the user profile (signed signature image +
// adopted_at + IP / device). The <userId> is supplied by the caller from
// useAuthStore((s) => s.user?.id).

export type SignatureValue = {
  /** What the signer typed (or their saved adopted name). */
  fullName: string;
  /** ISO timestamp when the signature was applied to *this* doc. */
  signedAt: string;
  /** How it was applied. */
  method: "typed" | "auto_applied";
  /** Optional — for audit display. */
  signerId?: string;
};

export type SavedSignature = {
  fullName: string;
  adoptedAt: string;
};

const KEY = (userId: string) => `alpha:sig:${userId}`;

/** Returns the signer's adopted signature, or null if they have not adopted one. */
export function getSavedSignature(userId: string): SavedSignature | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSignature;
    if (!parsed.fullName) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist an adopted signature for re-use. */
export function saveSignature(userId: string, fullName: string): SavedSignature {
  const rec: SavedSignature = {
    fullName: fullName.trim(),
    adoptedAt: new Date().toISOString(),
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(KEY(userId), JSON.stringify(rec));
  }
  return rec;
}

/** Forget the adopted signature (e.g. user clicks "Use a different signature"). */
export function clearSignature(userId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY(userId));
}

/** Helper: render a date in a doc-friendly format ("May 26, 2026 · 2:14 PM"). */
export function fmtSignedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
}
