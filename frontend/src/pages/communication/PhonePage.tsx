// Phone module — the integration hub (page shell).
//
// Ported from Emanuel's PhonePage monolith (regions L134–1143, KPITile/ModuleTab
// L4827–4905, ModulePlaceholder/TabButton L9313–end). This file is the SHELL: it
// owns the module-level lifted state (calls / threads / numbers / call flows /
// call groups) that several sub-views mutate, renders the 8-tab primary
// nav + the Calls KPI strip + the 4 Calls sub-tabs, and renders each section's
// view component imported from `@/components/communication/phone/*`.
//
// Cut-and-reskin notes:
//   • Tokens swapped indigo/slate → ALPHA design tokens; emerald/amber/rose/sky
//     status tints kept verbatim.
//   • Domain data + label maps come from the `@/lib/api/communication` seam; the
//     cross-cutting helpers/types come from the shared kernel.
//   • The App.tsx phoneTab/phoneNonce remount hack is replaced by URL routing:
//     the active module section is read from the route (`/communication/phone/:tab`
//     or `?tab=`); the `initialTab` prop is dropped.
//   • `currentUser` → CASL: identity from the auth store, capability from the
//     coarse `Communication` subject.
//   • Toast wired to ALPHA's global toaster via `useToast()`.
//   • Hand-rolled createPortal/fixed overlays (the Dialer popup, ReachSalesModal,
//     the PlanUsage panel) kept as-is — token-swapped only.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  BarChart3,
  Ban,
  Check,
  ChevronDown,
  GraduationCap,
  Hash,
  ListChecks,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  PhoneMissed,
  Plus,
  Send,
  Shield,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore } from "@/stores/auth.store";
import { EmptyState } from "@/components/ui/empty-state";
import { useIsDemoOrg } from "@/lib/useIsDemoOrg";
import { useIsCommunicationPilotOrg } from "@/lib/useIsCommunicationPilotOrg";
import { useToast } from "@/components/ui/use-toast";
import { Modal } from "@/components/ui/modal";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// ── Data seam ──────────────────────────────────────────────────────────────
import {
  useCalls,
  useMessageThreads,
  useCallFlows,
  useCallGroups,
  useBlockedNumbers,
  useBlockNumber,
  useUnblockNumber,
  blockNumberErrorMessage,
  useNumbers,
  usePhoneCustomers,
  usePhoneAgents,
  fmtPhone,
  PLAN_USAGE,
  groupTargetOptions,
} from "@/lib/api/communication";
import type {
  CallSession,
  MessageThread,
  BlockReason,
  CallFlow,
  CallGroup,
} from "@/lib/api/communication";

// ── Shared kernel ────────────────────────────────────────────────────────────
import {
  callNeedsAttention,
  computeRange,
  countCallsOnDay,
  DateRangeControl,
  DEMO_NOW,
} from "@/components/communication/phone/shared";
import type {
  Tab,
  CallsFocus,
  RangePreset,
} from "@/components/communication/phone/shared";

// ── Section views (each preserves the monolith's prop contract) ────────────────
// The dialer opens in the dedicated /phone tab (the single softphone surface);
// this page no longer embeds an in-app dialer popup.
import { openPhoneTab } from "@/lib/communication/phoneTabHandoff";
import { CallsView } from "@/components/communication/phone/CallsView";
import { DispatchView } from "@/components/communication/phone/DispatchView";
import { PerformanceView } from "@/components/communication/phone/PerformanceView";
import { TrainingView } from "@/components/communication/phone/TrainingView";
import { NumbersView } from "@/components/communication/phone/NumbersView";
import type { OwnedNumber } from "@/components/communication/phone/NumbersView";
import { CallMaskingView } from "@/components/communication/phone/CallMaskingView";
import { BlockedCallersView } from "@/components/communication/phone/BlockedCallersView";
import { CallFlowsView } from "@/components/communication/phone/CallFlows";
import { CallGroupsView } from "@/components/communication/phone/CallGroups";

/** Top-level pages of the Phone module (the Workiz-style primary nav). */
type ModuleSection =
  | "calls"
  | "numbers"
  | "flows"
  | "masking"
  | "groups"
  | "training"
  | "blocked";

type KpiKey = "calls" | "callback" | "unread" | "attention";

