// Communication module — WhatsApp Business two-pane inbox.
//
// Ported verbatim from Emanuel's prototype `WhatsAppPage` component (entire
// file, 441 lines). Behaviour and the WhatsApp look-and-feel are preserved
// exactly; only three mechanical adaptations were made:
//   1. Tailwind tokens: indigo/slate chrome -> ALPHA design tokens
//      (text-text-primary / text-text-secondary / border-border /
//      bg-background-light, dark toast -> bg-text-primary). The WhatsApp brand
//      greens now come from the shared channel tokens (bg-whatsapp /
//      bg-whatsapp-dark / bg-whatsapp-bubble / bg-whatsapp-canvas) and the
//      emerald/sky status tints resolve through the semantic success/info
//      token families.
//   2. Seed conversations + the WA types now come from the
//      `@/lib/api/communication` seam (lifted into the mock layer), read via
//      the `useWhatsAppChats()` hook. Outbound sends hit the real
//      `useSendWhatsApp()` mutation: a real org's send is refused with a 409
//      and rolled back client-side, while only the demo org persists a row.
//      There is no simulated delivery or read progression.
//   3. The inline WhatsApp brand <svg> glyph is kept exactly as authored.
import { useMemo, useRef, useState, useEffect } from "react";
import {
  Check,
  CheckCheck,
  Paperclip,
  Phone,
  Search,
  Send,
  Smile,
} from "lucide-react";
import { JobBadge } from "@/components/communication/shared/atoms";
import {
  useWhatsAppChats,
  useSendWhatsApp,
  whatsAppSendErrorMessage,
} from "@/lib/api/communication";
import type { WAChat, WAMessage, WAStatus } from "@/lib/api/communication";
import { formatPhone, getInitials } from "@/lib/utils";

// The real WhatsApp brand glyph (phone-in-speech-bubble), so the header matches
// the actual app instead of a generic chat bubble.
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}


// A stable, pleasant avatar tint per chat so the list reads quickly.
const AVATAR_TINTS = [
  "bg-success-surface text-success-text",
  "bg-info-surface text-info-text",
  "bg-info-surface text-info-text",
  "bg-warning-surface text-warning-text",
  "bg-danger-surface text-danger-text",
];
function tintFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length] ?? AVATAR_TINTS[0]!;
}

function StatusTicks({ status }: { status?: WAStatus }) {
  if (!status) return null;
  if (status === "read")
    return <CheckCheck className="h-3.5 w-3.5 text-info-text" />;
  if (status === "delivered")
    return <CheckCheck className="h-3.5 w-3.5 text-text-secondary" />;
  return <Check className="h-3.5 w-3.5 text-text-secondary" />;
}

