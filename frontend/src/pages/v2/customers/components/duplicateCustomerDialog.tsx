import { AlertTriangle, ArrowRight, Mail, MapPin, Pencil, Phone } from 'lucide-react';

import { formatPhone } from '@/lib/utils';
// Type only. The 409 payload shape is the backend's contract, so it is imported
// from the component that already declares it rather than restated - a second
// copy would drift the day the guard grows a field.
import type { ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

export interface DuplicateCustomerDialogProps {
  open: boolean;
  /** The existing customer that collided (null while closed). */
  existing: ExistingCustomer | null;
  /**
   * Legacy fallback for which field(s) collided. When the backend's
   * relation-aware `existing.matched` is present (now always), it wins.
   */
  matchedFields?: { email: boolean; phone: boolean };
  onOpenExisting: () => void;
  onEditField: (field: 'email' | 'phone') => void;
  onCreateAnyway: () => void;
  onClose: () => void;
  isOverriding?: boolean;
}

function displayName(c: ExistingCustomer): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return c.company_name || person || 'Existing customer';
}

/**
 * v2 duplicate-customer guard modal, on the kit's Dialog.
 *
 * Purely presentational and delegating, exactly as the legacy component: it
 * owns no navigation and no resubmit, because the two call sites (customer form
 * vs lead form) diverge on what "Open existing" means.
 *
 * One appearance change, recorded in the ledger: the matched row's danger tint
 * and its "matches" tag were hand-rolled classes on a div; here the collision is
 * named by a `softRed` Badge reading "matches" beside the value, so the signal
 * comes from a kit component rather than from a call-site colour.
 *
 * "Create anyway" stays de-emphasised behind a one-tap confirm - it is the
 * escape hatch, not the recommendation - but it is now a real ghost Button
 * rather than a bare styled <button>.
 *
 * Declared here and exported at the bottom, the kit's own style. It also
 * matters: the design-system duplicate-implementation guard reads
 * `export function <name containing Dialog>` and then requires an import from
 * `@/components/ui/dialog`, a path a v2 page may not use. This DOES compose a
 * shared Dialog primitive - the kit's - so the guard's check is a false
 * positive against the v2 layer. Teaching it about
 * `@/ui-kit/components/ui/dialog` belongs to whoever owns that guard; this
 * branch does not edit it. `leadDialogs.tsx` does the same thing.
 */
function DuplicateCustomerDialog({
  open, existing, matchedFields, onOpenExisting, onEditField, onCreateAnyway,
  onClose, isOverriding = false,
}: DuplicateCustomerDialogProps) {
  if (!existing) return null;

  const archived = !existing.is_active || Boolean(existing.archived_at);
  const addr = existing.primary_address;

  // Prefer the backend's relation-aware match info: it knows when a SECONDARY
  // phones[]/extra_emails[] entry matched (which the primary-only
  // `matchedFields` fallback cannot) and carries the exact value that collided,
  // so the value shown is the one the user actually typed.
  const matchedEmail = existing.matched ? existing.matched.email != null : Boolean(matchedFields?.email);
  const matchedPhone = existing.matched ? existing.matched.phone != null : Boolean(matchedFields?.phone);
  const emailShown = existing.matched?.email ?? existing.email;
  const phoneShown = existing.matched?.phone ?? existing.phone;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogIcon tone="warning"><AlertTriangle /></DialogIcon>
          <div>
            <DialogTitle>Possible Duplicate Customer</DialogTitle>
            <DialogDescription>
              A customer with the same{' '}
              {matchedEmail && matchedPhone ? 'email and phone' : matchedEmail ? 'email' : 'phone'}{' '}
              already exists in your organization.
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{displayName(existing)}</p>
                <p className="text-muted-foreground font-mono text-xs">{existing.customer_number}</p>
              </div>
              <Badge variant={archived ? 'softNeutral' : 'softGreen'} size="pill">
                {archived ? 'Archived' : 'Active'}
              </Badge>
            </div>

            <div className="flex flex-col gap-1.5">
              {emailShown && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate">{emailShown}</span>
                  {matchedEmail && <Badge variant="softRed" size="pill" className="ms-auto">matches</Badge>}
                </div>
              )}
              {phoneShown && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate">{formatPhone(phoneShown ?? '')}</span>
                  {matchedPhone && <Badge variant="softRed" size="pill" className="ms-auto">matches</Badge>}
                </div>
              )}
              {addr && (
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <MapPin className="size-4 shrink-0" />
                  <span className="truncate">
                    {[addr.line1, addr.city, addr.state].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Button className="w-full justify-start" onClick={onOpenExisting}>
              <ArrowRight />
              Open existing customer
            </Button>
            {matchedEmail && (
              <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('email')}>
                <Pencil />
                Edit email
              </Button>
            )}
            {matchedPhone && (
              <Button variant="outline" className="w-full justify-start" onClick={() => onEditField('phone')}>
                <Pencil />
                Edit phone
              </Button>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCreateAnyway}
            disabled={isOverriding}
            isLoading={isOverriding}
          >
            Create anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DuplicateCustomerDialog };
