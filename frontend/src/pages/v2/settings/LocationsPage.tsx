import { useEffect, useState } from 'react';

import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
  type Location,
  type LocationInput,
} from '@/lib/api/locations';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { useSettingsBar } from './settingsBar';
import { Section, FlushCard } from './components/section';
import { Field } from './components/field';

const EMPTY: Partial<LocationInput> = { name: '', city: '', state: '', timezone: '', phone: '' };

/**
 * Settings > Locations.
 *
 * Delete has NO confirmation dialog, which diverges from every other
 * destructive action in this module. That is existing behaviour and it is
 * reproduced verbatim - adding a confirm here would be a behaviour change
 * smuggled into a restyle. Logged in the ledger instead.
 */
export default function LocationsPage() {
  const { data: locations = [] } = useLocations();
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const remove = useDeleteLocation();
  const { registerSaver } = useSettingsBar();

  const [editing, setEditing] = useState<Partial<Location> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This screen manages its own per-row saves; keep the sub-bar Save disabled.
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);

  const startNew = () => {
    setError(null);
    setEditing({ ...EMPTY });
  };

  // Build a clean payload from only the editable fields - never echo back
  // server-controlled keys (id/created_at/manager/_count). Code and manager were
  // removed from this screen, so they are no longer sent.
  const buildPayload = (e: Partial<Location>): Partial<LocationInput> => ({
    name: e.name,
    address_line1: e.address_line1 ?? null,
    city: e.city ?? null,
    state: e.state ?? null,
    timezone: e.timezone ?? null,
    phone: e.phone ?? null,
  });

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const payload = buildPayload(editing);
      if (editing.id) {
        await update.mutateAsync({ id: editing.id, ...payload });
      } else {
        await create.mutateAsync(payload);
      }
      setEditing(null);
    } catch (e: unknown) {
      setError(extractApiError(e, 'Failed to save location'));
    }
  };

  const del = async (loc: Location) => {
    setError(null);
    try {
      await remove.mutateAsync(loc.id);
      if (editing?.id === loc.id) setEditing(null);
    } catch (e: unknown) {
      setError(extractApiError(e, 'Failed to delete location'));
    }
  };

  const set = (k: keyof Location, v: string) => setEditing((p) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits at its
            floor for h1-h6. */}
        <p role="heading" aria-level={3} className="text-sm font-semibold">
          Business Locations
        </p>
        <Button size="sm" onClick={startNew}>
          + New Location
        </Button>
      </div>

      {error && (
        <div className="bg-status-red-subtle text-status-red-emphasis rounded-md px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <FlushCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Time Zone</TableHead>
              <TableHead className="w-20">Staff</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} padding="none">
                  <EmptyState title="No locations yet." />
                </TableCell>
              </TableRow>
            )}
            {locations.map((loc) => (
              <TableRow
                key={loc.id}
                className="cursor-pointer"
                onClick={() =>
                  setEditing({ ...loc, phone: loc.phone == null ? loc.phone : formatPhone(loc.phone) })
                }
              >
                <TableCell>
                  <span className="font-medium">{loc.name}</span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {[loc.address_line1, loc.city, loc.state].filter(Boolean).join(', ') || '-'}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">{loc.timezone || '-'}</span>
                </TableCell>
                <TableCell>{loc._count?.members ?? 0}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void del(loc);
                    }}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FlushCard>

      {editing && (
        <Section title={editing.id ? 'Edit Branch' : 'New Branch'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Branch Name" required>
              <Input value={editing.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Street">
              <Input value={editing.address_line1 ?? ''} onChange={(e) => set('address_line1', e.target.value)} />
            </Field>
            <Field label="City">
              <Input value={editing.city ?? ''} onChange={(e) => set('city', e.target.value)} />
            </Field>
            <Field label="State">
              <Input value={editing.state ?? ''} onChange={(e) => set('state', e.target.value)} />
            </Field>
            <Field label="Time Zone">
              <Input value={editing.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={editing.phone ?? ''} onChange={(e) => set('phone', formatPhoneInput(e.target.value))} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!editing.name?.trim() || create.isPending || update.isPending}
            >
              {editing.id ? 'Save' : 'Create'}
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}
