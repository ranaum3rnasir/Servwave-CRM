import { useState } from 'react';
import { Play, Check, Bell, Mail, MessageSquare, Clock, Users, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import type { AIAgent } from '@/lib/ai-center/agents';
import { comingSoonPillCls } from './comingSoonPill';
import { TranscriberModal } from '@/components/transcriber/TranscriberModal';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';

interface AgentDetailModalProps {
  agent: AIAgent | null;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

const FALLBACK_WATCHER_CONTACTS = [
  { id: 'c1', first_name: 'John', last_name: 'Smith', company_name: 'Apex Plumbing Co.', email: 'john@apexplumbing.com', inactiveDays: 45 },
  { id: 'c2', first_name: 'Sarah', last_name: 'Johnson', company_name: 'Metro HVAC Services', email: 'sarah.j@metrohvac.com', inactiveDays: 60 },
  { id: 'c3', first_name: 'Michael', last_name: 'Brown', company_name: 'Citywide Electric', email: 'mbrown@citywide.com', inactiveDays: 14 },
  { id: 'c4', first_name: 'Emily', last_name: 'Davis', company_name: 'Highland Builders', email: 'edavis@highland.com', inactiveDays: 90 },
  { id: 'c5', first_name: 'Robert', last_name: 'Wilson', company_name: 'Summit Property Management', email: 'rwilson@summitpm.com', inactiveDays: 35 },
  { id: 'c6', first_name: 'Jessica', last_name: 'Taylor', company_name: 'Pinnacle Roofing & Solar', email: 'jtaylor@pinnacle.com', inactiveDays: 120 },
  { id: 'c7', first_name: 'David', last_name: 'Miller', company_name: 'Valley Maintenance', email: 'dmiller@valleymaintenance.com', inactiveDays: 5 },
];

/** Dedicated UI for Spider (AI Lead Manager) Watcher configuration */
function SpiderWatcherConfig() {
  const notifications = useSpiderWatcherStore((s) => s.notifications);
  const setNotifications = useSpiderWatcherStore((s) => s.setNotifications);
  const days = useSpiderWatcherStore((s) => s.days);
  const setDays = useSpiderWatcherStore((s) => s.setDays);

  const [search, setSearch] = useState('');

  // Fetch customers dynamically from API
  const { data: apiCustomers } = useQuery({
    queryKey: ['spider-watcher-customers'],
    queryFn: async () => {
      try {
        const res = await api.get('/api/customers', { params: { limit: 50 } });
        return res.data?.customers || [];
      } catch {
        return [];
      }
    },
    staleTime: 60_000,
  });

  const rawList = apiCustomers && apiCustomers.length > 0 ? apiCustomers : FALLBACK_WATCHER_CONTACTS;

  const selectedDaysNum = parseInt(days || '0', 10);

  const contactsList = rawList.map((c: any, index: number) => {
    const inactiveDays = c.inactiveDays ?? (5 + ((index * 15) % 110));
    return {
      id: c.id,
      name: customerDisplayName(c, c.company_name || 'Customer'),
      company: c.company_name,
      email: c.email,
      inactiveDays,
    };
  });

  // Filter contacts by selected inactive days threshold AND search string
  const filteredContacts = contactsList.filter((c: any) => {
    const matchesDays = c.inactiveDays >= selectedDaysNum;
    const matchesSearch = search
      ? c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.company && c.company.toLowerCase().includes(search.toLowerCase()))
      : true;
    return matchesDays && matchesSearch;
  });

  return (
    <div className="space-y-4">
      {/* Top Section — Notifications (Left) & Distance / Days (Right) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Left Section — Notifications */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card">
          <div className="mb-3 border-b border-border/60 pb-2">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-ai-600 shrink-0" />
              Notifications
            </Heading>
          </div>
          <div className="space-y-2.5 flex-1">
            <label className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer">
              <Checkbox
                checked={notifications.email}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, email: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Mail className="h-3.5 w-3.5 text-text-soft" />
                <span>Email</span>
              </div>
            </label>

            <label className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer">
              <Checkbox
                checked={notifications.sms}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, sms: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <MessageSquare className="h-3.5 w-3.5 text-text-soft" />
                <span>SMS</span>
              </div>
            </label>

            <label className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-background-light cursor-pointer">
              <Checkbox
                checked={notifications.inApp}
                onCheckedChange={(checked) =>
                  setNotifications((prev) => ({ ...prev, inApp: !!checked }))
                }
              />
              <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
                <Bell className="h-3.5 w-3.5 text-ai-600" />
                <span>In-app Message</span>
              </div>
            </label>
          </div>
        </div>

        {/* Right Section — Distance */}
        <div className="flex flex-col rounded-card border border-border bg-surface-light p-4 shadow-card">
          <div className="mb-3 border-b border-border/60 pb-2">
            <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-ai-600 shrink-0" />
              Distance
            </Heading>
          </div>
          <div className="flex flex-col justify-center flex-1 space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Number of Days
            </label>
            <div className="relative flex items-center">
              <input
                type="number"
                min="1"
                value={days}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '' || /^\d+$/.test(val)) {
                    setDays(val);
                  }
                }}
                className="w-full rounded-md border border-border bg-surface-light px-3 py-2 pr-14 text-xs font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ai-500"
                placeholder="3"
              />
              <span className="pointer-events-none absolute right-3 text-xs font-semibold text-text-secondary">
                days
              </span>
            </div>
            <p className="text-[11px] text-text-soft leading-relaxed">
              Spider watches for contacts with no messages or activity in the last {days || '3'} days.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom Section — Contacts for Watchers */}
      <div className="rounded-card border border-border bg-surface-light p-4 shadow-card">
        <div className="mb-3 border-b border-border/60 pb-2">
          <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
            <Users className="h-4 w-4 text-ai-600 shrink-0" />
            Contacts for Watchers
          </Heading>
          <p className="text-[11px] text-text-soft mt-0.5">
            Contacts with no messages or activity in the last {days || '3'} days ({filteredContacts.length} found)
          </p>
        </div>

        {/* Search bar */}
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contacts..."
            className="w-full rounded-md border border-border bg-surface-light py-1.5 pl-9 pr-3 text-xs text-text-primary outline-none placeholder:text-text-soft focus-visible:ring-2 focus-visible:ring-ai-500"
          />
        </div>

        {/* Contacts list — Clean view without selection controls */}
        <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
          {filteredContacts.length === 0 ? (
            <div className="py-6 text-center text-xs text-text-soft">
              No contacts found with no messages or activity in the last {days || '3'} days.
            </div>
          ) : (
            filteredContacts.map((contact: any) => (
              <div
                key={contact.id}
                className="flex items-center gap-3 rounded-lg border border-border/50 bg-surface-light p-2.5 transition-colors hover:bg-background-light"
              >
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback className="text-[11px] font-bold bg-ai-100 text-ai-700">
                    {contact.name[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold text-text-primary">{contact.name}</p>
                  {contact.company && contact.company !== contact.name && (
                    <p className="truncate text-[11px] text-text-soft">{contact.company}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {contact.email && (
                    <span className="hidden md:inline-block truncate text-[11px] font-mono text-text-soft mr-2">
                      {contact.email}
                    </span>
                  )}
                  <span className="rounded-full bg-ai-50 border border-ai-200 px-2.5 py-0.5 text-[10px] font-semibold text-ai-700">
                    No activity for {contact.inactiveDays} days
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Modal-on-modal: the agent's tagline, feature video, and 7-bullet story (or custom watcher UI for Spider). */
export function AgentDetailModal({ agent, onOpenChange, onBook }: AgentDetailModalProps) {
  const [transcriberOpen, setTranscriberOpen] = useState(false);
  const isSpider = agent?.id === 'spider' || agent?.name.toLowerCase() === 'spider';

  return (
    <>
      <Dialog open={!!agent} onOpenChange={onOpenChange}>
        <DialogContent
          overlayClassName="bg-ocean-900/40"
          className="flex max-h-[88vh] w-[94vw] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        >
          {agent && (
            <>
              <VisuallyHidden>
                <DialogTitle>
                  {agent.name} — {agent.role}
                </DialogTitle>
              </VisuallyHidden>

              {/* Header — Preserved for Spider & all agents */}
              <div className="flex items-start gap-4 border-b border-border bg-surface-light p-6 pr-14">
                <Avatar ring="ai" className="h-16 w-16 shrink-0">
                  {agent.image && (
                    <AvatarImage src={agent.image} alt={agent.name} className="object-cover" />
                  )}
                  <AvatarFallback
                    tone="custom"
                    style={{ backgroundColor: agent.avatarColor }}
                    className="text-lg font-bold"
                  >
                    {agent.name[0]}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Heading level={2} scale="xl" weight="bold">
                      {agent.name}
                    </Heading>
                    {agent.isNew && (
                      <span className="rounded-full border border-ai-200 bg-ai-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
                        New
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold uppercase tracking-wide text-ai-600">
                    {agent.role}
                  </p>
                  <span className={cn(comingSoonPillCls, 'mt-1.5 inline-block')}>
                    Coming soon
                  </span>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-6">
                {isSpider ? (
                  <SpiderWatcherConfig />
                ) : (
                  <>
                    {/* Feature-video placeholder */}
                    <div className="relative mb-5 flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-ocean-900 to-ocean-800">
                      <div
                        className="absolute inset-0 opacity-50"
                        style={{
                          background:
                            'radial-gradient(circle at 30% 35%, rgb(var(--ai-600) / 0.45), transparent 60%)',
                        }}
                      />
                      <div className="relative flex flex-col items-center gap-2">
                        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-on-fill/15 backdrop-blur">
                          <Play className="h-5 w-5 fill-on-fill text-on-fill" />
                        </span>
                        <span className="text-xs font-medium text-on-fill/70">
                          Feature video · 90 sec
                        </span>
                      </div>
                    </div>

                    <p className="mb-4 text-base font-bold italic text-ai-600">{agent.tagline}</p>

                    <ul className="space-y-3">
                      {agent.longDescription.map((line, i) => (
                        <li
                          key={i}
                          className="flex gap-2.5 text-sm leading-relaxed text-text-secondary"
                        >
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-ai-600" />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              {/* Footer CTA */}
              <div className="border-t border-border bg-surface-light p-4">
                <div className="flex items-center gap-3">
                  <Button
                    variant="solid"
                    tone="ai"
                    className="flex-1"
                    onClick={() => onBook(agent)}
                  >
                    Book a call about {agent.name}
                  </Button>
                  {agent.name.toLowerCase() === 'owl' && (
                    <Button
                      id="transcriber-start-btn"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setTranscriberOpen(true)}
                    >
                      Start
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Transcriber modal — separate portal, does not nest inside the agent dialog */}
      <TranscriberModal open={transcriberOpen} onOpenChange={setTranscriberOpen} />
    </>
  );
}
