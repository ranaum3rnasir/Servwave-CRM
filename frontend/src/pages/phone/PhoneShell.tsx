import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, Phone } from "lucide-react";
import { DialerWorkspace } from "@/components/communication/phone/Dialer";
import { useCalls } from "@/lib/api/communication";
import { useMyOutboundNumber } from "@/lib/api/myOutboundNumber";
import { useMyNumbers } from "@/lib/api/phoneNumbers";
import {
  DIAL_STORAGE_KEY,
  PHONE_TAB_NAME,
  type PhoneDialMessage,
} from "@/lib/communication/phoneTabHandoff";
import type { DialerEntityContext } from "@/stores/dialer.store";

/**
 * Task A3 — the `/phone` tab's content, and the SOLE CTM softphone
 * device-owner surface in the app. It hosts the full `DialerWorkspace`
 * (search + softphone + right panel) with `surface="phone-tab"`, which is the
 * one call site allowed to cold-boot the shared CTM device (`useCtmSoftphone`'s
 * surface gate, Task A2). Every other host of the workspace/`Softphone` (the
 * Communication hub page, ActiveCallPopup) omits `surface`, staying on the
 * zero-boot `'inline'` default — so opening this tab is the only way the
 * device ever registers, and there is still exactly ONE device-owning
 * `Softphone` here (the one inside this DialerWorkspace).
 *
 * Deliberately outside `AppLayout` (mounted directly by
 * `RequireCommunicationCreate` in App.tsx): it's a dedicated tab a user keeps
 * open alongside the main app, not a page embedded in the app chrome. The
 * header dialer button and every entity "Call" button open/focus THIS tab via
 * `phoneTabHandoff`.
 *
 * Handoff receiver: a first-open lands on `/phone?dial=<e164>&ctx=<json>`; a
 * subsequent dial into the already-open tab arrives over
 * `BroadcastChannel('servwave-phone')` (with a localStorage boot-race
 * fallback). Either way we hand the number + entity context to
 * `DialerWorkspace`, which prefills the softphone AND auto-selects the right
 * panel so the caller sees who they're calling and what it's about.
 *
 * Caller-ID: the "Calling from" picker below (sourced ONLY from
 * `useMyNumbers` — the caller's own numbers + the org default) threads through
 * as `callerIdOverride`. Real inbound answer (Task C2) lives INSIDE `Softphone`
 * (rendered by DialerWorkspace), the ONE component allowed to call
 * `useCtmSoftphone` for the `phone-tab` surface.
 */
