// Communication module — Email inbox (Gmail-style 3-pane client).
//
// Ported from Emanuel's InboxPage monolith. The compose surfaces and the AI
// assist menu were lifted into sibling files; this file keeps the page shell,
// the folder/list/reader three-pane, and the reading pane.
//   • AiAssistMenu                     -> inbox/AiAssistMenu.tsx
//   • ComposeWindow / ComposerToolbar /
//     InlineComposer / AccountChip /
//     AttachmentChips / filesToAttachments / IconBtn  -> inbox/ComposeWindow.tsx
//   • ManageDirectoryModal             -> inbox/InboxDirectory.tsx (sibling agent)
//
// Faithful cut — behaviour and prop signatures preserved verbatim. Changes:
//   1. Tailwind tokens indigo/slate -> ALPHA design tokens. The emerald, amber,
//      rose, sky and blue tints now resolve through the semantic
//      success/warning/danger/info token families too.
//   2. Domain data (emails, groups, forward rules, team members) comes from the
//      `@/lib/api/communication` seam. This page no longer reads the mock
//      mailbox identities (ACCOUNTS / PRIMARY_ACCOUNT) at all - with exactly
//      one sending identity there was nothing for a per-message "via" badge to
//      distinguish. Local state seeds from the hooks and
//      stays optimistic (the prototype mutates in place; seam mutations are
//      fired fire-and-forget — no-ops in mock mode).
//   3. The outgoing sender name comes from the signed-in user (auth store +
//      CASL), replacing the prototype's hardcoded owner name.
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowLeft,
  AlertTriangle,
  BellOff,
  Bookmark,
  Calendar,
  Clock,
  CornerUpLeft,
  CornerUpRight,
  Forward,
  Inbox as InboxIcon,
  ListChecks,
  Mail,
  MailOpen,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  PenLine,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
  UserCircle2,
  Users,
} from "lucide-react";
import {
  ComposeWindow,
  IconBtn,
  InlineComposer,
  UNDO_SEND_WINDOW_MS,
  useUndoSend,
} from "@/components/communication/inbox/ComposeWindow";
import { EmailMessageBody } from "@/components/communication/inbox/EmailMessageBody";
import { ManageDirectoryModal } from "@/components/communication/inbox/InboxDirectory";
import { JobBadge } from "@/components/communication/shared/atoms";
import { EmailDeliveryPill } from "@/components/communication/shared/EmailDeliveryPill";
import { InboundSenderPill } from "@/components/communication/shared/InboundSenderPill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppAbility } from "@/contexts/AbilityContext";
import { useAuthStore, userDisplayName } from "@/stores/auth.store";
import { getInitials } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useAssignableUsers, type AssignableUser } from "@/lib/api/users";
import {
  senderLabel,
  asThreadChangedConflict,
  emailSendErrorMessage,
  useAssignEmailThread,
  useUnmatchedEmails,
  useLinkInboundEmail,
  linkInboundErrorMessage,
  useEmailGroups,
  useEmails,
  useForwardRules,
  useMarkEmailThreadRead,
  useSendEmail,
  useTeamMembers,
  useSendingIdentity,
} from "@/lib/api/communication";
import { useEmailRealtime } from "@/lib/notifications/useEmailRealtime";
import type {
  AccountId,
  ComposeState,
  Email,
  EmailAssignmentView,
  EmailGroup,
  ForwardRule,
  ReplyDraft,
  TeamMember,
} from "@/lib/api/communication";

/** `unmatched` (email slice 6) is NOT an Email.folder value - every row in it
 *  is stored as `inbox`. It is a separate server-side worklist keyed on
 *  inbound_match, given a rail entry because that is where an operator already
 *  looks for mail, not because it is a folder. Everything reading `folder`
 *  against `e.folder` has to special-case it for exactly that reason. */
type Folder = "inbox" | "starred" | "sent" | "drafts" | "archive" | "unmatched";

/** Unassigned / Mine / All tab strip above the message list (email slice 8b).
 *  Reuses the same Tabs/TabsList/TabsTrigger `variant="pill"` recipe already
 *  shipped for PriceBookPicker's segmented control (components/ui/tabs.tsx) -
 *  not a new filter-tab pattern. */
const ASSIGNMENT_VIEWS: { id: EmailAssignmentView; label: string }[] = [
  { id: "unassigned", label: "Unassigned" },
  { id: "mine", label: "Mine" },
  { id: "all", label: "All" },
];

/** The conversation key for an email. Messages with the same key form a thread. */
function threadKey(e: Email): string {
  return e.threadId ?? e.id;
}

/** Narrow a conversation key to one the SERVER issued, for submitting as
 *  `thread_id`.
 *
 *  A compose with nothing to reply to has no thread yet - the server only mints
 *  one after the send succeeds - so the optimistic row groups under a locally
 *  minted `t_<epoch>` key in the meantime. That key is a client-side grouping
 *  handle and nothing more: `emails.thread_id` is a uuid column, so submitting
 *  it made Postgres reject the whole send (see resolveVisibleThreadId). Omitted
 *  instead, which is what a fresh compose means anyway. */
const SERVER_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function serverThreadId(id: string | undefined): string | undefined {
  return id && SERVER_THREAD_ID_RE.test(id) ? id : undefined;
}

// Stable singletons for the "no data yet" fallback on the seed queries below.
// An inline `data = []` default creates a NEW array every render, which never
// equals itself by reference - the useEffect that seeds local state off of it
// (`[emailSeed]` etc.) would then re-fire on every render even while nothing
// has actually changed, setting state to a fresh-but-equal array each time and
// re-triggering forever. Module-level constants keep the fallback referentially
// stable across renders so the effect only fires when the query's data itself
// actually changes.
const EMPTY_EMAILS: Email[] = [];
const EMPTY_GROUPS: EmailGroup[] = [];
const EMPTY_FORWARDS: ForwardRule[] = [];

const FOLDERS: { id: Folder; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: PenLine },
  { id: "archive", label: "Archive", icon: Archive },
  // Email slice 6 - replies whose sender did not check out, held back from the
  // conversation until someone decides. Last in the rail: it should be findable
  // without competing with the folders people use every day.
  { id: "unmatched", label: "Needs review", icon: ShieldAlert },
];

const LABEL_TONE: Record<string, string> = {
  Customer: "bg-success-surface text-success-text ring-success-border",
  Vendor: "bg-warning-surface text-warning-text ring-warning-border",
  Lead: "bg-info-surface text-info-text ring-info-border",
  Billing: "bg-info-surface text-info-text ring-info-border",
  Reviews: "bg-danger-surface text-danger-text ring-danger-border",
};

const AVATAR_TINTS = [
  "bg-primary-subtle text-primary-dark",
  "bg-success-surface text-success-text",
  "bg-info-surface text-info-text",
  "bg-warning-surface text-warning-text",
  "bg-danger-surface text-danger-text",
  "bg-info-surface text-info-text",
];
function tintFor(s: string): string {
  if (!s) return AVATAR_TINTS[0]!;
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length] ?? AVATAR_TINTS[0]!;
}