export default function WhatsAppPage() {
  const { data: seedChats = [] } = useWhatsAppChats();
  const sendWhatsApp = useSendWhatsApp();

  const [chats, setChats] = useState<WAChat[]>(seedChats);
  const [activeId, setActiveId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Once the seam delivers the seed conversations, hydrate local state. Local
  // state then owns the optimistic send / unread / tick mutations; we only
  // adopt the seed the first time it arrives (guarded by an empty local list).
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || seedChats.length === 0) return;
    hydrated.current = true;
    setChats(seedChats);
    setActiveId((prev) => prev || (seedChats[0]?.id ?? ""));
  }, [seedChats]);

  const active = chats.find((c) => c.id === activeId) ?? chats[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.org.toLowerCase().includes(q) ||
        c.phone.includes(q),
    );
  }, [chats, query]);

  // Auto-scroll the thread to the newest message when the chat or its message
  // count changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, active?.messages.length]);

  function openChat(id: string) {
    setActiveId(id);
    // Opening a chat clears its unread badge.
    setChats((prev) =>
      prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)),
    );
  }

  function send() {
    const text = draft.trim();
    if (!text || !active) return;
    const prevLastAt = active.lastAt;
    const now = new Date();
    const at = now.toLocaleTimeString('en-US', { hour: "numeric", minute: "2-digit" });
    const msg: WAMessage = {
      id: `m_${Date.now()}`,
      from: "us",
      text,
      at,
      status: "sent",
    };
    setChats((prev) =>
      prev.map((c) =>
        c.id === active.id
          ? { ...c, messages: [...c.messages, msg], lastAt: at }
          : c,
      ),
    );
    setSendError(null);
    setDraft("");
    sendWhatsApp.mutate(
      { chat_id: active.id, text },
      {
        onError: (err) => {
          setChats((prev) =>
            prev.map((c) =>
              c.id !== active.id
                ? c
                : { ...c, messages: c.messages.filter((m) => m.id !== msg.id), lastAt: prevLastAt },
            ),
          );
          setDraft(text);
          setSendError(whatsAppSendErrorMessage(err));
        },
      },
    );
  }

  const totalUnread = chats.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header — mirrors the Phone module chrome so the Communication hub
          feels like one product. */}
      <div className="border-b border-border bg-surface-light px-6 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-text-primary">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-whatsapp text-on-fill">
                <WhatsAppIcon className="h-4 w-4" />
              </span>
              WhatsApp
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-background-light px-2.5 py-1 text-[12px] font-semibold text-text-secondary ring-1 ring-border">
              <span className="h-1.5 w-1.5 rounded-full bg-text-secondary" />
              Not connected
            </span>
          </div>
          {totalUnread > 0 && (
            <span className="rounded-full bg-whatsapp px-2.5 py-1 text-[12px] font-semibold text-on-fill">
              {totalUnread} unread
            </span>
          )}
        </div>
        <p className="mt-1 pb-3 text-[13px] text-text-secondary">
          WhatsApp Business is not connected, so nothing typed here reaches the
          customer. Use Text or Email until the WhatsApp Business integration
          ships.
        </p>
      </div>

      {/* Two-pane inbox */}
      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <div className="flex w-80 flex-none flex-col border-r border-border bg-surface-light">
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2 rounded-lg bg-background-light px-3 py-2">
              <Search className="h-4 w-4 text-text-secondary" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                className="w-full bg-transparent text-sm text-text-secondary outline-none placeholder:text-text-secondary"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-text-secondary">
                No chats match "{query}".
              </p>
            ) : (
              filtered.map((c) => {
                const last = c.messages[c.messages.length - 1];
                const isActive = c.id === active?.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => openChat(c.id)}
                    className={[
                      "flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left transition",
                      isActive ? "bg-success-surface/60" : "hover:bg-background-light",
                    ].join(" ")}
                  >
                    <span
                      className={`flex h-11 w-11 flex-none items-center justify-center rounded-full text-sm font-semibold ${tintFor(c.id)}`}
                    >
                      {getInitials(c.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-text-primary">
                          {c.name}
                        </span>
                        <span
                          className={`flex-none text-[11px] ${c.unread > 0 ? "font-semibold text-success-text" : "text-text-secondary"}`}
                        >
                          {c.lastAt}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] text-text-secondary">
                          {last
                            ? `${last.from === "us" ? "You: " : ""}${last.text}`
                            : c.org}
                        </span>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-[20px] flex-none items-center justify-center rounded-full bg-whatsapp px-1.5 text-[11px] font-bold text-on-fill">
                            {c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Chat thread */}
        <div className="flex min-w-0 flex-1 flex-col bg-whatsapp-canvas">
          {/* Thread header */}
          <div className="flex items-center gap-3 border-b border-border bg-surface-light px-5 py-2.5">
            <span
              className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${tintFor(active?.id ?? "")}`}
            >
              {getInitials(active?.name ?? "")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-primary">
                {active?.name}
              </p>
              <p className="truncate text-[12px] text-text-secondary">
                {active?.org} · {formatPhone(active?.phone)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (!active) return;
                setToast(`📞 Calling ${active.name}…`);
                setTimeout(() => setToast(null), 2600);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full text-text-secondary hover:bg-background-light"
              aria-label={`Call ${active?.name ?? ""}`}
            >
              <Phone className="h-[18px] w-[18px]" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
            {active?.messages.map((m) => {
              const mine = m.from === "us";
              return (
                <div
                  key={m.id}
                  className={`flex ${mine ? "justify-end" : "justify-start"}`}
                >
                  <div className="max-w-[72%]">
                    <div
                      className={[
                        "rounded-lg px-3 py-2 shadow-sm",
                        mine
                          ? "rounded-tr-none bg-whatsapp-bubble text-text-primary"
                          : "rounded-tl-none bg-surface-light text-text-primary",
                      ].join(" ")}
                    >
                      <p className="text-[13.5px] leading-relaxed">{m.text}</p>
                      <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-text-secondary">
                        {m.at}
                        {mine && <StatusTicks status={m.status} />}
                      </p>
                    </div>
                    {/* Variant A job pill — every customer-chat bubble is
                        badged ("badge it, don't hide it"): ocean job number
                        when tagged, muted "no job" when unattributed. */}
                    <div className={`mt-1 flex ${mine ? "justify-end" : "justify-start"}`}>
                      <JobBadge job={m.jobLabel} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {sendError && (
            <p role="status" className="border-t border-danger/20 bg-danger/10 px-4 py-1.5 text-[11px] font-medium text-danger">
              {sendError}
            </p>
          )}
          {/* Composer */}
          <div className="flex items-center gap-2 border-t border-border bg-surface-light px-4 py-3">
            <button
              type="button"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-text-secondary hover:bg-background-light"
              aria-label="Emoji"
            >
              <Smile className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-text-secondary hover:bg-background-light"
              aria-label="Attach"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message"
              className="h-10 flex-1 rounded-full bg-background-light px-4 text-sm text-text-secondary outline-none placeholder:text-text-secondary focus:ring-2 focus:ring-success-border"
            />
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim()}
              className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-whatsapp text-on-fill transition hover:bg-whatsapp-dark disabled:opacity-40"
              aria-label="Send"
            >
              <Send className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-text-primary px-4 py-2.5 text-sm font-medium text-on-fill shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