const MODULE_TABS: {
  key: ModuleSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: "calls", label: "Calls", icon: ListChecks },
  { key: "numbers", label: "Phone numbers", icon: Hash },
  { key: "flows", label: "Call flows", icon: Workflow },
  { key: "masking", label: "Call masking", icon: Shield },
  { key: "groups", label: "Call groups", icon: Users },
  { key: "training", label: "Training", icon: GraduationCap },
  { key: "blocked", label: "Blocked callers", icon: Ban },
];

const MODULE_SECTION_KEYS = MODULE_TABS.map((t) => t.key);

// Prototype-only surface (mock-fed, no backend): visible ONLY for demo orgs
// (same mock-data-containment idiom as Reports / AI Center — useIsDemoOrg).
// Real orgs see the backed pages: Calls, Phone numbers, Blocked callers.
const DEMO_ONLY_SECTIONS: ModuleSection[] = ["masking"];

// Sections not yet ready for every real org, but visible for the live CTM
// pilot org (Alpha Doors) and the demo org — lock them for every other real
// org so nothing looks half-built.
//   • flows / groups — the editors are built but non-functional: Save is
//     local-only (never persisted) and nothing is pushed to CTM, so they
//     don't affect real routing.
//   • training — real DB-backed scenarios + read-only session history; the
//     pilot org's 12 scenarios were seeded from the demo org's set so the
//     tab has real content to run against (no create-scenario UI yet). The
//     AI scoring/recording playback stay simulated for every org.
const PILOT_AND_DEMO_SECTIONS: ModuleSection[] = ["flows", "groups", "training"];

/** Section copy for the still-stubbed pages (rendered by ModulePlaceholder). */
const SECTION_META: Record<
  Exclude<ModuleSection, "calls" | "training">,
  {
    title: string;
    desc: string;
    action: string;
    icon: LucideIcon;
  }
> = {
  numbers: {
    title: "Phone numbers",
    desc: "Manage your phone numbers and assign them to call flows. Get multiple numbers and use them across your online and offline campaigns.",
    action: "Get a number",
    icon: Hash,
  },
  flows: {
    title: "Call flows",
    desc: "Build the IVR menus and routing rules that decide how incoming calls are greeted, screened, and connected to the right person.",
    action: "New call flow",
    icon: Workflow,
  },
  masking: {
    title: "Call masking",
    desc: "Protect tech and customer privacy with proxy numbers, so personal numbers are never exposed when calling about a job.",
    action: "New masking rule",
    icon: Shield,
  },
  groups: {
    title: "Call groups",
    desc: "Ring multiple agents together — round-robin or all-at-once — so calls get answered faster and nothing slips through.",
    action: "New call group",
    icon: Users,
  },
  blocked: {
    title: "Blocked callers",
    desc: "Numbers muted inside ServWave. Their calls and texts are still logged, but they raise no alerts and no unread badges. ServWave does not block at the carrier, so a blocked number can still reach a forwarded phone.",
    action: "Block a number",
    icon: Ban,
  },
};

/* ─────────────────── Plan usage (header) ─────────────────── */

/** Bar color by how close to the plan limit you are. */
function usageTone(pct: number): { bar: string; text: string } {
  if (pct >= 90) return { bar: "bg-danger-strong", text: "text-danger-text" };
  if (pct >= 75) return { bar: "bg-warning-strong", text: "text-warning-text" };
  return { bar: "bg-success-strong", text: "text-success-text" };
}

/** A compact usage line — label, percent, and a progress bar toward the plan
 *  limit. Used for both calling minutes and texting. */
