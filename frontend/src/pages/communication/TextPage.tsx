// Communication module — Text (SMS) page shell.
//
// Extracts the two texting surfaces that previously lived inside PhonePage:
//   • SmsInboxView  — the 3-pane SMS messenger (Inbox tab)
//   • TextingView   — templates / automations / compliance (Settings tab)
//
// PhonePage no longer owns texting. Existing components are reused verbatim.
// Active tab is read from the route (:tab param) or ?tab= search param,
// defaulting to "inbox".

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Inbox as InboxIcon, Settings } from "lucide-react";

import { useAppAbility } from "@/contexts/AbilityContext";
import { useToast } from "@/components/ui/use-toast";

// ── Data seam ──────────────────────────────────────────────────────────────
import { useMessageThreads } from "@/lib/api/communication";
import type { MessageThread } from "@/lib/api/communication";

// ── Section views (reused verbatim from PhonePage) ──────────────────────────
import { SmsInboxView } from "@/components/communication/phone/SmsInboxView";
import { TextingView } from "@/components/communication/phone/TextingView";

type TextTab = "inbox" | "settings";

const TAB_KEYS: TextTab[] = ["inbox", "settings"];

export default function TextPage() {
  const ability = useAppAbility();
  const canRead = ability.can("read", "Communication");

  const { toast } = useToast();
  const onToast = (m: string) => toast({ description: m });

  // Active tab from URL (:tab param or ?tab= search param), default "inbox".
  const params = useParams<{ tab?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = params.tab ?? searchParams.get("tab") ?? "inbox";
  const activeTab: TextTab = (TAB_KEYS as string[]).includes(rawTab)
    ? (rawTab as TextTab)
    : "inbox";

  function goToTab(next: TextTab) {
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp);
  }

  // ── SMS thread state (same lift pattern as PhonePage) ──────────────────────
  const { data: seedThreads = [] } = useMessageThreads();
  const [threads, setThreads] = useState<MessageThread[]>([]);

  // Seed-merge, NOT wholesale clobber: with 20s live polling a refetch used to
  // wipe optimistic local-only threads. mergeServerThreads is convergent, and
  // the empty-seed early-return keeps the effect loop-free when data is [].
  useEffect(() => {
    if (seedThreads.length) setThreads((prev) => mergeServerThreads(prev, seedThreads));
  }, [seedThreads]);

  // Coarse module gate.
  if (!canRead) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-sm text-text-secondary">
        You don't have access to the Text module.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <div className="border-b border-border bg-surface-light px-6 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Text
          </h1>
        </div>

        {/* Tab bar */}
        <div className="mt-3 flex items-center gap-1">
          <TabButton
            active={activeTab === "inbox"}
            onClick={() => goToTab("inbox")}
            label="Inbox"
            icon={InboxIcon}
          />
          <TabButton
            active={activeTab === "settings"}
            onClick={() => goToTab("settings")}
            label="Settings"
            icon={Settings}
          />
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "inbox" ? (
          <SmsInboxView
            threads={threads}
            setThreads={setThreads}
            onToast={onToast}
          />
        ) : (
          <div className="flex-1 overflow-y-auto bg-background-light h-full">
            <TextingView onToast={onToast} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Merge server threads into local state by id — server rows win, optimistic
 * local-only threads (unsaved team/group lanes, still-posting customer
 * threads) stay on top. A local customer thread is dropped once the server's
 * thread for that customer arrives (the send's find-or-create lands in the
 * seed), so polling never duplicates a conversation. Pure + convergent —
 * merge(merge(prev, seed), seed) === merge(prev, seed) — so the seed effect
 * can re-run safely (the jsdom seed-effect-loop hazard). */
export function mergeServerThreads(
  local: MessageThread[],
  server: MessageThread[],
): MessageThread[] {
  const serverIds = new Set(server.map((t) => t.id));
  const serverCustomerIds = new Set(server.map((t) => t.customerId).filter(Boolean));
  const localOnly = local.filter(
    (t) => !serverIds.has(t.id) && !(t.customerId && serverCustomerIds.has(t.customerId)),
  );
  return [...localOnly, ...server];
}

/* ─────────────────── Shell-local presentational pieces ─────────────────── */

function TabButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition",
        active
          ? "border-text-primary text-text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