export function PhoneShell() {
  const { data: myNumbers } = useMyNumbers();
  const { data: resolvedOutboundNumber } = useMyOutboundNumber();
  const { data: calls = [] } = useCalls();
  const [searchParams] = useSearchParams();

  const resolvedDefaultTpnId =
    resolvedOutboundNumber && !("none" in resolvedOutboundNumber)
      ? resolvedOutboundNumber.ctm_number_id
      : undefined;

  const numbers = myNumbers?.numbers ?? [];
  const soleNumber = numbers.length === 1 ? numbers[0] : undefined;
  // Undefined = "no explicit pick yet" (Softphone falls through to its own
  // resolved default); a truthy string is the user's active pick.
  const [selectedTpnId, setSelectedTpnId] = useState<string | undefined>(undefined);

  // The dial the workspace should seed + auto-pick. `nonce` bumps per dial so
  // re-dialing the SAME number still re-fires the workspace's seed/auto-pick
  // effect (its openNumber value alone wouldn't change).
  const [dial, setDial] = useState<{
    number: string;
    ctx: DialerEntityContext | null;
    nonce: number;
  } | null>(null);
  const nonceRef = useRef(0);
  const pushDial = (number: string, ctx: DialerEntityContext | null) => {
    nonceRef.current += 1;
    setDial({ number, ctx, nonce: nonceRef.current });
  };

  // Toast for the workspace's "ready, press Call" feedback (moved here from the
  // deleted GlobalDialer popup).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  // Untaint the browsing context on the way out. A tab keeps its `window.name`
  // across in-tab navigation (HTML spec), so leaving this tab's only exit —
  // the "Back to ServWave" link below, or the back button — would otherwise
  // leave it permanently branded `servwave-phone`. Every later Call button
  // clicked FROM that same tab would then find `window.open(url,
  // 'servwave-phone')` targeting its own name, which the spec defines as an
  // in-place navigation rather than a new tab — so the dialer would silently
  // stop popping out for the rest of that tab's life. Reset on unmount so the
  // next handoff attempt opens a fresh tab instead of hijacking this one.
  useEffect(
    () => () => {
      if (window.name === PHONE_TAB_NAME) window.name = "";
    },
    [],
  );

  // Seed the picker's selection to the resolved primary number (Task B1/B2)
  // as soon as it's known, UNLESS the caller already made an explicit pick.
  useEffect(() => {
    if (selectedTpnId === undefined && resolvedDefaultTpnId) {
      setSelectedTpnId(resolvedDefaultTpnId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDefaultTpnId]);

  // First-open handoff: read the dial number + entity context off the URL.
  useEffect(() => {
    const number = searchParams.get("dial");
    if (!number) return;
    const ctxRaw = searchParams.get("ctx");
    let ctx: DialerEntityContext | null = null;
    if (ctxRaw) {
      try {
        ctx = JSON.parse(ctxRaw) as DialerEntityContext;
      } catch {
        ctx = null;
      }
    }
    pushDial(number, ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subsequent dials into this already-open tab: BroadcastChannel, with a
  // localStorage fallback for the boot race where a dial lands before this
  // listener mounts. Never re-navigates — the live call is never dropped.
  useEffect(() => {
    const apply = (msg: PhoneDialMessage | null | undefined) => {
      if (!msg || msg.type !== "dial" || !msg.phone) return;
      pushDial(msg.phone, msg.ctx ?? null);
    };
    try {
      const raw = localStorage.getItem(DIAL_STORAGE_KEY);
      if (raw) {
        const msg = JSON.parse(raw) as PhoneDialMessage;
        // Only apply a very recent stash so an old one doesn't re-dial on every
        // fresh mount.
        if (msg && typeof msg.ts === "number" && Date.now() - msg.ts < 10_000) apply(msg);
        localStorage.removeItem(DIAL_STORAGE_KEY);
      }
    } catch {
      /* storage blocked — ignore */
    }

    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PHONE_TAB_NAME);
    ch.onmessage = (e) => apply(e.data as PhoneDialMessage);
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background-light">
      <header className="flex items-center justify-between border-b border-border bg-surface-light px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Phone className="h-4 w-4" />
          </span>
          <h1 className="text-base font-semibold text-text-primary">ServWave Phone</h1>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-text-secondary transition hover:bg-background-light hover:text-text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to ServWave
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center p-6">
        <div className="w-full max-w-3xl space-y-3">
          {numbers.length > 1 ? (
            <label className="block max-w-xs">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                Calling from
              </span>
              <div className="relative">
                <select
                  aria-label="Calling from"
                  value={selectedTpnId ?? ""}
                  onChange={(e) => setSelectedTpnId(e.target.value)}
                  className="w-full appearance-none rounded-md border border-border bg-surface-light px-3 py-2 pr-8 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
                >
                  {numbers.map((n) => (
                    <option key={n.ctm_number_id} value={n.ctm_number_id}>
                      {n.formatted ?? n.ctm_number_id}
                      {n.is_org_default ? " (Company)" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
              </div>
            </label>
          ) : soleNumber ? (
            <div className="max-w-xs">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                Calling from
              </span>
              <p className="rounded-md border border-border bg-surface-light px-3 py-2 text-sm text-text-primary">
                {soleNumber.formatted ?? soleNumber.ctm_number_id}
              </p>
            </div>
          ) : null}

          <DialerWorkspace
            surface="phone-tab"
            callerIdOverride={selectedTpnId}
            calls={calls}
            onToast={onToast}
            openNumber={dial?.number ?? null}
            openContext={dial?.ctx ?? null}
            openNonce={dial?.nonce}
          />
        </div>
      </main>

      {toast && (
        <div className="fixed bottom-6 right-6 z-[90] rounded-card border border-primary/30 bg-surface-light px-4 py-3 text-sm font-medium text-text-primary shadow-lg ring-1 ring-primary/10">
          {toast}
        </div>
      )}
    </div>
  );
}