function PlanUsageMeter({
  icon: Icon,
  label,
  used,
  limit,
  unit,
  className = "",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  used: number;
  limit: number;
  unit: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const tone = usageTone(pct);
  return (
    <div className={`min-w-[160px] ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          <Icon className="h-3 w-3 text-text-secondary" />
          {label}
        </span>
        <span className={`text-[11px] font-bold ${tone.text}`}>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full ${tone.bar} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-0.5 text-[10px] text-text-secondary">
        {used.toLocaleString()} / {limit.toLocaleString()} {unit}
      </p>
    </div>
  );
}

// Current plan + upgrade tiers (prototype seeds; in production from billing).
const CURRENT_PLAN = { name: "Sales Engage", price: "$329/mo" };

type UpgradePlan = {
  id: string;
  name: string;
  price: string;
  per: string;
  calling: string;
  texting: string;
  /** Concrete new allotments applied on a self-serve upgrade (null = custom). */
  callingLimit: number | null;
  textingLimit: number | null;
  /** Self-serve plans bill instantly; custom plans route to sales. */
  selfServe: boolean;
  recommended?: boolean;
};

const UPGRADE_PLANS: UpgradePlan[] = [
  {
    id: "scale",
    name: "Scale",
    price: "$549",
    per: "/mo",
    calling: "3,000 min",
    texting: "5,000 texts",
    callingLimit: 3000,
    textingLimit: 5000,
    selfServe: true,
    recommended: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    per: "",
    calling: "Unlimited",
    texting: "Unlimited",
    callingLimit: null,
    textingLimit: null,
    selfServe: false,
  },
];
const SALES_EMAIL = "sales@servwave.com";

/** Clickable plan-usage box in the header. Shows the two usage meters; pressing
 *  it opens a panel with full usage detail, a status banner (approaching / limit
 *  reached), upgrade-tier picker, and Upgrade / Call sales / Reach sales
 *  actions. (PHONE-SYSTEM-PRD §14.8 — limit-reached upgrade path.) */
function PlanUsage({
  onToast,
  userEmail,
  branch,
}: {
  onToast: (m: string) => void;
  userEmail: string;
  branch: string;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>("scale");
  // Live plan + usage so a self-serve upgrade re-bases the meters instantly.
  const [plan, setPlan] = useState(CURRENT_PLAN);
  const [usage, setUsage] = useState(PLAN_USAGE);
  // "Reach sales" email composer.
  const [salesOpen, setSalesOpen] = useState(false);

  const callPct = Math.min(
    100,
    Math.round((usage.calling.used / usage.calling.limit) * 100),
  );
  const textPct = Math.min(
    100,
    Math.round((usage.texting.used / usage.texting.limit) * 100),
  );

  const pickedPlan = UPGRADE_PLANS.find((p) => p.id === picked) ?? null;

  // Self-serve plans (concrete price) upgrade instantly and re-base the meters;
  // custom tiers send a sales request instead.
  function applyUpgrade() {
    const p = UPGRADE_PLANS.find((x) => x.id === picked);
    if (!p) return;
    if (!p.selfServe || p.callingLimit == null || p.textingLimit == null) {
      onToast(
        `✓ Request sent to sales about the ${p.name} plan — we'll reach out shortly.`,
      );
      setOpen(false);
      return;
    }
    setPlan({ name: p.name, price: `${p.price}${p.per}` });
    setUsage((u) => ({
      ...u,
      calling: { ...u.calling, limit: p.callingLimit as number },
      texting: { ...u.texting, limit: p.textingLimit as number },
    }));
    onToast(
      `✓ Upgraded to ${p.name} — plan active. New limits: ${p.calling} · ${p.texting}.`,
    );
    setOpen(false);
  }

  // Open the email composer so the owner can write what they want to ask before
  // the message is sent to sales.
  function contactSales() {
    setOpen(false);
    setSalesOpen(true);
  }
  const worst = Math.max(callPct, textPct);
  const status: "reached" | "near" | "ok" =
    worst >= 100 ? "reached" : worst >= 75 ? "near" : "ok";

  const statusPill =
    status === "reached"
      ? { label: "Limit reached", cls: "bg-danger-surface text-danger-text" }
      : status === "near"
        ? { label: "Approaching limit", cls: "bg-warning-surface text-warning-text" }
        : null;

  return (
    <div className="relative hidden lg:block">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            aria-label="Phone plan usage and upgrade options"
            className={[
              "flex items-center gap-4 rounded-lg border bg-background-light px-3 py-1.5 text-left transition hover:bg-background-light",
              open ? "border-primary ring-2 ring-primary-subtle" : "border-border",
            ].join(" ")}
          >
            <PlanUsageMeter
              icon={PhoneCall}
              label="Calling"
              used={usage.calling.used}
              limit={usage.calling.limit}
              unit={usage.calling.unit}
            />
            <span className="h-9 w-px bg-border" />
            <PlanUsageMeter
              icon={MessageSquare}
              label="Texting"
              used={usage.texting.used}
              limit={usage.texting.limit}
              unit={usage.texting.unit}
            />
            <ChevronDown
              className={`h-4 w-4 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[340px] overflow-hidden p-0 shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-bold text-text-primary">
                Phone plan usage
              </p>
              <p className="text-[12px] text-text-secondary">
                {plan.name} · {plan.price} · {usage.cycleLabel}
              </p>
            </div>
            {statusPill && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusPill.cls}`}
              >
                {statusPill.label}
              </span>
            )}
          </div>

          <div className="space-y-4 px-4 py-4">
            {/* Status banner */}
            {status !== "ok" && (
              <div
                className={[
                  "flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px] leading-snug",
                  status === "reached"
                    ? "bg-danger-surface text-danger-text"
                    : "bg-warning-surface text-warning-text",
                ].join(" ")}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {status === "reached"
                    ? "You've hit a plan limit. Calls/texts may be paused until you upgrade or your cycle resets."
                    : "You're approaching a plan limit this cycle. Upgrade now to avoid interruptions."}
                </span>
              </div>
            )}

            {/* Detailed meters */}
            <div className="space-y-3">
              <PlanUsageMeter
                icon={PhoneCall}
                label="Calling"
                used={usage.calling.used}
                limit={usage.calling.limit}
                unit={usage.calling.unit}
                className="w-full"
              />
              <PlanUsageMeter
                icon={MessageSquare}
                label="Texting"
                used={usage.texting.used}
                limit={usage.texting.limit}
                unit={usage.texting.unit}
                className="w-full"
              />
            </div>

            {/* Choose the upgrade */}
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                Choose your upgrade
              </p>
              <div className="space-y-2">
                {UPGRADE_PLANS.map((p) => {
                  const on = picked === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPicked(p.id)}
                      className={[
                        "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition",
                        on
                          ? "border-primary bg-primary/10 ring-2 ring-primary-subtle"
                          : "border-border hover:border-primary hover:bg-background-light",
                      ].join(" ")}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-text-primary">
                            {p.name}
                          </span>
                          {p.recommended && (
                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                              Recommended
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-text-secondary">
                          {p.calling} · {p.texting}
                        </span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-1.5">
                        <span className="text-right text-[13px] font-bold text-text-primary">
                          {p.price}
                          <span className="text-[11px] font-normal text-text-secondary">
                            {p.per}
                          </span>
                        </span>
                        {on && <Check className="h-4 w-4 text-primary" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Primary action — self-serve upgrade bills instantly and re-bases
                the meters; a custom tier routes to sales instead. */}
            <button
              type="button"
              disabled={!picked}
              onClick={applyUpgrade}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {pickedPlan && !pickedPlan.selfServe
                ? `Contact sales for ${pickedPlan.name}`
                : pickedPlan
                  ? `Upgrade to ${pickedPlan.name} — ${pickedPlan.price}${pickedPlan.per}`
                  : "Upgrade plan"}
            </button>

            {/* Reach sales — one button that sends a request; the team is
                notified and follows up. */}
            <button
              type="button"
              onClick={contactSales}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-light px-3 py-2 text-[13px] font-semibold text-text-secondary hover:bg-background-light"
            >
              <Mail className="h-4 w-4 text-text-secondary" />
              Reach sales
            </button>
            <p className="text-center text-[11px] text-text-secondary">
              Sales: {SALES_EMAIL}
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {salesOpen && (
        <ReachSalesModal
          planName={plan.name}
          userEmail={userEmail}
          branch={branch}
          onClose={() => setSalesOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/** "Reach sales" email composer — opens when the owner presses Reach sales.
 *  Pre-fills the recipient, the reply-to (current user), and a subject, and lets
 *  them write what they want to ask before the message is sent. */
function ReachSalesModal({
  planName,
  userEmail,
  branch,
  onClose,
  onToast,
}: {
  planName: string;
  userEmail: string;
  branch: string;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  // Preset questions — one tap fills the subject + a ready-to-send message so the
  // owner doesn't have to write from scratch.
  const TOPICS = [
    {
      id: "upgrade",
      label: "Upgrade my plan",
      subject: `Upgrade my plan — ${planName} (${branch})`,
      message: `Hi, I'd like to upgrade from my current ${planName} plan. Can you walk me through the options and pricing?`,
    },
    {
      id: "numbers",
      label: "Add phone numbers",
      subject: `Add phone numbers (${branch})`,
      message: `Hi, we'd like to add more phone numbers to our account. What's the pricing for additional local / toll-free numbers?`,
    },
    {
      id: "port",
      label: "Port a number",
      subject: `Port an existing number (${branch})`,
      message: `Hi, we'd like to port an existing number into ServWave Phone. Can you help with the porting process and timeline?`,
    },
    {
      id: "limits",
      label: "Raise call/text limits",
      subject: `Increase call / text limits — ${planName} (${branch})`,
      message: `Hi, we're approaching our calling/texting limits on the ${planName} plan. Can we raise our limits or move to a better-fit plan?`,
    },
    {
      id: "billing",
      label: "Billing question",
      subject: `Billing question (${branch})`,
      message: `Hi, I have a question about our billing — could someone reach out?`,
    },
  ];

  const [replyTo, setReplyTo] = useState(userEmail);
  const [subject, setSubject] = useState(
    `Phone plan question — ${planName} (${branch})`,
  );
  const [message, setMessage] = useState("");
  const [topic, setTopic] = useState<string | null>(null);

  function pickTopic(t: (typeof TOPICS)[number]) {
    setTopic(t.id);
    setSubject(t.subject);
    setMessage(t.message);
  }

  function send() {
    onToast(`✓ Email sent to sales — we'll reply to ${replyTo} shortly.`);
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={
        <span className="inline-flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-4 w-4 text-primary" />
          </span>
          Email sales
        </span>
      }
      subtitle="We'll get the message and reply to you."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-light px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-background-light"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!message.trim() || !replyTo.trim()}
            onClick={send}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            Send to sales
          </button>
        </>
      }
    >
        {/* Body */}
        <div className="space-y-3">
          {/* To (fixed) */}
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-16 flex-shrink-0 font-semibold text-text-secondary">
              To
            </span>
            <span className="rounded-md bg-background-light px-2 py-1 font-medium text-text-secondary">
              {SALES_EMAIL}
            </span>
          </div>

          {/* From / reply-to */}
          <div className="flex items-center gap-2 text-[13px]">
            <label
              htmlFor="sales-replyto"
              className="w-16 flex-shrink-0 font-semibold text-text-secondary"
            >
              From
            </label>
            <input
              id="sales-replyto"
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
            />
          </div>

          {/* Subject */}
          <div className="flex items-center gap-2 text-[13px]">
            <label
              htmlFor="sales-subject"
              className="w-16 flex-shrink-0 font-semibold text-text-secondary"
            >
              Subject
            </label>
            <input
              id="sales-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
            />
          </div>

          {/* Preset questions — pick one to fill the subject + message */}
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-secondary">
              Pick a question
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TOPICS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTopic(t)}
                  className={[
                    "rounded-full px-2.5 py-1 text-[12px] font-medium transition",
                    topic === t.id
                      ? "bg-primary text-on-fill"
                      : "border border-border text-text-secondary hover:bg-background-light",
                  ].join(" ")}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Message */}
          <div>
            <label
              htmlFor="sales-message"
              className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-text-secondary"
            >
              What would you like to ask?
            </label>
            <textarea
              id="sales-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Add anything you'd like to discuss with the sales team — pricing, add-on numbers, porting, contract questions…"
              className="w-full resize-y rounded-lg border border-border bg-surface-light px-3 py-2 text-[13px] text-text-primary placeholder:text-text-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
            />
          </div>
        </div>
    </Modal>
  );
}

/* ─────────────────── The page ─────────────────── */

export default function PhonePage() {
  // CASL + identity. The coarse `Communication` subject gates the module; the
  // signed-in user supplies the reply-to email.
  const navigate = useNavigate();
  const ability = useAppAbility();
  const user = useAuthStore((s) => s.user);
  const canRead = ability.can("read", "Communication");
  // Demo gate for the un-backed prototype surfaces (Call masking, Training,
  // Dispatch & Calls, plan-usage/upgrade widgets).
  const isDemo = useIsDemoOrg();
  // Pilot gate for the built-but-non-functional Call flows / Call groups
  // editors — reachable only for the live CTM pilot org (Alpha Doors).
  const isPilot = useIsCommunicationPilotOrg();
  const userEmail = user?.email ?? "";
  // ALPHA's User has no per-branch field; the sales-email decoration uses the
  // product/company label.
  const branch = "ServWave";

  // Toast — ALPHA's global toaster.
  const { toast } = useToast();
  const onToast = (m: string) => toast({ description: m });

  // ── Active module section comes from the URL (replaces App.tsx's
  //    phoneTab/phoneNonce remount hack). Route is /communication/phone/:tab,
  //    with ?tab= as a fallback; default "calls". ──
  const params = useParams<{ tab?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = params.tab ?? searchParams.get("tab") ?? "calls";
  const requestedSection: ModuleSection = (
    MODULE_SECTION_KEYS as string[]
  ).includes(rawTab)
    ? (rawTab as ModuleSection)
    : "calls";
  // A section is hidden when the org may not see it: the demo-only prototype
  // (masking) for real orgs, and the not-yet-ready-for-everyone surfaces
  // (flows/groups/training) for every real org except the CTM pilot (Alpha
  // Doors) — the demo org keeps those too. Hidden sections are dropped from
  // the nav AND deep links to them fall back to Calls.
  const isSectionHidden = (s: ModuleSection): boolean =>
    (!isDemo && DEMO_ONLY_SECTIONS.includes(s)) ||
    (!isDemo && !isPilot && PILOT_AND_DEMO_SECTIONS.includes(s));
  const section: ModuleSection = isSectionHidden(requestedSection)
    ? "calls"
    : requestedSection;
  const moduleTabs = MODULE_TABS.filter((t) => !isSectionHidden(t.key));

  function goToSection(next: ModuleSection) {
    // Keep the URL the source of truth: set ?tab so deep links + back/forward
    // work. (A path-param route /communication/phone/:tab is wired separately by
    // the routing agent; writing the search param keeps both forms in sync.)
    const sp = new URLSearchParams(searchParams);
    sp.set("tab", next);
    setSearchParams(sp);
  }

  // Within-Calls sub-tab + KPI focus stay local (a sub-nav, no remount needed).
  const [tab, setTab] = useState<Tab>("calls");
  const [activeKpi, setActiveKpi] = useState<KpiKey | null>(null);
  const [callsFocus, setCallsFocus] = useState<CallsFocus>("all");


  // ── Module-level lifted state. The monolith seeded these from module-scope
  //    imports; in ALPHA they seed from the seam hooks and stay locally mutable
  //    so the prototype's mutations (dispatch clear, flow assign) persist within
  //    the session. Blocked callers are NOT among them any more: that list is
  //    server state, read straight off useBlockedNumbers. ──
  const { data: seedCalls = [] } = useCalls();
  const { data: seedThreads = [] } = useMessageThreads();
  const { data: seedFlows = [] } = useCallFlows();
  const { data: seedGroups = [] } = useCallGroups();
  const { data: blockedNumbers = [] } = useBlockedNumbers();
  const { data: seedNumbers = [], isLoading: numbersLoading } = useNumbers();
  const { data: customers = [] } = usePhoneCustomers();
  const { data: phoneAgents = [] } = usePhoneAgents();
  const blockMutation = useBlockNumber();
  const unblockMutation = useUnblockNumber();

  const [calls, setCalls] = useState<CallSession[]>([]);
  const [threads, setThreads] = useState<MessageThread[]>([]);
  // Owned numbers + custom call flows are lifted here so the Call flows tab and
  // the Phone numbers tab share one source of truth: a number's flowId is what
  // links them (PHONE-SYSTEM-PRD §14.18). Numbers hydrate from the real
  // GET /api/communication/numbers query (slice 7) — no seeds.
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [callFlows, setCallFlows] = useState<CallFlow[]>([]);
  const [callGroups, setCallGroups] = useState<CallGroup[]>([]);

  // Hydrate the lifted copies once each seam query resolves.
  useEffect(() => {
    if (seedCalls.length) setCalls(seedCalls);
  }, [seedCalls]);
  useEffect(() => {
    if (seedThreads.length) setThreads(seedThreads);
  }, [seedThreads]);
  useEffect(() => {
    if (seedFlows.length) setCallFlows(seedFlows);
  }, [seedFlows]);
  useEffect(() => {
    if (seedGroups.length) setCallGroups(seedGroups);
  }, [seedGroups]);
  useEffect(() => {
    if (seedNumbers.length) setNumbers(seedNumbers);
  }, [seedNumbers]);

  function blockNumber(input: {
    number: string;
    name?: string;
    reason: BlockReason;
    note?: string;
  }) {
    const number = input.number.trim();
    if (!number) return;
    // No client-side duplicate check: the server owns it (409 ALREADY_BLOCKED),
    // and it is the only check that survives a second browser.
    blockMutation.mutate(
      {
        number,
        name: input.name,
        reason: input.reason,
        note: input.note?.trim() || undefined,
      },
      {
        onSuccess: () =>
          onToast(`🚫 Blocked ${input.name ? `${input.name} · ` : ""}${number}`),
        onError: (err) => onToast(blockNumberErrorMessage(err)),
      },
    );
  }

  function unblockNumber(id: string) {
    unblockMutation.mutate(
      { id },
      {
        onSuccess: () => onToast("✓ Number unblocked"),
        onError: (err) => onToast(blockNumberErrorMessage(err)),
      },
    );
  }

  // Assign a flow to a set of numbers (and detach numbers no longer selected),
  // keeping number.flowId as the single source of truth for the linkage.
  function assignFlowToNumbers(flowId: string, numberIds: string[]) {
    setNumbers((prev) =>
      prev.map((n) => {
        if (numberIds.includes(n.id)) return { ...n, flowId };
        if (n.flowId === flowId) return { ...n, flowId: "" };
        return n;
      }),
    );
  }

  // Date-range filter for the Calls page — lifted here so the picker can live
  // in the top-right of the header while the table/stats consume the range.
  const [datePreset, setDatePreset] = useState<RangePreset>("30d");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const dateRange = useMemo(
    () => computeRange(datePreset, dateStart, dateEnd, isDemo),
    [datePreset, dateStart, dateEnd, isDemo],
  );

  const missed = calls.filter(
    (c) => c.status === "missed" || c.status === "voicemail",
  );
  const unreadCount = threads.reduce((s, t) => s + t.unread, 0);
  const needsAttention = calls.filter(callNeedsAttention);
  // "Calls today" = calls on the calendar day of the page anchor (DEMO_NOW for
  // demo orgs, real now otherwise — the same anchor the presets use), not the
  // all-time count.
  const callsToday = useMemo(
    () => countCallsOnDay(calls, isDemo ? DEMO_NOW : new Date()),
    [calls, isDemo],
  );

  // Coarse module gate. Without read on Communication there's nothing to show.
  if (!canRead) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-sm text-text-secondary">
        You don't have access to the Phone module.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Module header — product name, business number, plan usage, and the
          primary nav that moves between the Phone module's pages. */}
      <div className="border-b border-border bg-surface-light px-6 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              ServWave Phone
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {/* Plan usage + upgrade tiers are prototype billing seeds — demo
                orgs only until real plan/billing data exists. */}
            {isDemo && (
              <PlanUsage onToast={onToast} userEmail={userEmail} branch={branch} />
            )}
            <button
              onClick={() => openPhoneTab()}
              aria-label="Open dialer"
              title="Open dialer — opens the phone tab"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
            >
              <Phone className="h-4 w-4" />
              Dialer
            </button>
          </div>
        </div>

        {/* Primary module nav */}
        <div className="mt-3 flex items-center gap-1 overflow-x-auto">
          {moduleTabs.map((t) => (
            <ModuleTab
              key={t.key}
              active={section === t.key}
              onClick={() => goToSection(t.key)}
              label={t.label}
              icon={t.icon}
            />
          ))}
        </div>
      </div>

      {section === "training" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <TrainingView
            onToast={onToast}
          />
        </div>
      ) : section === "numbers" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <NumbersView
            numbers={numbers}
            setNumbers={setNumbers}
            callFlows={callFlows}
            loading={numbersLoading}
            onToast={onToast}
          />
        </div>
      ) : section === "flows" ? (
        <div className="flex-1 overflow-hidden bg-background-light">
          <CallFlowsView
            flows={callFlows}
            setFlows={setCallFlows}
            numbers={numbers}
            groupOptions={groupTargetOptions(callGroups)}
            onAssignNumbers={assignFlowToNumbers}
            onToast={onToast}
          />
        </div>
      ) : section === "groups" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <CallGroupsView
            groups={callGroups}
            setGroups={setCallGroups}
            onToast={onToast}
          />
        </div>
      ) : section === "masking" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <CallMaskingView onToast={onToast} />
        </div>
      ) : section === "blocked" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <BlockedCallersView
            blocked={blockedNumbers}
            onBlock={blockNumber}
            onUnblock={unblockNumber}
          />
        </div>
      ) : section !== "calls" ? (
        <div className="flex-1 overflow-y-auto bg-background-light">
          <ModulePlaceholder section={section} onToast={onToast} />
        </div>
      ) : (
        <>
          {/* KPI tiles — clickable, jump to the matching sub-tab. */}
          <div className="border-b border-border bg-surface-light px-6 py-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KPITile
                label="Calls today"
                value={String(callsToday)}
                icon={PhoneCall}
                tone="indigo"
                active={activeKpi === "calls"}
                onClick={() => {
                  setActiveKpi("calls");
                  setCallsFocus("all");
                  setTab("calls");
                }}
              />
              <KPITile
                label="Missed Calls"
                value={String(missed.length)}
                icon={PhoneMissed}
                tone="amber"
                active={activeKpi === "callback"}
                onClick={() => {
                  setActiveKpi("callback");
                  setCallsFocus("callback");
                  setTab("calls");
                }}
              />
              <KPITile
                label="Unread messages"
                value={String(unreadCount)}
                icon={MessageSquare}
                tone="sky"
                active={activeKpi === "unread"}
                onClick={() => {
                  navigate("/communication/text");
                }}
              />
              <KPITile
                label="Needs Attention"
                value={String(needsAttention.length)}
                icon={AlertTriangle}
                tone="rose"
                active={activeKpi === "attention"}
                onClick={() => {
                  setActiveKpi("attention");
                  setCallsFocus("attention");
                  setTab("calls");
                }}
              />
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex items-center gap-1 border-b border-border bg-surface-light px-6">
            <TabButton
              active={tab === "calls"}
              onClick={() => setTab("calls")}
              label="Calls"
              count={calls.length}
              icon={ListChecks}
            />
            {/* Dispatch & Calls is a mock-fed prototype board — demo orgs only. */}
            {isDemo && (
              <TabButton
                active={tab === "dispatch"}
                onClick={() => setTab("dispatch")}
                label="Dispatch & Calls"
                count={calls.length}
                icon={PhoneCall}
              />
            )}
            <TabButton
              active={tab === "performance"}
              onClick={() => setTab("performance")}
              label="Performance & QA"
              count={phoneAgents.length}
              icon={BarChart3}
            />
            {tab === "calls" && (
              <div className="ml-auto py-1.5">
                <DateRangeControl
                  preset={datePreset}
                  customStart={dateStart}
                  customEnd={dateEnd}
                  range={dateRange}
                  onPreset={(p) => setDatePreset(p)}
                  onCustom={(s, e) => {
                    setDateStart(s);
                    setDateEnd(e);
                    setDatePreset("custom");
                  }}
                />
              </div>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto bg-background-light">
            {tab === "calls" && (
              <CallsView
                calls={calls}
                range={dateRange}
                focus={callsFocus}
                onClearFocus={() => {
                  setCallsFocus("all");
                  setActiveKpi(null);
                }}
                onToast={onToast}
              />
            )}
            {tab === "dispatch" && isDemo && (
              <DispatchView
                calls={calls}
                setCalls={setCalls}
                onToast={onToast}
              />
            )}
            {tab === "performance" && (
              <PerformanceView calls={calls} onToast={onToast} />
            )}
          </div>
        </>
      )}

    </div>
  );
}

/* ─────────────────── Shell-local presentational pieces ─────────────────── */

function KPITile({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "indigo" | "amber" | "sky" | "rose";
  onClick?: () => void;
  active?: boolean;
}) {
  const tones: Record<typeof tone, string> = {
    indigo: "border-primary/30 bg-primary/5",
    amber: "border-warning-border bg-warning-surface/40",
    sky: "border-info-border bg-info-surface/40",
    rose: "border-danger-border bg-danger-surface/40",
  };
  const iconTones: Record<typeof tone, string> = {
    indigo: "text-primary",
    amber: "text-warning-text",
    sky: "text-info-text",
    rose: "text-danger-text",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "rounded-md border p-3 text-left transition hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        tones[tone],
        active ? "ring-2 ring-primary" : "",
      ].join(" ")}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          {label}
        </span>
        <Icon className={`h-3.5 w-3.5 ${iconTones[tone]}`} />
      </div>
      <p className="mt-1 text-xl font-bold text-text-primary">{value}</p>
    </button>
  );
}

function ModuleTab({
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

function ModulePlaceholder({
  section,
  onToast,
}: {
  section: Exclude<ModuleSection, "calls" | "training">;
  onToast: (m: string) => void;
}) {
  const meta = SECTION_META[section];
  const Icon = meta.icon;
  return (
    <div className="space-y-4 p-6">
      {/* Description + primary action */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">{meta.desc}</p>
        <button
          onClick={() => onToast(`${meta.action} — coming soon`)}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {meta.action}
        </button>
      </div>

      <EmptyState
        variant="card"
        icon={Icon}
        title={`No ${meta.title.toLowerCase()} yet`}
        description={`This page is set up and ready — we can wire up the full ${meta.title.toLowerCase()} workflow next.`}
        action={
          <button
            onClick={() => onToast(`${meta.action} — coming soon`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2 text-sm font-semibold text-text-secondary hover:bg-background-light"
          >
            <Plus className="h-4 w-4" />
            {meta.action}
          </button>
        }
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "relative inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition",
        active
          ? "border-primary text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span
        className={[
          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
          active
            ? "bg-primary/10 text-primary"
            : "bg-background-light text-text-secondary",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
  );
}
