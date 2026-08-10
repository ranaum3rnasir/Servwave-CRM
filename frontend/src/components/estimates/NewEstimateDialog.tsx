import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/data/status-badge';
import { formatPhone } from '@/lib/utils';
import { useFeature } from '@/lib/entitlements';
import { FileText, Search, ChevronRight, ChevronDown, Plus, Loader2, UserPlus } from 'lucide-react';

interface NewEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preSelectedCustomerId?: string;
  onPreSelectConsumed?: () => void;
}

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  phone: string;
  email: string | null;
}

interface Lead {
  id: string;
  status: string;
  service_request: string;
  created_at: string;
}

// Non-terminal lead statuses — the exact set the server's estimate-create gate accepts
// (estimate.controller.ts:665-668 rejects only WON/LOST/CANCELLED; create is never gated
// on the walkthrough — Bug #39). Mirrors LeadsPage.tsx:63 ACTIVE_STATUSES. Load-bearing:
// GET /api/leads here passes no status param, so the API returns terminal leads too — this
// filter is what keeps WON/LOST/CANCELLED out of the picker. Walkthrough-as-entity redesign,
// PR-C2: WALKTHROUGH_SCHEDULED/WALKTHROUGH_COMPLETED left LeadStatus, so this is back down to
// the plain open-pipeline set.
const ACTIVE_STATUSES = ['NEW', 'CONTACTED', 'ESTIMATED'];