export default function InboxPage() {
  // Coarse Communication gate + signed-in user identity (replaces the
  // prototype's hardcoded owner). 0 functional gates in this view — the ability
  // is read so the page participates in the module's permission story.
  const ability = useAppAbility();
  const user = useAuthStore((s) => s.user);
  const canRead = ability.can("read", "Communication");
  const ownerName = userDisplayName(user);

  // Unassigned / Mine / All (email slice 8b) - an ADDITIONAL filter on top of
  // the inbox's normal visibility, never a narrower one (Missive's rule:
  // "assigned to one, visible to all"). Server-side, via ?assignment= — not a
  // client-side re-filter of an already-fetched list, so the counts/paging
  // this will eventually grow into stay correct.
  const [assignmentView, setAssignmentView] = useState<EmailAssignmentView>("all");

  // Domain data from the seam. Local state mirrors it and stays optimistic so
  // the Gmail-style mutations (send / archive / star / snooze) feel instant.
  // Both halves of this line are load-bearing and came from different branches.
  // `assignmentView` is slice 8b's server-side Unassigned/Mine/All filter; the
  // EMPTY_* constants are staging's fix for the folder-nav infinite render loop
  // (a bare `= []` mints a new array reference every render, which retriggers
  // the seeding effect below forever). Dropping either one is a regression.
  const { data: emailSeed = EMPTY_EMAILS } = useEmails(assignmentView);
  // A customer reply shows up the moment the inbound webhook fires, instead of
  // whenever this query happens to go stale. The BELL is handled separately and
  // app-wide by useNotificationRealtime in Header - this only keeps the open
  // message list fresh.
  useEmailRealtime();
  const { data: groupSeed = EMPTY_GROUPS } = useEmailGroups();
  const { data: forwardSeed = EMPTY_FORWARDS } = useForwardRules();
  const { data: members = [] } = useTeamMembers();
  // The address the recipient will actually see. Undefined until it loads, and
  // on the plans/roles that cannot reach the endpoint - the compose surfaces
  // fall back to their honest "no mailbox" placeholder for exactly that gap,
  // rather than rendering a guess in the meantime.
  const { data: sendingIdentity } = useSendingIdentity();
  const fromAddress = sendingIdentity?.address;
  // `?? true` while the query is in flight - see ComposeWindow's sendingEnabled
  // doc. Defaulting to false would flash a "sending is off" warning at every
  // user on every open, which is worse than showing it a beat late.
  const sendingEnabled = sendingIdentity?.sendingEnabled ?? true;
  // Every org user this thread could be assigned to - the same roster
  // AssigneeSelect/LeadsPage's "Assigned To" filter already read (no
  // eligibleFor filter: any user, not one scoped to a job/lead role).
  const { data: assignableUsers = [] } = useAssignableUsers();
  const sendEmail = useSendEmail();
  const assignThread = useAssignEmailThread();

  const markThreadRead = useMarkEmailThreadRead();
  const queryClient = useQueryClient();

  const memberById = (id: string) => members.find((m) => m.id === id);

  const [emails, setEmails] = useState<Email[]>(emailSeed);
  const [groups, setGroups] = useState<EmailGroup[]>(groupSeed);
  const [forwards, setForwards] = useState<ForwardRule[]>(forwardSeed);

  // Re-seed when the queries resolve (mock data lands on first paint).
  useEffect(() => setEmails(emailSeed as Email[]), [emailSeed]);
  useEffect(() => setGroups(groupSeed), [groupSeed]);
  useEffect(() => setForwards(forwardSeed), [forwardSeed]);

  // Email slice 6 - the unmatched queue. Server-owned and never merged into
  // `emails` local state: these rows are the one thing on this page that must
  // not be optimistically mutated, since "we refused to attach this" is a
  // security verdict rather than a UI preference.
  const unmatched = useUnmatchedEmails().data ?? [];
  const linkInbound = useLinkInboundEmail();

  const [folder, setFolder] = useState<Folder>("inbox");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  /** `action`, when present, renders an extra button in the toast pill (used
   *  only by undo-send today) - kept on the SAME toast state the rest of the
   *  page already flashes plain strings through, rather than a second,
   *  parallel toast system. */
  const [toast, setToast] = useState<{ message: string; action?: { label: string; onClick: () => void } } | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [manageTab, setManageTab] = useState<null | "members" | "groups" | "forwarding">(null);
  // Left rail can be collapsed to free up screen space; it auto-collapses when
  // an email is opened, and the owner can reopen / re-close it any time.
  const [railOpen, setRailOpen] = useState(true);
  // Undo-send (email slice 7): one queued send at a time per surface - the
  // compose window and the inline reply close the instant Send is clicked, so
  // they can never race each other for the same timer.
  const undoComposeSend = useUndoSend<ComposeState>();
  const undoReplySend = useUndoSend<ReplyDraft>();
  // Traffic Cop (email slice 8b) - set only when a send 409s THREAD_CHANGED.
  // `payload` is the EXACT SendEmailArgs the failed attempt used, minus
  // `composing_since` — replaying it verbatim is what "Send anyway" means;
  // dropping the timestamp is what keeps the guard from tripping a second
  // time on the retry (an absent composing_since never fires it — see
  // sendEmail's own contract). `draft` is what "Edit" reopens.
  const [trafficCop, setTrafficCop] = useState<{
    payload: Parameters<typeof sendEmail.mutate>[0];
    optimisticId: string;
    kind: "reply" | "compose";
    draft: ReplyDraft | ComposeState;
    messages: Email[];
  } | null>(null);

  function flash(msg: string, action?: { label: string; onClick: () => void }) {
    setToast({ message: msg, action });
    setTimeout(() => setToast(null), action ? UNDO_SEND_WINDOW_MS : 2600);
  }

  /** Assign the OPEN thread to a user, or clear it with `null` (Unassigned).
   *  No-op when the open message carries no real thread (a system/
   *  transactional row - see Email.threadAssignedToUserId's own doc). */
  function assignOpenThread(userId: string | null) {
    if (!open?.threadId) return;
    assignThread.mutate(
      { threadId: open.threadId, userId },
      {
        onSuccess: () => {
          setEmails((prev) =>
            prev.map((e) =>
              e.threadId === open.threadId ? { ...e, threadAssignedToUserId: userId } : e,
            ),
          );
          flash(userId ? "Conversation assigned" : "Conversation unassigned");
        },
        onError: () => flash("Couldn't update the assignment - try again"),
      },
    );
  }

  /** Email slice 6 - attach the open unmatched message to the conversation its
   *  own reply token points at. Deliberately NOT optimistic: the server owns
   *  this verdict, and pretending the message moved before it confirmed would
   *  be the one place on this page where a UI guess could contradict a security
   *  decision. Both lists refetch on success (shared query key). */
  function linkOpenMessage() {
    if (!open) return;
    linkInbound.mutate(
      { emailId: open.id },
      {
        onSuccess: () => {
          setOpenId(null);
          flash("Added to the conversation");
        },
        onError: (err) => flash(linkInboundErrorMessage(err)),
      },
    );
  }

  // One row per conversation: take the latest message in the current folder for
  // each thread, plus the total message count across all folders (Gmail-style).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The unmatched queue is its own server-side list, not a slice of `emails` -
    // its rows are stored as folder 'inbox' and carry no thread, so filtering
    // the main list by folder would either miss them or mix them into the real
    // inbox. Thread grouping below then leaves each one standing alone, which
    // is correct: an unattached message is not part of any conversation yet.
    const source = folder === "unmatched" ? unmatched : emails;
    const matches = source
      .filter((e) => folder === "unmatched" || (folder === "starred" ? e.starred : e.folder === folder))
      .filter((e) => folder !== "inbox" || !e.snoozedUntil)
      .filter(
        (e) =>
          !q ||
          e.subject.toLowerCase().includes(q) ||
          e.snippet.toLowerCase().includes(q) ||
          // senderLabel, not from.name: a nameless sender stores null there,
          // and `null.toLowerCase()` threw - so typing in the search box with
          // one bare-address reply in the list took the whole page down.
          senderLabel(e.from).toLowerCase().includes(q) ||
          e.from.email.toLowerCase().includes(q),
      );
    const latestByThread = new Map<string, Email>();
    for (const e of matches) {
      const k = threadKey(e);
      const cur = latestByThread.get(k);
      if (!cur || e.ts > cur.ts) latestByThread.set(k, e);
    }
    const totalByThread = new Map<string, number>();
    for (const e of source) {
      const k = threadKey(e);
      totalByThread.set(k, (totalByThread.get(k) ?? 0) + 1);
    }
    return [...latestByThread.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((e) => ({ email: e, count: totalByThread.get(threadKey(e)) ?? 1 }));
  }, [emails, unmatched, folder, query]);

  // An unmatched message lives only in its own list, so look there too - opening
  // one from the queue must not fall through to "nothing selected".
  const open = emails.find((e) => e.id === openId)
    ?? unmatched.find((e) => e.id === openId)
    ?? null;
  // Every message in the open conversation, oldest → newest. An unmatched
  // message is deliberately alone here: it has not been attached to anything,
  // and showing it inside a conversation would imply it had been.
  const openThread = open
    ? (open.inboundMatch && open.inboundMatch !== "MATCHED"
        ? [open]
        : emails
            .filter((e) => threadKey(e) === threadKey(open))
            .sort((a, b) => a.ts - b.ts))
    : [];

  function countFor(f: Folder): number {
    // A count of work waiting, like Inbox's unread count - not a total, since
    // every row in this queue is by definition outstanding.
    if (f === "unmatched") return unmatched.length;
    const set = emails.filter((e) =>
      f === "starred" ? e.starred : e.folder === f,
    );
    if (f === "inbox") return set.filter((e) => e.unread).length;
    return set.length;
  }

  function openEmail(id: string) {
    setOpenId(id);
    setReply(null);
    setRailOpen(false); // free up space the moment a message is opened
    // Persist read-state server-side for the whole conversation (keeps the
    // top-bar Mail badge truthful across devices/reloads). Gated on
    // update-Communication so read-only roles don't fire doomed 403s.
    const clicked = emails.find((e) => e.id === id);
    if (clicked && ability.can("update", "Communication")) {
      const k = threadKey(clicked);
      if (emails.some((e) => threadKey(e) === k && e.unread)) markThreadRead.mutate(k);
    }
    setEmails((prev) => {
      const target = prev.find((e) => e.id === id);
      if (!target) return prev;
      const k = threadKey(target);
      return prev.map((e) => (threadKey(e) === k ? { ...e, unread: false } : e));
    });
  }

  function toggleStar(id: string) {
    setEmails((prev) =>
      prev.map((e) => (e.id === id ? { ...e, starred: !e.starred } : e)),
    );
  }

  // Generic patch — backs the Gmail-style reading-pane actions (mark unread,
  // snooze, mark important, mute, report spam).
  function updateEmail(id: string, patch: Partial<Email>) {
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function archive(id: string) {
    setEmails((prev) =>
      prev.map((e) => (e.id === id ? { ...e, folder: "archive" } : e)),
    );
    setOpenId(null);
    flash("Conversation archived");
  }

  // ——— Compose / Reply / Forward ———
  const defaultAccount: AccountId = "system";

  function startCompose() {
    setCompose({ mode: "new", account: defaultAccount, to: "", subject: "", body: "" });
  }

  // Email a teammate directly, or a whole group (comma-joined recipients).
  function emailMember(m: TeamMember) {
    setCompose({ mode: "new", account: defaultAccount, to: m.email, subject: "", body: "" });
    flash(`✉️ New email to ${m.name}`);
  }
  function emailGroup(g: EmailGroup) {
    const to = g.memberIds
      .map((id) => memberById(id)?.email)
      .filter(Boolean)
      .join(", ");
    setCompose({ mode: "new", account: defaultAccount, to, subject: "", body: "" });
    flash(`✉️ New group email to ${g.name} (${g.memberIds.length})`);
  }

  function quoted(email: Email): string {
    // `Name <addr>` when there is a name, bare `addr` when there is not -
    // matching Gmail. Interpolating from.name directly used to put the literal
    // word "null" into the quoted header of every reply to a bare address.
    const attribution = email.from.name?.trim()
      ? `${email.from.name.trim()} <${email.from.email}>`
      : email.from.email;
    return `\n\n\n———\nOn ${email.at}, ${attribution} wrote:\n${email.body.join("\n")}`;
  }

  // Reply & forward open INLINE under the thread (Gmail behavior). The body
  // starts empty (cursor-ready); the original is shown as a collapsed quote in
  // the inline composer.
  function startReply(email: Email) {
    setReply({
      emailId: email.id,
      mode: "reply",
      account: email.account,
      to: email.from.email,
      subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
      body: "",
      // Attach-by-origin inherits from the message being replied to, the same
      // way its own job/customer attribution already does - a reply about a
      // job should be able to attach that job's photos without re-navigating.
      jobId: email.jobId,
      customerId: email.customerId,
      // Traffic Cop (email slice 8b) - stamped the instant the editor opens,
      // never re-stamped while it stays open.
      composingSince: new Date().toISOString(),
    });
  }

  function startForward(email: Email) {
    setReply({
      emailId: email.id,
      mode: "forward",
      account: email.account,
      to: "",
      subject: email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`,
      body: "",
      jobId: email.jobId,
      customerId: email.customerId,
      composingSince: new Date().toISOString(),
    });
  }

  // Send the inline reply: the typed body plus the quoted original, filed to
  // Sent. Undo-send (email slice 7): the network call is deferred behind a
  // cancellable window (useUndoSend) - the composer closes and the optimistic
  // row lands immediately (Gmail-style), but nothing reaches the API until
  // the window elapses; clicking Undo pulls the optimistic row back out and
  // reopens the reply with its exact draft.
  function sendReply() {
    if (!reply) return;
    const to = reply.to.trim();
    if (!to) {
      flash("Add a recipient first");
      return;
    }
    const draft = reply;
    setReply(null);
    // There is no per-org sending mailbox today, so the optimistic row carries
    // the sender's NAME and no address rather than inventing one.
    const fromEmail = "";
    const orig = emails.find((e) => e.id === draft.emailId);
    const fullText = (draft.body.trim() + (orig ? quoted(orig) : "")).trim();
    const atts = draft.attachments ?? [];
    const threadId = orig ? threadKey(orig) : `t_${Date.now()}`;
    const optimisticId = `e_${Date.now()}`;
    const sent: Email = {
      id: optimisticId,
      threadId,
      account: draft.account,
      from: { name: ownerName, email: fromEmail },
      to,
      subject: draft.subject.trim() || "(no subject)",
      snippet: draft.body.trim().replace(/\s+/g, " ").slice(0, 100) || "(no content)",
      body: bodyToParas(fullText),
      at: nowLabel(),
      ts: nextTs(),
      unread: false,
      starred: false,
      folder: "sent",
      hasAttachment: atts.length > 0,
      attachments: atts.length ? atts : undefined,
      cc: draft.cc || undefined,
      bcc: draft.bcc || undefined,
    };
    setEmails((prev) => [sent, ...prev]);

    undoReplySend.schedule(draft, () => {
      // The retry-able payload (email slice 8b's Traffic Cop "Send anyway"
      // replays exactly this, minus composing_since - see trafficCop state's
      // own doc). Built once so the guarded attempt and a later unguarded
      // retry can never drift apart.
      const basePayload = {
        to,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        subject: sent.subject,
        body: bodyToParas(fullText),
        thread_id: serverThreadId(threadId),
        job_id: draft.jobId,
        customer_id: draft.customerId,
        files: atts.map((a) => a.file).filter((f): f is File => Boolean(f)),
      };
      sendEmail.mutate(
        { ...basePayload, composing_since: draft.composingSince },
        {
          onError: (err) => {
            const conflict = asThreadChangedConflict(err);
            if (conflict) {
              // Blocking - the send is neither retried nor dropped silently;
              // the optimistic row stays put until the owner picks an action.
              setTrafficCop({
                payload: basePayload,
                optimisticId,
                kind: "reply",
                draft,
                messages: conflict.messages,
              });
              return;
            }
            flash(emailSendErrorMessage(err));
            // The send never actually happened - drop the optimistic row too,
            // not just refetch, or a failed send would still show as "sent".
            setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
            queryClient.invalidateQueries({ queryKey: ["communication", "emails"] });
          },
        },
      );
    });

    flash(`Sending to ${to} in 10s`, {
      label: "Undo",
      onClick: () => {
        const restored = undoReplySend.undo();
        if (!restored) return;
        setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
        setReply(restored);
        setToast(null);
      },
    });
  }

  // Discarding an inline reply with content saves a draft (Gmail); empty closes.
  function discardReply() {
    if (!reply) return;
    if (reply.body.trim()) {
      const orig = emails.find((e) => e.id === reply.emailId);
      const draft: Email = {
        id: `e_${Date.now()}`,
        threadId: orig ? threadKey(orig) : `t_${Date.now()}`,
        account: reply.account,
        from: { name: ownerName, email: "" },
        to: reply.to.trim() || "(no recipient)",
        subject: reply.subject.trim() || "(no subject)",
        snippet: reply.body.trim().replace(/\s+/g, " ").slice(0, 100) || "(draft)",
        body: bodyToParas(reply.body),
        at: nowLabel(),
        ts: nextTs(),
        unread: false,
        starred: false,
        folder: "drafts",
      };
      setEmails((prev) => [draft, ...prev]);
      flash("Draft saved");
    }
    setReply(null);
  }

  // Pop the inline reply out into the floating compose window (Gmail's pop-out).
  function popOutReply() {
    if (!reply) return;
    const orig = emails.find((e) => e.id === reply.emailId);
    setCompose({
      mode: reply.mode,
      account: reply.account,
      to: reply.to,
      cc: reply.cc,
      bcc: reply.bcc,
      subject: reply.subject,
      body: reply.body + (orig ? quoted(orig) : ""),
      // Attachments used to silently vanish across a pop-out - harmless while
      // they were display-only strings, a real dropped upload now that they
      // carry the actual File (email slice 7).
      attachments: reply.attachments,
      threadId: orig ? threadKey(orig) : undefined,
      replyToEmailId: reply.mode === "reply" ? reply.emailId : undefined,
      jobId: reply.jobId,
      customerId: reply.customerId,
      // Traffic Cop (email slice 8b) - carries over verbatim; popping a reply
      // out into the floating window does not restart the "since" clock.
      composingSince: reply.composingSince,
    });
    setReply(null);
  }

  function nextTs(): number {
    return emails.reduce((m, e) => Math.max(m, e.ts), 0) + 1;
  }
  function nowLabel(): string {
    return new Date().toLocaleTimeString('en-US', { hour: "numeric", minute: "2-digit" });
  }
  function bodyToParas(text: string): string[] {
    const t = text.trim();
    return t ? t.split(/\n{2,}/) : ["(no content)"];
  }

  // Undo-send (email slice 7) - see sendReply()'s doc for the shape; the
  // compose window closes immediately, the optimistic Sent row lands right
  // away, and the actual multipart POST is deferred behind the cancellable
  // window.
  function sendCompose() {
    if (!compose) return;
    const to = compose.to.trim();
    if (!to) {
      flash("Add a recipient first");
      return;
    }
    const draft = compose;
    setCompose(null);
    // No per-org sending mailbox today - see sendReply().
    const fromEmail = "";
    const text = draft.body.trim();
    const atts = draft.attachments ?? [];
    const threadId = draft.threadId ?? `t_${Date.now()}`;
    const optimisticId = `e_${Date.now()}`;
    const sent: Email = {
      id: optimisticId,
      threadId,
      account: draft.account,
      from: { name: ownerName, email: fromEmail },
      to,
      subject: draft.subject.trim() || "(no subject)",
      snippet: text.replace(/\s+/g, " ").slice(0, 100) || "(no content)",
      body: bodyToParas(draft.body),
      at: nowLabel(),
      ts: nextTs(),
      unread: false,
      starred: false,
      folder: "sent",
      hasAttachment: atts.length > 0,
      attachments: atts.length ? atts : undefined,
      cc: draft.cc || undefined,
      bcc: draft.bcc || undefined,
    };
    setEmails((prev) => [sent, ...prev]);

    undoComposeSend.schedule(draft, () => {
      // See sendReply()'s identical basePayload doc - same Traffic Cop contract.
      const basePayload = {
        to,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        subject: sent.subject,
        body: bodyToParas(draft.body),
        thread_id: serverThreadId(threadId),
        job_id: draft.jobId,
        customer_id: draft.customerId,
        files: atts.map((a) => a.file).filter((f): f is File => Boolean(f)),
      };
      sendEmail.mutate(
        { ...basePayload, composing_since: draft.composingSince },
        {
          onError: (err) => {
            const conflict = asThreadChangedConflict(err);
            if (conflict) {
              setTrafficCop({
                payload: basePayload,
                optimisticId,
                kind: "compose",
                draft,
                messages: conflict.messages,
              });
              return;
            }
            flash(emailSendErrorMessage(err));
            setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
            queryClient.invalidateQueries({ queryKey: ["communication", "emails"] });
          },
        },
      );
    });

    flash(`Sending to ${to} in 10s`, {
      label: "Undo",
      onClick: () => {
        const restored = undoComposeSend.undo();
        if (!restored) return;
        setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
        setCompose(restored);
        setToast(null);
      },
    });
  }

  // Closing with content saves a draft (Gmail behavior); empty just closes.
  function closeCompose() {
    if (!compose) return;
    const hasContent =
      compose.to.trim() || compose.subject.trim() || compose.body.trim();
    if (hasContent) {
      const draft: Email = {
        id: `e_${Date.now()}`,
        threadId: compose.threadId ?? `t_${Date.now()}`,
        account: compose.account,
        from: { name: ownerName, email: "" },
        to: compose.to.trim() || "(no recipient)",
        subject: compose.subject.trim() || "(no subject)",
        snippet: compose.body.trim().replace(/\s+/g, " ").slice(0, 100) || "(draft)",
        body: bodyToParas(compose.body),
        at: nowLabel(),
        ts: nextTs(),
        unread: false,
        starred: false,
        folder: "drafts",
      };
      setEmails((prev) => [draft, ...prev]);
      flash("Draft saved");
    }
    setCompose(null);
  }

  // Traffic Cop (email slice 8b) - the three explicit outcomes the blocking
  // dialog offers once a send 409s THREAD_CHANGED. None of them silently
  // retries or silently drops the message: every path is a deliberate choice
  // the dialog's buttons make visible, and every path refetches the emails
  // query so the thread's real new message(s) show up regardless of which
  // one is picked.
  function trafficCopSendAnyway() {
    if (!trafficCop) return;
    const { payload, optimisticId } = trafficCop;
    setTrafficCop(null);
    // No composing_since on the retry - the guard has nothing to compare
    // against and does not fire (see sendEmail's own contract), which is
    // exactly what "send it anyway, I've seen the new messages" means here.
    sendEmail.mutate(payload, {
      onError: (err) => {
        flash(emailSendErrorMessage(err));
        setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
        queryClient.invalidateQueries({ queryKey: ["communication", "emails"] });
      },
    });
  }
  function trafficCopEdit() {
    if (!trafficCop) return;
    const { optimisticId, kind, draft } = trafficCop;
    setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
    queryClient.invalidateQueries({ queryKey: ["communication", "emails"] });
    if (kind === "reply") setReply(draft as ReplyDraft);
    else setCompose(draft as ComposeState);
    setTrafficCop(null);
  }
  function trafficCopDiscard() {
    if (!trafficCop) return;
    const { optimisticId } = trafficCop;
    setEmails((prev) => prev.filter((e) => e.id !== optimisticId));
    queryClient.invalidateQueries({ queryKey: ["communication", "emails"] });
    setTrafficCop(null);
    flash("Message discarded");
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <div className="border-b border-border bg-surface-light px-6 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-text-primary">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-on-fill">
                <Mail className="h-4 w-4" />
              </span>
              Inbox
            </h1>
          </div>
          <button
            type="button"
            onClick={startCompose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-primary/90"
          >
            <PenLine className="h-4 w-4" /> Compose
          </button>
        </div>
        <p className="mt-1 pb-3 text-[13px] text-text-secondary">
          Customer email, in the CRM alongside your calls and texts.
        </p>
      </div>

      {/* Three-pane: folders · list · reader */}
      <div className="flex min-h-0 flex-1">
        {/* Folder rail — collapsible to free up screen space */}
        {railOpen ? (
        <div className="flex w-52 flex-none flex-col overflow-y-auto border-r border-border bg-surface-light p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
              Menu
            </span>
            <button
              type="button"
              onClick={() => setRailOpen(false)}
              title="Collapse menu"
              aria-label="Collapse menu"
              className="rounded p-1 text-text-secondary transition hover:bg-background-light hover:text-text-primary"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <ul className="space-y-0.5">
            {FOLDERS.map((f) => {
              const active = folder === f.id;
              const count = countFor(f.id);
              return (
                <li key={f.id}>
                  <button
                    onClick={() => {
                      setFolder(f.id);
                      setOpenId(null);
                    }}
                    className={[
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition",
                      active
                        ? "bg-primary/10 font-semibold text-primary"
                        : "text-text-primary hover:bg-background-light",
                    ].join(" ")}
                  >
                    <f.icon
                      className={[
                        "h-4 w-4 flex-shrink-0",
                        active ? "text-primary" : "text-text-secondary",
                      ].join(" ")}
                    />
                    <span className="flex-1 text-left">{f.label}</span>
                    {count > 0 && (
                      <span
                        className={[
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                          active ? "bg-primary text-on-fill" : "bg-border text-text-secondary",
                        ].join(" ")}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Team directory — email a teammate directly. */}
          <div className="mt-5 px-1">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Team
              </p>
              <button
                type="button"
                onClick={() => setManageTab("members")}
                className="text-[11px] font-semibold text-primary hover:text-primary/80"
              >
                Directory
              </button>
            </div>
            <ul className="space-y-0.5">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => emailMember(m)}
                    title={`Email ${m.email}`}
                    className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition hover:bg-background-light"
                  >
                    <span
                      className={`relative flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10px] font-semibold ${tintFor(m.name)}`}
                    >
                      {getInitials(m.name)}
                      {m.online && (
                        <span className="absolute -bottom-px -right-px h-2 w-2 rounded-full bg-success-strong ring-2 ring-surface-light" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-text-primary">
                        {m.name}
                      </span>
                      <span className="block truncate text-[10px] text-text-secondary">{m.role}</span>
                    </span>
                    <Mail className="h-3.5 w-3.5 flex-none text-text-secondary opacity-0 transition group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Email groups — one click to message a whole team. */}
          <div className="mt-5 px-1">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Groups
              </p>
              <button
                type="button"
                onClick={() => setManageTab("groups")}
                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:text-primary/80"
              >
                <Settings2 className="h-3 w-3" /> Manage
              </button>
            </div>
            <ul className="space-y-0.5">
              {groups.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => emailGroup(g)}
                    title={`Email ${g.name}`}
                    className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition hover:bg-background-light"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Users className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">
                      {g.name}
                    </span>
                    <span className="flex-none rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                      {g.memberIds.length}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Forwarding — route incoming mail to the right person/team. */}
          <div className="mt-5 px-1">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                Forwarding
              </p>
              <button
                type="button"
                onClick={() => setManageTab("forwarding")}
                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-primary hover:text-primary/80"
              >
                <Settings2 className="h-3 w-3" /> Manage
              </button>
            </div>
            <ul className="space-y-1.5">
              {forwards.map((r) => {
                const target = r.toGroupId
                  ? groups.find((g) => g.id === r.toGroupId)?.name
                  : memberById(r.toMemberId ?? "")?.name;
                return (
                  <li key={r.id} className="flex items-center gap-2">
                    <Forward
                      className={`h-3.5 w-3.5 flex-none ${r.enabled ? "text-success-text" : "text-text-secondary"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-text-primary">
                        {r.from}
                      </span>
                      <span className="block truncate text-[10px] text-text-secondary">
                        → {target ?? "—"}
                      </span>
                    </span>
                    {!r.enabled && (
                      <span className="flex-none rounded bg-background-light px-1 py-0.5 text-[9px] font-semibold uppercase text-text-secondary">
                        off
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        ) : (
          <div className="flex w-11 flex-none flex-col items-center border-r border-border bg-surface-light py-3">
            <button
              type="button"
              onClick={() => setRailOpen(true)}
              title="Open menu"
              aria-label="Open menu"
              className="rounded-md p-1.5 text-text-secondary transition hover:bg-background-light hover:text-text-primary"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Email list */}
        <div
          className={[
            "flex min-w-0 flex-col border-r border-border bg-surface-light",
            open ? "hidden w-96 flex-none lg:flex" : "flex-1",
          ].join(" ")}
        >
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2 rounded-lg bg-background-light px-3 py-2">
              <Search className="h-4 w-4 text-text-secondary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search mail"
                className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
              />
            </div>
            {/* Unassigned / Mine / All (email slice 8b) - an ADDITIONAL
                filter, never a narrower visibility gate (Missive's rule).
                `Tabs` here has no `TabsContent` sibling on purpose - the panel
                below is one shared list whose data already reflects the active
                view via useEmails(assignmentView), the same no-TabsContent
                shape PriceBookPicker.tsx already uses for its own pill strip. */}
            <Tabs value={assignmentView} onValueChange={(v) => setAssignmentView(v as EmailAssignmentView)} className="mt-2">
              <TabsList variant="pill" className="gap-1 p-1">
                {ASSIGNMENT_VIEWS.map((v) => (
                  <TabsTrigger key={v.id} value={v.id} variant="pill" className="px-3 py-1.5">
                    {v.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!canRead ? (
              <p className="px-4 py-10 text-center text-[13px] text-text-secondary">
                You don't have access to the inbox.
              </p>
            ) : visible.length === 0 ? (
              <EmptyState title="Nothing here." className="px-4" />
            ) : (
              visible.map(({ email: e, count }) => {
                const isOpen = threadKey(e) === (open ? threadKey(open) : "");
                return (
                  <button
                    key={e.id}
                    onClick={() => openEmail(e.id)}
                    className={[
                      "flex w-full items-start gap-3 border-b border-border/60 px-3 py-3 text-left transition",
                      isOpen ? "bg-primary/5" : e.unread ? "bg-surface-light" : "bg-surface-light hover:bg-background-light",
                      !isOpen && "hover:bg-background-light",
                    ].join(" ")}
                  >
                    <span
                      className={`mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full text-[12px] font-semibold ${tintFor(senderLabel(e.from))}`}
                    >
                      {getInitials(senderLabel(e.from))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={[
                              "truncate text-[13px]",
                              e.unread ? "font-bold text-text-primary" : "font-medium text-text-primary",
                            ].join(" ")}
                          >
                            {folder === "sent" || folder === "drafts" ? `To: ${e.to}` : senderLabel(e.from)}
                          </span>
                          {count > 1 && (
                            <span className="flex-none text-[11px] font-semibold text-text-secondary">
                              {count}
                            </span>
                          )}
                        </span>
                        <span className="flex flex-none items-center gap-1.5">
                          {e.hasAttachment && <Paperclip className="h-3 w-3 text-text-secondary" />}
                          <span className="h-1.5 w-1.5 rounded-full bg-transparent" />
                          <span className={`text-[11px] ${e.unread ? "font-semibold text-primary" : "text-text-secondary"}`}>
                            {e.at}
                          </span>
                        </span>
                      </span>
                      <span
                        className={[
                          "mt-0.5 block truncate text-[13px]",
                          e.unread ? "font-semibold text-text-primary" : "text-text-secondary",
                        ].join(" ")}
                      >
                        {e.subject}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="truncate text-[12px] text-text-secondary">{e.snippet}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-1.5">
                        {e.labels?.map((l) => (
                          <span
                            key={l}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${LABEL_TONE[l] ?? "bg-background-light text-text-secondary ring-border"}`}
                          >
                            {l}
                          </span>
                        ))}
                        {/* Accepted deviation from the "badge or no-job on
                            every per-message surface" rule: dense LIST rows
                            stay tagged-only (no "no job" noise); the
                            unconditional badge lives on the reading pane's
                            per-message headers. */}
                        {e.jobLabel && <JobBadge job={e.jobLabel} />}
                      </span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggleStar(e.id);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          ev.stopPropagation();
                          toggleStar(e.id);
                        }
                      }}
                      className="mt-0.5 flex-none rounded p-0.5 hover:bg-border/60"
                      aria-label={e.starred ? "Unstar" : "Star"}
                    >
                      <Star
                        className={`h-4 w-4 ${e.starred ? "fill-warning-text text-warning-text" : "text-text-secondary"}`}
                      />
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Reading pane — only rendered when a message is open, so an empty
            inbox view shows the full-width list (no dead right column). */}
        {open && (
          <div className="hidden min-w-0 flex-1 flex-col bg-background-light lg:flex">
            <ReadingPane
              email={open}
              thread={openThread}
              reply={reply && reply.emailId === open.id ? reply : null}
              onReplyChange={setReply}
              onSendReply={sendReply}
              onDiscardReply={discardReply}
              onPopOutReply={popOutReply}
              onBack={() => {
                setOpenId(null);
                setReply(null);
              }}
              onStar={() => toggleStar(open.id)}
              onArchive={() => {
                setReply(null);
                archive(open.id);
              }}
              onReply={() => startReply(open)}
              onForward={() => startForward(open)}
              onUpdateEmail={updateEmail}
              onToast={flash}
              onTrash={() => {
                setEmails((prev) => prev.filter((e) => e.id !== open.id));
                setOpenId(null);
                setReply(null);
                flash("Moved to Trash");
              }}
              fromAddress={fromAddress}
              sendingEnabled={sendingEnabled}
              assignableUsers={assignableUsers}
              onAssign={assignOpenThread}
              assignPending={assignThread.isPending}
              onLink={linkOpenMessage}
              linkPending={linkInbound.isPending}
            />
          </div>
        )}
      </div>

      {/* Mobile/narrow reading overlay */}
      {open && (
        <div className="fixed inset-0 z-40 flex flex-col bg-surface-light lg:hidden">
          <ReadingPane
            email={open}
            thread={openThread}
            reply={reply && reply.emailId === open.id ? reply : null}
            onReplyChange={setReply}
            onSendReply={sendReply}
            onDiscardReply={discardReply}
            onPopOutReply={popOutReply}
            onBack={() => {
              setOpenId(null);
              setReply(null);
            }}
            onStar={() => toggleStar(open.id)}
            onArchive={() => {
              setReply(null);
              archive(open.id);
            }}
            onReply={() => startReply(open)}
            onForward={() => startForward(open)}
            onUpdateEmail={updateEmail}
            onToast={flash}
            onTrash={() => {
              setEmails((prev) => prev.filter((e) => e.id !== open.id));
              setOpenId(null);
              setReply(null);
              flash("Moved to Trash");
            }}
            fromAddress={fromAddress}
            sendingEnabled={sendingEnabled}
            assignableUsers={assignableUsers}
            onAssign={assignOpenThread}
            assignPending={assignThread.isPending}
            onLink={linkOpenMessage}
            linkPending={linkInbound.isPending}
          />
        </div>
      )}

      {/* Gmail-style compose window */}
      {compose && (
        <ComposeWindow
          state={compose}
          onChange={setCompose}
          onSend={sendCompose}
          onClose={closeCompose}
          onToast={flash}
          fromAddress={fromAddress}
          sendingEnabled={sendingEnabled}
          onDiscard={() => {
            setCompose(null);
            flash("Draft discarded");
          }}
        />
      )}

      {manageTab && (
        <ManageDirectoryModal
          initialTab={manageTab}
          members={members}
          groups={groups}
          setGroups={setGroups}
          forwards={forwards}
          setForwards={setForwards}
          onClose={() => setManageTab(null)}
          onEmailMember={(m) => {
            setManageTab(null);
            emailMember(m);
          }}
          onEmailGroup={(g) => {
            setManageTab(null);
            emailGroup(g);
          }}
          flash={flash}
        />
      )}

      {toast && (
        <div
          className={[
            "fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-text-primary px-4 py-2.5 text-sm font-medium text-on-fill shadow-lg",
            toast.action ? "pointer-events-auto" : "pointer-events-none",
          ].join(" ")}
        >
          {toast.message}
          {toast.action && (
            <Button
              type="button"
              variant="onDark"
              size={null}
              onClick={toast.action.onClick}
              className="px-1.5 py-0.5"
            >
              {toast.action.label}
            </Button>
          )}
        </div>
      )}

      {/* Traffic Cop (email slice 8b, Help Scout's pattern) - blocking, not a
          toast: the thread picked up a newer message while this reply/compose
          was being written, and every one of the three outcomes below is an
          explicit owner choice, never a silent retry or a silent drop. Built
          from the same Dialog/DialogContent/DialogHeader/DialogFooter
          primitives ConfirmDialog composes (components/ui/confirm-dialog.tsx)
          rather than a new dialog primitive - ConfirmDialog's own Cancel/
          Confirm footer has no third-action slot, so this call site is
          assembled directly instead of adding one nothing else needs. */}
      <Dialog open={trafficCop != null} onOpenChange={(o) => !o && trafficCopDiscard()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-surface">
                <AlertTriangle className="h-5 w-5 text-warning-text" />
              </div>
              <div>
                <DialogTitle>This conversation has new messages</DialogTitle>
                <DialogDescription>
                  {trafficCop?.messages.length === 1
                    ? "Someone replied while you were writing this."
                    : `${trafficCop?.messages.length ?? 0} new messages arrived while you were writing this.`}
                  {" "}Refresh before sending, or send your reply anyway.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {trafficCop && trafficCop.messages.length > 0 && (
            <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-border bg-background-light p-2">
              {trafficCop.messages.map((m) => (
                <div key={m.id} className="rounded-md bg-surface-light px-2.5 py-1.5 text-[13px]">
                  <span className="font-semibold text-text-primary">{senderLabel(m.from)}</span>{" "}
                  <span className="text-text-secondary">{m.snippet}</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" tone="danger" onClick={trafficCopDiscard}>
              Discard
            </Button>
            <Button type="button" variant="outline" tone="neutral" onClick={trafficCopEdit}>
              Edit
            </Button>
            <Button type="button" variant="solid" tone="danger" onClick={trafficCopSendAnyway}>
              Send anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReadingPane({
  email,
  thread,
  reply,
  onReplyChange,
  onSendReply,
  onDiscardReply,
  onPopOutReply,
  onBack,
  onStar,
  onArchive,
  onReply,
  onForward,
  onTrash,
  onToast,
  onUpdateEmail,
  fromAddress,
  sendingEnabled = true,
  assignableUsers,
  onAssign,
  assignPending,
  onLink,
  linkPending,
}: {
  email: Email;
  thread: Email[];
  reply: ReplyDraft | null;
  onReplyChange: (r: ReplyDraft) => void;
  onSendReply: () => void;
  onDiscardReply: () => void;
  onPopOutReply: () => void;
  onBack: () => void;
  onStar: () => void;
  onArchive: () => void;
  onReply: () => void;
  onForward: () => void;
  onTrash: () => void;
  onToast: (m: string) => void;
  onUpdateEmail: (id: string, patch: Partial<Email>) => void;
  /** The org sending identity, threaded down to the inline composer. UNSET
   *  today: nothing passes it since the Gmail connect was deleted, so the
   *  composer shows NO_MAILBOX_LABEL until the Resend slice supplies one. */
  fromAddress?: string;
  /** The org's `email_sending_enabled`, threaded down to the inline composer
   *  so a reply cannot be written into a mailbox that will refuse it. */
  sendingEnabled?: boolean;
  /** Email slice 8b - the org roster the Assign control offers. Same
   *  `useAssignableUsers()` roster the page-level state already fetched. */
  assignableUsers: AssignableUser[];
  /** Assign the OPEN conversation to a user, or clear it with `null`. */
  onAssign: (userId: string | null) => void;
  assignPending?: boolean;
  /** Email slice 6 - attach an unmatched message to the conversation its own
   *  reply token points at. Only ever called for a message the server already
   *  marked unmatched; the banner that offers it renders on nothing else. */
  onLink: () => void;
  linkPending?: boolean;
}) {
  // The chain renders oldest → newest. The latest message is always expanded;
  // older ones collapse to a one-line summary you can click to expand.
  const messages = thread.length ? thread : [email];
  const lastId = messages[messages.length - 1]!.id;
  // Email slice 8b - the open CONVERSATION's assignee (flattened onto every
  // message in the thread the same way threadArchived/threadSnoozedUntil
  // are). Looked up against the same assignable-users roster the Assign menu
  // itself offers - a deactivated assignee never appears here (auto-unassign
  // already reads back null server-side, see effectiveThreadAssigneeId).
  const assignedUser = email.threadAssignedToUserId
    ? (assignableUsers.find((u) => u.id === email.threadAssignedToUserId) ?? null)
    : null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const isExpanded = (m: Email) => m.id === lastId || expanded.has(m.id);
  function toggleMessage(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Gmail-style actions (snooze / mark-unread / important / mute / spam).
  const SNOOZE_OPTIONS = ["Later today", "Tomorrow", "This weekend", "Next week"];
  function markUnread() {
    onUpdateEmail(email.id, { unread: true });
    onToast("Marked as unread");
    onBack();
  }
  function snoozeEmail(when: string) {
    onUpdateEmail(email.id, { snoozedUntil: when });
    onToast(`Snoozed — ${when}`);
    onBack();
  }
  function toggleImportant() {
    onUpdateEmail(email.id, { important: !email.important });
    onToast(email.important ? "Removed importance" : "Marked as important");
  }
  function reportSpam() {
    onUpdateEmail(email.id, { folder: "archive" });
    onToast("Reported spam & removed from inbox");
    onBack();
  }
  function muteThread() {
    onUpdateEmail(email.id, { folder: "archive" });
    onToast("Muted — moved out of inbox");
    onBack();
  }

  const menuItemCls = "gap-2.5 px-3 py-2 text-[13px]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Action bar */}
      <div className="flex items-center gap-1 border-b border-border bg-surface-light px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="mr-1 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-background-light lg:hidden"
          aria-label="Back"
        >
          <ArrowLeft className="h-[18px] w-[18px]" />
        </button>
        <IconBtn label="Archive" onClick={onArchive}>
          <Archive className="h-4 w-4" />
        </IconBtn>
        <IconBtn label="Report spam" onClick={reportSpam}>
          <ShieldAlert className="h-4 w-4" />
        </IconBtn>
        <IconBtn label="Delete" onClick={onTrash}>
          <Trash2 className="h-4 w-4" />
        </IconBtn>
        <span className="mx-1 h-5 w-px bg-border" />
        <IconBtn label="Mark as unread" onClick={markUnread}>
          <MailOpen className="h-4 w-4" />
        </IconBtn>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconBtn label="Snooze">
              <Clock className="h-4 w-4" />
            </IconBtn>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48 py-1">
            <DropdownMenuLabel className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide">
              Snooze until
            </DropdownMenuLabel>
            {SNOOZE_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={o}
                onClick={() => snoozeEmail(o)}
                tone="strong"
                className="px-3 py-1.5 text-[13px]"
              >
                {o}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconBtn label="Add to tasks" onClick={() => onToast("✓ Added to tasks")}>
          <ListChecks className="h-4 w-4" />
        </IconBtn>
        {/* Assign (email slice 8b) - conversation-level, never a per-message
            control. Absent entirely on a row with no real thread (a system/
            transactional row - see Email.threadId's own doc): there is no
            EmailThread id to PATCH, so there is nothing to assign. */}
        {email.threadId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="3xs"
                disabled={assignPending}
                className="gap-1.5"
              >
                <UserCircle2 className="h-3.5 w-3.5" />
                {assignedUser ? `${assignedUser.first_name} ${assignedUser.last_name}` : "Unassigned"}
              </Button>
            </DropdownMenuTrigger>
            {/* No className overrides below - DropdownMenuLabel/Item's own
                defaults (px-2 py-1.5 text-sm[ font-semibold]) already read
                fine here; the layering guard's soft-classname ratchet has no
                slack left to add another site's worth of type size and
                weight overrides on top of the ones this same menu family
                already carries elsewhere in this file. */}
            <DropdownMenuContent align="start" className="w-56 py-1">
              <DropdownMenuLabel>Assign conversation</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onAssign(null)} tone="strong">
                Unassigned
              </DropdownMenuItem>
              {assignableUsers.map((u) => (
                <DropdownMenuItem key={u.id} onClick={() => onAssign(u.id)} tone="strong">
                  {u.first_name} {u.last_name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconBtn label="Reply" onClick={onReply}>
            <CornerUpLeft className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Forward" onClick={onForward}>
            <CornerUpRight className="h-4 w-4" />
          </IconBtn>
          <span className="mx-1 h-5 w-px bg-border" />
          <IconBtn label={email.starred ? "Unstar" : "Star"} onClick={onStar}>
            <Star className={`h-4 w-4 ${email.starred ? "fill-warning-text text-warning-text" : ""}`} />
          </IconBtn>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconBtn label="More">
                <MoreVertical className="h-4 w-4" />
              </IconBtn>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 py-1">
              <DropdownMenuItem onClick={markUnread} tone="strong" className={menuItemCls}>
                <MailOpen className="h-4 w-4 text-text-secondary" /> Mark as unread
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleImportant} tone="strong" className={menuItemCls}>
                <Bookmark
                  className={`h-4 w-4 ${email.important ? "fill-warning-text text-warning-text" : "text-text-secondary"}`}
                />
                {email.important ? "Mark as not important" : "Mark as important"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onStar} tone="strong" className={menuItemCls}>
                <Star
                  className={`h-4 w-4 ${email.starred ? "fill-warning-text text-warning-text" : "text-text-secondary"}`}
                />
                {email.starred ? "Remove star" : "Add star"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onToast("📅 Event created from this email")}
                tone="strong" className={menuItemCls}
              >
                <Calendar className="h-4 w-4 text-text-secondary" /> Create event
              </DropdownMenuItem>
              <DropdownMenuItem onClick={muteThread} tone="strong" className={menuItemCls}>
                <BellOff className="h-4 w-4 text-text-secondary" /> Mute
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-light px-6 py-5">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-text-primary">{email.subject}</h2>
          <span className="flex flex-none items-center gap-1.5">
            {email.labels?.map((l) => (
              <span
                key={l}
                className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${LABEL_TONE[l] ?? "bg-background-light text-text-secondary ring-border"}`}
              >
                {l}
              </span>
            ))}
            {email.jobLabel && <JobBadge job={email.jobLabel} className="flex-none" />}
          </span>
        </div>
        {messages.length > 1 && (
          <p className="mb-2 mt-1 text-[12px] font-medium text-text-secondary">
            {messages.length} messages in this conversation
          </p>
        )}

        {/* Email slice 6 - why this message is being held back, and the one
            action that resolves it. States the REASON rather than just the
            outcome: "we could not confirm the sender" is what an operator needs
            in order to judge, and linking is an explicit decision to trust a
            sender the automatic check would not. */}
        {email.inboundMatch && email.inboundMatch !== "MATCHED" && (
          <div className="mb-3 mt-2 rounded-lg border border-warning-border bg-warning-surface px-3.5 py-3">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-warning-text" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-warning-text">
                  Held back - we could not confirm this sender
                </p>
                <p className="mt-0.5 text-[12px] text-warning-text/90">
                  {email.inboundAuth === "FAIL"
                    ? `This reply came to the right address, but DMARC says ${email.from.email} was forged. It has not been added to the conversation.`
                    : `This reply came to the right address, but it was sent from ${email.from.email}, which is not the address we wrote to. It has not been added to the conversation.`}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onLink}
                  disabled={linkPending}
                  className="mt-2.5"
                >
                  {linkPending ? "Adding..." : "Add to the conversation anyway"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Conversation chain — oldest → newest */}
        <div className="mt-2 space-y-2.5">
          {messages.map((m) => {
            const showFull = isExpanded(m);
            const who = senderLabel(m.from);
            const fromYou = m.folder === "sent" || m.folder === "drafts";
            return (
              <div
                key={m.id}
                className="overflow-hidden rounded-lg border border-border"
              >
                <button
                  type="button"
                  onClick={() => m.id !== lastId && toggleMessage(m.id)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left ${m.id === lastId ? "cursor-default" : "hover:bg-background-light"}`}
                >
                  <span
                    className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-[12px] font-semibold ${tintFor(who)}`}
                  >
                    {getInitials(who)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {fromYou ? "You" : who}
                      </span>
                      {/* The address, only when it is not already the name -
                          a nameless sender falls back to it, and printing
                          `info@servwave.com <info@servwave.com>` reads as noise. */}
                      {showFull && m.from.name?.trim() && (
                        <span className="truncate text-[12px] font-normal text-text-secondary">
                          &lt;{m.from.email}&gt;
                        </span>
                      )}
                    </span>
                    {showFull ? (
                      // No "via <account>" here: exactly one sending identity
                      // exists, so the badge distinguished nothing on any row,
                      // and the constant it read from still named the retired
                      // `no-reply@servwave.app` rather than the org's real
                      // sender. Restore it only alongside real multi-mailbox.
                      <span className="block text-[12px] text-text-secondary">
                        to {m.to}
                      </span>
                    ) : (
                      <span className="block truncate text-[12px] text-text-secondary">
                        {m.snippet}
                      </span>
                    )}
                  </span>
                  {/* Per-message job badge — every message in the reading
                      pane is badged ("badge it, don't hide it"): ocean job
                      number when tagged, muted "no job" when unattributed. */}
                  <JobBadge job={m.jobLabel} className="flex-none" />
                  {/* Delivery fact (slice 5) — sent messages only. Delivered/
                      Bounced/Failed render as fact; "Sent" reads as awaiting
                      confirmation; never an "Opened" claim (Apple Mail Privacy
                      Protection prefetches images for ~half of recipients). */}
                  {fromYou && (
                    <EmailDeliveryPill
                      status={m.deliveryStatus}
                      reason={m.deliveryStatusReason}
                      className="flex-none"
                    />
                  )}
                  {/* Sender fact (slice 6) — received messages only, and the
                      mirror image of the delivery pill above. A reply address
                      is a bearer token, so "the address matches" and "DMARC
                      proved the domain" are different claims and are badged
                      differently; only PASS reads as verified. */}
                  {!fromYou && (
                    <InboundSenderPill
                      verdict={m.inboundAuth}
                      match={m.inboundMatch}
                      className="flex-none"
                    />
                  )}
                  <span className="flex-none text-[12px] text-text-secondary">{m.at}</span>
                </button>

                {showFull && (
                  <div className="border-t border-border px-4 py-3.5">
                    {/* Slice 9 (render hardening): an HTML body now only ever
                        reaches the DOM inside a sandboxed iframe (see
                        EmailBodyFrame + emailBodyFrame.ts for the sandbox
                        value and why), never as a live dangerouslySetInnerHTML
                        node in this tree - the server's sanitizeEmailHtml is
                        defense layer 1, that sandbox is layer 2. Quoted
                        history on an inbound message is hidden by default
                        behind a "Show trimmed content" toggle. */}
                    <EmailMessageBody
                      bodyHtml={m.bodyHtml}
                      body={Array.isArray(m.body) ? m.body : [String(m.body ?? "")]}
                      direction={m.direction}
                    />
                    {(m.attachments?.length || m.hasAttachment) && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {(m.attachments ?? [{ name: "invoice.pdf", size: "84 KB" }]).map(
                          (a, ai) => (
                            // Name + size only. There is no attachment store to
                            // stream bytes from, so nothing here is clickable.
                            <span
                              key={`${a.name}-${ai}`}
                              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background-light px-3 py-2 text-[13px] text-text-secondary"
                            >
                              <Paperclip className="h-4 w-4 text-text-secondary" />
                              {a.name}
                              <span className="text-text-secondary">· {a.size}</span>
                            </span>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Inline reply (Gmail) — buttons when idle, composer when active */}
        {reply ? (
          <InlineComposer
            reply={reply}
            original={email}
            onChange={onReplyChange}
            onSend={onSendReply}
            onDiscard={onDiscardReply}
            onPopOut={onPopOutReply}
            onToast={onToast}
            fromAddress={fromAddress}
            sendingEnabled={sendingEnabled}
          />
        ) : (
          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={onReply}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-light px-4 py-2 text-[13px] font-semibold text-text-primary hover:bg-background-light"
            >
              <CornerUpLeft className="h-4 w-4" /> Reply
            </button>
            <button
              type="button"
              onClick={onForward}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-light px-4 py-2 text-[13px] font-semibold text-text-primary hover:bg-background-light"
            >
              <CornerUpRight className="h-4 w-4" /> Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
