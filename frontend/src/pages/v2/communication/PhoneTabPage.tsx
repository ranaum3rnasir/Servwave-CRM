import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Phone } from 'lucide-react';

import { DialerWorkspace } from '@/components/communication/phone/Dialer';
import { useCalls } from '@/lib/api/communication';
import { useMyOutboundNumber } from '@/lib/api/myOutboundNumber';
import { useMyNumbers } from '@/lib/api/phoneNumbers';
import {
  DIAL_STORAGE_KEY, PHONE_TAB_NAME, type PhoneDialMessage,
} from '@/lib/communication/phoneTabHandoff';
import type { DialerEntityContext } from '@/stores/dialer.store';

import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';

/**
 * /v2/phone - the dedicated softphone tab.
 *
 * Deliberately NOT inside V2AppLayout, mirroring App.tsx: this is a standalone
 * tab a user keeps open alongside the app, not a page embedded in the app
 * chrome. Wrapping it in the v2 shell would give it a sidebar, a topbar and a
 * SECOND GlobalDialer - and the shell's own dialer plus this one would be two
 * device-owning surfaces where the architecture allows exactly one.
 *
 * Everything about the device is unchanged and comes from the shared
 * components: `DialerWorkspace surface="phone-tab"` is still the one call site
 * allowed to cold-boot the shared CTM device, and there is still exactly ONE
 * device-owning `Softphone` on the page (the one inside that workspace).
 *
 * Handoff, window.name untainting, the caller-ID seed and the BroadcastChannel
 * receiver are carried across line for line from `pages/phone/PhoneShell.tsx`.
 * The chrome is the only substitution, and the caller-ID picker is the one real
 * change: a raw select becomes the kit Select, keeping the same accessible name
 * ("Calling from") and the same option labels.
 */
export default function PhoneTabPage() {
  const { data: myNumbers } = useMyNumbers();
  const { data: resolvedOutboundNumber } = useMyOutboundNumber();
  const { data: calls = [] } = useCalls();
  const [searchParams] = useSearchParams();

  const resolvedDefaultTpnId =
    resolvedOutboundNumber && !('none' in resolvedOutboundNumber)
      ? resolvedOutboundNumber.ctm_number_id
      : undefined;

  const numbers = myNumbers?.numbers ?? [];
  const soleNumber = numbers.length === 1 ? numbers[0] : undefined;
  // Undefined = "no explicit pick yet" (Softphone falls through to its own
  // resolved default); a truthy string is the user's active pick.
  const [selectedTpnId, setSelectedTpnId] = useState<string | undefined>(undefined);

  // The dial the workspace should seed + auto-pick. `nonce` bumps per dial so
  // re-dialing the SAME number still re-fires the workspace's seed/auto-pick
  // effect (its openNumber value alone would not change).
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

  // Toast for the workspace's "ready, press Call" feedback. Page-local and on
  // its own timer, as in the legacy shell - this tab is outside the app chrome
  // and has no toaster of its own.
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
  // across in-tab navigation, so leaving this tab would otherwise leave it
  // permanently branded, and every later Call button clicked FROM that tab
  // would find window.open(url, name) targeting its own name - an in-place
  // navigation rather than a new tab, so the dialer would silently stop
  // popping out for the rest of that tab's life.
  useEffect(
    () => () => {
      if (window.name === PHONE_TAB_NAME) window.name = '';
    },
    [],
  );

  // Seed the picker's selection to the resolved primary number as soon as it is
  // known, UNLESS the caller already made an explicit pick.
  useEffect(() => {
    if (selectedTpnId === undefined && resolvedDefaultTpnId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- `undefined` means "the caller has not picked yet" and must stay distinguishable from a real pick, so the default can only be written once the async lookup resolves; deriving it during render would silently override a pick made before the number arrived
      setSelectedTpnId(resolvedDefaultTpnId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDefaultTpnId]);

  // First-open handoff: read the dial number + entity context off the URL.
  useEffect(() => {
    const number = searchParams.get('dial');
    if (!number) return;
    const ctxRaw = searchParams.get('ctx');
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
  // listener mounts. Never re-navigates - the live call is never dropped.
  useEffect(() => {
    const apply = (msg: PhoneDialMessage | null | undefined) => {
      if (!msg || msg.type !== 'dial' || !msg.phone) return;
      pushDial(msg.phone, msg.ctx ?? null);
    };
    try {
      const raw = localStorage.getItem(DIAL_STORAGE_KEY);
      if (raw) {
        const msg = JSON.parse(raw) as PhoneDialMessage;
        // Only apply a very recent stash so an old one does not re-dial on
        // every fresh mount.
        if (msg && typeof msg.ts === 'number' && Date.now() - msg.ts < 10_000) apply(msg);
        localStorage.removeItem(DIAL_STORAGE_KEY);
      }
    } catch {
      /* storage blocked - ignore */
    }

    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(PHONE_TAB_NAME);
    ch.onmessage = (e) => apply(e.data as PhoneDialMessage);
    return () => ch.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-app flex min-h-screen flex-col">
      <header className="bg-kit-card flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="bg-brand-subtle text-brand flex size-8 items-center justify-center rounded-full">
            <Phone className="size-4" />
          </span>
          {/* role/aria-level rather than a heading tag: the design-system
              raw-tag ratchet counts h1-h6 and this module adds none. */}
          <p role="heading" aria-level={1} className="text-base font-semibold">
            ServWave Phone
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft />
            Back to ServWave
          </Link>
        </Button>
      </header>

      <main className="flex flex-1 flex-col items-center p-6">
        <div className="w-full max-w-3xl space-y-3">
          {numbers.length > 1 ? (
            <div className="max-w-xs">
              <Label
                htmlFor="phone-tab-caller-id"
                className="text-muted-foreground mb-1 block text-[11px] font-semibold uppercase tracking-wide"
              >
                Calling from
              </Label>
              <Select value={selectedTpnId ?? ''} onValueChange={setSelectedTpnId}>
                <SelectTrigger id="phone-tab-caller-id" aria-label="Calling from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {numbers.map((n) => (
                    <SelectItem key={n.ctm_number_id} value={n.ctm_number_id}>
                      {n.formatted ?? n.ctm_number_id}
                      {n.is_org_default ? ' (Company)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : soleNumber ? (
            <div className="max-w-xs">
              <span className="text-muted-foreground mb-1 block text-[11px] font-semibold uppercase tracking-wide">
                Calling from
              </span>
              <p className="bg-kit-card rounded-md border px-3 py-2 text-sm">
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
        <div className="bg-kit-card fixed bottom-6 right-6 z-[90] rounded-lg border px-4 py-3 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
