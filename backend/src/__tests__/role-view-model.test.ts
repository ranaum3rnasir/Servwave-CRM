import { describe, it, expect } from 'vitest';
import {
  assembleRoleViewModel,
  viewModelToGrants,
  MODULES,
  SCOPE_ENTITIES,
  TOGGLES,
} from '../lib/permissions/roleViewModel';

describe('roleViewModel', () => {
  it('exposes 18 CRUD modules (SRVW-139) and 4 scope entities', () => {
    expect(MODULES.map((m) => m.subject)).toEqual([
      'Customer', 'Lead', 'Estimate', 'Job', 'Invoice', 'Inventory', 'PurchaseOrder', 'Vendor', 'ServicePlan', 'LogisticOrder',
      'Communication', 'Task', 'PriceBook', 'Attachment', 'User', 'Department', 'Location', 'Automation',
    ]);
    expect(SCOPE_ENTITIES.map((e) => e.subject)).toEqual(['Lead', 'Job', 'Estimate', 'Invoice']);
  });

  it('none of the 8 new SRVW-139 modules gained a scope chip (no ownership chain)', () => {
    const vm = assembleRoleViewModel('DISPATCHER', []);
    for (const subject of ['Communication', 'Task', 'PriceBook', 'Attachment', 'User', 'Department', 'Location', 'Automation']) {
      expect(vm.scope[subject]).toBeUndefined();
    }
  });

  it('assembles matrix + scope from grants', () => {
    const vm = assembleRoleViewModel('SALES', [
      { action: 'read', subject: 'Customer', conditions: null },
      { action: 'update', subject: 'Customer', conditions: null },
      { action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    expect(vm.matrix.Customer).toEqual({ read: true, create: false, update: true, delete: false });
    expect(vm.scope.Lead).toBe('Owned');
    expect(vm.scope.Job).toBe('All');
  });

  // SRVW-140 - "See financial data" now round-trips `read Pricing` (the grant canSeePricing
  // actually keys on) and `read Report` moved to its own honest `viewReports` bundle.
  it('detects sensitive toggles', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Pricing', conditions: null },
      { action: 'read', subject: 'Report', conditions: null },
      { action: 'record_payment', subject: 'Invoice', conditions: null },
      { action: 'record_payment', subject: 'Estimate', conditions: null },
      { action: 'refund', subject: 'Invoice', conditions: null },
    ]);
    expect(vm.sensitive.seeFinancials).toBe(true);
    expect(vm.sensitive.managePayments).toBe(true);
    expect(vm.sensitive.viewReports).toBe(true);
  });

  it('seeFinancials keys on read Pricing ALONE - a read Report grant no longer sets it', () => {
    const vm = assembleRoleViewModel('SALES', [{ action: 'read', subject: 'Report', conditions: null }]);
    expect(vm.sensitive.seeFinancials).toBe(false);
    expect(vm.sensitive.viewReports).toBe(true);
  });

  it('viewReports is independent of seeFinancials (the post-backfill SALES shape)', () => {
    const vm = assembleRoleViewModel('SALES', [{ action: 'read', subject: 'Pricing', conditions: null }]);
    expect(vm.sensitive.seeFinancials).toBe(true);
    expect(vm.sensitive.viewReports).toBe(false);
  });

  it('round-trips matrix + sensitive + scope to grants', () => {
    const vm = {
      role: 'SALES',
      matrix: {
        Customer: { read: true, create: false, update: false, delete: false },
        Lead: { read: true, create: false, update: false, delete: false },
      },
      sensitive: { seeFinancials: true, managePayments: false, viewReports: false },
      toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
      scope: { Lead: 'Team' as const },
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toContainEqual({ action: 'read', subject: 'Customer', conditions: null });
    expect(grants).toContainEqual({ action: 'read', subject: 'Pricing', conditions: null });
    expect(grants).toContainEqual({
      action: 'read',
      subject: 'Lead',
      conditions: { lead_assignees: { some: { user: { department_id: '{{teamId}}' } } } },
    });
    // managePayments off → no payment grants
    expect(grants.some((g) => g.action === 'record_payment')).toBe(false);
    // SRVW-140 - NO `?? seeFinancials` fallback. viewReports off means read:Report is not
    // emitted, whatever seeFinancials says; the legacy accommodation lives in the controller
    // (where `existing` is in scope), never in this pure emitter.
    expect(grants).not.toContainEqual({ action: 'read', subject: 'Report', conditions: null });
  });

  it('emits read:Report for viewReports, and never a second read:Invoice for seeFinancials', () => {
    const vm = {
      role: 'DISPATCHER',
      matrix: { Invoice: { read: true, create: false, update: false, delete: false } },
      sensitive: { seeFinancials: true, managePayments: false, viewReports: true },
      toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
      scope: { Invoice: 'Owned' as const },
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toContainEqual({ action: 'read', subject: 'Report', conditions: null });
    // The headline danger the plan avoids structurally: read:Invoice must come ONLY from the
    // matrix row, carrying its data-scope condition. A second, conditions-null copy would land
    // last in putRolePermissions' in-order upsert and silently widen the role's data scope.
    const invoiceReads = grants.filter((g) => g.action === 'read' && g.subject === 'Invoice');
    expect(invoiceReads).toEqual([
      { action: 'read', subject: 'Invoice', conditions: { job: { assignees: { some: { user_id: '{{userId}}' } } } } },
    ]);
  });

  it('persists the owner condition onto read + update + delete when scope=Owned (#106a)', () => {
    // Mirror a Roles-UI Save: full CRUD on Lead with data-scope Owned. The owner
    // condition must ride on read AND update AND delete (not just read), so a Save
    // can never strip the seed's OWN_* protection down to a match-everything rule.
    const vm = {
      role: 'SALES',
      matrix: {
        Lead: { read: true, create: true, update: true, delete: true },
      },
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
      scope: { Lead: 'Owned' as const },
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    const ownerCond = { lead_assignees: { some: { user_id: '{{userId}}' } } };

    expect(grants).toContainEqual({ action: 'read', subject: 'Lead', conditions: ownerCond });
    expect(grants).toContainEqual({ action: 'update', subject: 'Lead', conditions: ownerCond });
    expect(grants).toContainEqual({ action: 'delete', subject: 'Lead', conditions: ownerCond });
    // create is structurally unenforceable in CASL (no row to condition on) → stays null.
    expect(grants).toContainEqual({ action: 'create', subject: 'Lead', conditions: null });
  });
});

// SRVW-139 - five toggle bundles for actions the CRUD matrix can't host: Dashboard/Notification
// have no create action (a matrix row would be permanently unusable), and reopen/cancel Job are
// single lifecycle verbs, not a CRUD cell. Same on/off mechanism as the SENSITIVE bundles.
describe('roleViewModel - SRVW-139 toggle bundles', () => {
  it('exposes exactly the 5 named toggles', () => {
    expect(Object.keys(TOGGLES).sort()).toEqual(
      ['accountSettings', 'cancelJobs', 'dashboard', 'modifyDoneJobs', 'notifications'].sort(),
    );
  });

  it('assembles each toggle as on/off from its bundle grants', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Dashboard', conditions: null },
      { action: 'cancel', subject: 'Job', conditions: null },
    ]);
    expect(vm.toggles.dashboard).toBe(true);
    expect(vm.toggles.cancelJobs).toBe(true);
    expect(vm.toggles.modifyDoneJobs).toBe(false);
    expect(vm.toggles.accountSettings).toBe(false);
    expect(vm.toggles.notifications).toBe(false);
  });

  it('accountSettings requires BOTH read and update Organization (partial = off)', () => {
    const partial = assembleRoleViewModel('SALES', [{ action: 'read', subject: 'Organization', conditions: null }]);
    expect(partial.toggles.accountSettings).toBe(false);
    const full = assembleRoleViewModel('SALES', [
      { action: 'read', subject: 'Organization', conditions: null },
      { action: 'update', subject: 'Organization', conditions: null },
    ]);
    expect(full.toggles.accountSettings).toBe(true);
  });

  it('notifications reads as on regardless of the row-scope condition shape', () => {
    const vm = assembleRoleViewModel('TECHNICIAN', [
      { action: 'read', subject: 'Notification', conditions: { recipients: { some: { recipient_id: '{{userId}}' } } } },
      { action: 'update', subject: 'Notification', conditions: { recipients: { some: { recipient_id: '{{userId}}' } } } },
      { action: 'delete', subject: 'Notification', conditions: { recipients: { some: { recipient_id: '{{userId}}' } } } },
    ]);
    expect(vm.toggles.notifications).toBe(true);
  });

  it('round-trips a plain toggle (dashboard) to its unconditional grant', () => {
    const vm = {
      role: 'SALES',
      matrix: {},
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      toggles: { dashboard: true, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
      scope: {},
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toContainEqual({ action: 'read', subject: 'Dashboard', conditions: null });
  });

  it('round-trips modifyDoneJobs/cancelJobs to reopen Job / cancel Job', () => {
    const vm = {
      role: 'DISPATCHER',
      matrix: {},
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: true, cancelJobs: true },
      scope: {},
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toContainEqual({ action: 'reopen', subject: 'Job', conditions: null });
    expect(grants).toContainEqual({ action: 'cancel', subject: 'Job', conditions: null });
  });

  // The headline danger: Notification grants are ALWAYS self-scoped in this product (there is no
  // "see everyone's notifications" feature). If the emitter wrote conditions:null like the plain
  // SENSITIVE bundles do, ticking this toggle would silently hand a role every user's
  // notifications org-wide the next time anyone saves the Roles page.
  it('notifications NEVER emits an unconditional (org-wide) grant - always the self-scope condition', () => {
    const vm = {
      role: 'SALES',
      matrix: {},
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      toggles: { dashboard: false, accountSettings: false, notifications: true, modifyDoneJobs: false, cancelJobs: false },
      scope: {},
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    const notificationGrants = grants.filter((g) => g.subject === 'Notification');
    expect(notificationGrants).toHaveLength(3);
    for (const g of notificationGrants) {
      expect(g.conditions).not.toBeNull();
      expect(g.conditions).toEqual({ recipients: { some: { recipient_id: '{{userId}}' } } });
    }
  });

  it('a toggle left off emits none of its bundle grants', () => {
    const vm = {
      role: 'SALES',
      matrix: {},
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
      scope: {},
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toHaveLength(0);
  });
});