export function NewEstimateDialog({ open, onOpenChange, preSelectedCustomerId, onPreSelectConsumed }: NewEstimateDialogProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
      setExpandedCustomerId(null);
    }
  }, [open]);

  // Auto-expand pre-selected customer when dialog opens
  useEffect(() => {
    if (open && preSelectedCustomerId) {
      setExpandedCustomerId(preSelectedCustomerId);
      onPreSelectConsumed?.();
    }
  }, [open, preSelectedCustomerId, onPreSelectConsumed]);

  // Search customers
  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['customers-search', debouncedSearch],
    queryFn: async () => {
      const { data } = await api.get('/api/customers', {
        params: { search: debouncedSearch, limit: 6 },
      });
      return data.customers as Customer[];
    },
    enabled: debouncedSearch.length >= 2,
  });

  // Fetch customer detail for pre-selected customer (when no search results)
  const { data: preSelectedCustomer } = useQuery({
    queryKey: ['customer', expandedCustomerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${expandedCustomerId}`);
      return data.customer as Customer;
    },
    enabled: Boolean(expandedCustomerId) && debouncedSearch.length < 2,
  });

  // Fetch leads for expanded customer. Skipped without the Pro `leads`
  // entitlement: /api/leads 402s there, and estimates have been customer-anchorable
  // since R6 - a lead is one possible anchor, never a prerequisite for the
  // Starter-core estimate flow.
  const hasLeads = useFeature('leads');
  const { data: leadsData, isLoading: leadsLoading } = useQuery({
    queryKey: ['leads', { customer_id: expandedCustomerId }],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: { customer_id: expandedCustomerId, limit: 10 },
      });
      return data.leads as Lead[];
    },
    enabled: Boolean(expandedCustomerId) && hasLeads,
  });

  const actionableLeads = leadsData?.filter((l) => ACTIVE_STATUSES.includes(l.status)) ?? [];

  function handleCustomerClick(customerId: string) {
    setExpandedCustomerId(expandedCustomerId === customerId ? null : customerId);
  }

  function handleLeadSelect(leadId: string) {
    onOpenChange(false);
    navigate(`/estimates/new?lead_id=${leadId}`);
  }

  function handleAddNewClient() {
    onOpenChange(false);
    navigate('/leads/new', { state: { returnTo: '/estimates' } });
  }

  function handleCreateLead(customerId: string) {
    onOpenChange(false);
    navigate(`/leads/new?customer_id=${customerId}`);
  }

  function handleCreateEstimateNoLead(customerId: string) {
    onOpenChange(false);
    navigate(`/estimates/new?customer_id=${customerId}`);
  }

  function customerDisplayName(c: Customer) {
    const first = c.first_name?.trim();
    const last = c.last_name?.trim();
    const name = last && first ? `${first} ${last}` : (last || first || '');
    return c.company_name ? (name ? `${name} (${c.company_name})` : c.company_name) : name;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0">
        {/* Header */}
        <div className="flex flex-col items-center pt-6 pb-4 px-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-3">
            <FileText className="h-6 w-6 text-primary" />
          </div>
          <DialogHeader className="text-center space-y-1">
            <DialogTitle className="text-lg">Create New Estimate</DialogTitle>
            <DialogDescription>Select a client to get started</DialogDescription>
          </DialogHeader>
        </div>

        {/* Search */}
        <div className="px-6 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, phone, or company..."
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        {/* Results */}
        <div className="px-6 min-h-[120px] max-h-[320px] overflow-y-auto">
          {expandedCustomerId && debouncedSearch.length < 2 && preSelectedCustomer ? (
            /* Pre-selected customer: show directly without search */
            <div>
              <div className="w-full flex items-center gap-3 py-3 px-2 -mx-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {customerDisplayName(preSelectedCustomer)}
                  </p>
                  <p className="text-xs text-text-secondary">{formatPhone(preSelectedCustomer.phone)}</p>
                </div>
                <ChevronDown className="h-4 w-4 text-text-secondary shrink-0" />
              </div>
              <div className="ml-2 mb-3 rounded-lg bg-background-light border">
                {leadsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
                  </div>
                ) : actionableLeads.length === 0 ? (
                  <div className="px-3 py-3">
                    <p className="text-xs text-text-secondary mb-2">No active leads</p>
                    {/* link/brand matches the raw's text-primary + hover:underline exactly.
                        Two disclosed, not-restored deltas on both buttons below: the raw's
                        text-xs font-medium becomes the primitive's base text-sm font-semibold
                        (bigger, bolder). */}
                    <Button
                      type="button"
                      variant="link"
                      size={null}
                      onClick={() => handleCreateLead(preSelectedCustomer.id)}
                      className="flex items-center gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create new lead
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      size={null}
                      onClick={() => handleCreateEstimateNoLead(preSelectedCustomer.id)}
                      className="flex items-center gap-1.5 mt-2"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Create estimate without a lead
                    </Button>
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {actionableLeads.map((lead) => (
                      // list-row click target (description + StatusBadge) - not Button-shaped, left raw.
                      <button
                        key={lead.id}
                        type="button"
                        onClick={() => handleLeadSelect(lead.id)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-light transition-colors first:rounded-t-lg last:rounded-b-lg"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">
                            {lead.service_request || 'No description'}
                          </p>
                        </div>
                        <StatusBadge domain="lead" status={lead.status} className="shrink-0" neutral />
                      </button>
                    ))}
                    {/* footer row: idle text-primary, hover:bg only (text stays primary) - no
                        ghost+brand or outline+brand cell is minted on Button; left raw. */}
                    <button
                      type="button"
                      onClick={() => handleCreateLead(preSelectedCustomer.id)}
                      className="w-full flex items-center gap-1.5 px-3 py-2.5 text-xs text-primary font-medium hover:bg-background-light transition-colors rounded-b-lg"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create new lead
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : debouncedSearch.length < 2 ? (
            <p className="text-sm text-text-secondary text-center py-8">
              Type at least 2 characters to search
            </p>
          ) : customersLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
            </div>
          ) : !customers?.length ? (
            <p className="text-sm text-text-secondary text-center py-8">
              No clients found
            </p>
          ) : (
            <div className="divide-y">
              {customers.map((customer) => {
                const isExpanded = expandedCustomerId === customer.id;
                return (
                  <div key={customer.id}>
                    {/* Customer row - list-row click target (name/phone/chevron) - not
                        Button-shaped, left raw. */}
                    <button
                      type="button"
                      onClick={() => handleCustomerClick(customer.id)}
                      className="w-full flex items-center gap-3 py-3 text-left hover:bg-background-light rounded-md px-2 -mx-2 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {customerDisplayName(customer)}
                        </p>
                        <p className="text-xs text-text-secondary">{formatPhone(customer.phone)}</p>
                      </div>
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-text-secondary shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-text-secondary shrink-0" />
                      )}
                    </button>

                    {/* Expanded leads */}
                    {isExpanded && (
                      <div className="ml-2 mb-3 rounded-lg bg-background-light border">
                        {leadsLoading ? (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
                          </div>
                        ) : actionableLeads.length === 0 ? (
                          <div className="px-3 py-3">
                            <p className="text-xs text-text-secondary mb-2">No active leads</p>
                            {/* link/brand matches the raw's text-primary + hover:underline
                                exactly. Two disclosed, not-restored deltas on both buttons
                                below: the raw's text-xs font-medium becomes the primitive's
                                base text-sm font-semibold (bigger, bolder). */}
                            <Button
                              type="button"
                              variant="link"
                              size={null}
                              onClick={() => handleCreateLead(customer.id)}
                              className="flex items-center gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Create new lead
                            </Button>
                            <Button
                              type="button"
                              variant="link"
                              size={null}
                              onClick={() => handleCreateEstimateNoLead(customer.id)}
                              className="flex items-center gap-1.5 mt-2"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Create estimate without a lead
                            </Button>
                          </div>
                        ) : (
                          <div className="divide-y divide-border/50">
                            {actionableLeads.map((lead) => (
                              // list-row click target (description + StatusBadge) - not Button-shaped, left raw.
                              <button
                                key={lead.id}
                                type="button"
                                onClick={() => handleLeadSelect(lead.id)}
                                className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-light transition-colors first:rounded-t-lg last:rounded-b-lg"
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium truncate">
                                    {lead.service_request || 'No description'}
                                  </p>
                                </div>
                                <StatusBadge domain="lead" status={lead.status} className="shrink-0" neutral />
                              </button>
                            ))}
                            {/* footer row: idle text-primary, hover:bg only (text stays
                                primary) - no ghost+brand or outline+brand cell is minted on
                                Button; left raw. */}
                            <button
                              type="button"
                              onClick={() => handleCreateLead(customer.id)}
                              className="w-full flex items-center gap-1.5 px-3 py-2.5 text-xs text-primary font-medium hover:bg-background-light transition-colors rounded-b-lg"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Create new lead
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Divider + Add new client */}
        <div className="px-6 pb-6 pt-2">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 border-t" />
            <span className="text-xs text-text-secondary">OR</span>
            <div className="flex-1 border-t" />
          </div>
          {/* link/brand matches the raw's text-primary + hover:underline exactly (raw was
              already text-sm, unlike the sites above). One disclosed, not-restored delta:
              the raw's font-medium becomes the primitive's base font-semibold (bolder). */}
          <Button
            type="button"
            variant="link"
            size={null}
            onClick={handleAddNewClient}
            className="flex items-center justify-center w-full"
          >
            <UserPlus className="h-4 w-4" />
            Add new client
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
