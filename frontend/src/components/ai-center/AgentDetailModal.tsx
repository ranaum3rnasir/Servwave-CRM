import { Play, Check } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { cn } from '@/lib/utils';
import type { AIAgent } from '@/lib/ai-center/agents';
import { comingSoonPillCls } from './comingSoonPill';

interface AgentDetailModalProps {
  agent: AIAgent | null;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

/** Modal-on-modal: the agent's tagline, feature video, and 7-bullet story. */
export function AgentDetailModal({ agent, onOpenChange, onBook }: AgentDetailModalProps) {
  return (
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

            {/* Header */}
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
                  <Heading level={2} scale="xl" weight="bold">{agent.name}</Heading>
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
                  <span className="text-xs font-medium text-on-fill/70">Feature video · 90 sec</span>
                </div>
              </div>

              <p className="mb-4 text-base font-bold italic text-ai-600">{agent.tagline}</p>

              <ul className="space-y-3">
                {agent.longDescription.map((line, i) => (
                  <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-text-secondary">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-ai-600" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Footer CTA */}
            <div className="border-t border-border bg-surface-light p-4">
              <Button variant="solid" tone="ai" className="w-full" onClick={() => onBook(agent)}>
                Book a call about {agent.name}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
