import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { featureDisabled } from '../middleware/featureDisabled';
import * as invPoController from '../controllers/inv-po.controller';

// Mounted at /api/inventory (see src/app.ts wiring step).
const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// Subject split (inventory P0, D11): everything purchasing-shaped gates on `PurchaseOrder`,
// not the coarse `Inventory` subject (which now means stock only).
// ─── Purchase Orders ────────────────────────────────────
router.get('/purchase-orders', canDo('read', 'PurchaseOrder'), invPoController.listPurchaseOrders);
router.post('/purchase-orders', canDo('create', 'PurchaseOrder'), validate(invPoController.createPurchaseOrderSchema), invPoController.createPurchaseOrder);
router.post('/purchase-orders/from-job', canDo('create', 'PurchaseOrder'), validate(invPoController.createPurchaseOrderFromJobSchema), invPoController.createPurchaseOrderFromJob);
// Registered BEFORE /purchase-orders/:id or the :id route swallows the literal path.
// Proposals carry unit_cost, hence the PurchaseOrder read gate (Admin/Dispatcher).
router.get('/purchase-orders/low-stock-proposals', canDo('read', 'PurchaseOrder'), invPoController.listLowStockProposals);
router.get('/purchase-orders/:id', canDo('read', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), invPoController.getPurchaseOrder);
// Real PO activity timeline (D7): audit-log lifecycle events + outbound send history.
router.get('/purchase-orders/:id/activity', canDo('read', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), invPoController.getPurchaseOrderActivity);
router.patch('/purchase-orders/:id', canDo('update', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), validate(invPoController.updatePurchaseOrderSchema), invPoController.updatePurchaseOrder);
router.post('/purchase-orders/receive', canDo('update', 'PurchaseOrder'), validate(invPoController.receivePurchaseOrderSchema), invPoController.receivePurchaseOrder);
// P2 item 6a: real PO send. No dedicated `send` action exists for PurchaseOrder
// (catalog.ts) — `update` already owns the lifecycle verbs (edit/receive), so
// send reuses it rather than minting a new catalog action + grants backfill.
router.post('/purchase-orders/:id/send', canDo('update', 'PurchaseOrder'), requireUuidParam('id', 'Purchase order not found'), validate(invPoController.sendPurchaseOrderSchema), invPoController.sendPurchaseOrder);

// ─── Job material-cost roll-up (read-side, zero invoice impact) ──────────────
router.get('/jobs/:jobId/material-cost', canDo('read', 'PurchaseOrder'), invPoController.getJobMaterialCost);

// ─── RFQs — PARKED (P0 §C, QA-902 / plan A-18) ──────────
// Feature-disabled for everyone (incl. Admin): auth still runs first (401
// without a token), then every verb answers 404 FEATURE_DISABLED. Handlers
// stay in the controller for cheap un-parking (same pattern as the #743 SMS lock).
router.get('/rfqs', featureDisabled('rfq'));
router.post('/rfqs', featureDisabled('rfq'));
router.get('/rfqs/:id', featureDisabled('rfq'));
router.patch('/rfqs/:id', featureDisabled('rfq'));

// ─── Estimate Reservations (power the Pre-PO tab) ────────────────────────────
router.get('/estimate-reservations', canDo('read', 'PurchaseOrder'), invPoController.listEstimateReservations);
router.get('/estimate-reservations/:id', canDo('read', 'PurchaseOrder'), invPoController.getEstimateReservation);
router.post('/estimate-reservations', canDo('create', 'PurchaseOrder'), validate(invPoController.createReservationSchema), invPoController.createEstimateReservation);
// Lifecycle verbs (P2 item 3): convert creates a PO (create gate); dismiss is a
// terminal edit of the reservation queue (update gate).
router.post('/estimate-reservations/:id/convert', canDo('create', 'PurchaseOrder'), validate(invPoController.convertReservationSchema), invPoController.convertEstimateReservation);
router.post('/estimate-reservations/:id/dismiss', canDo('update', 'PurchaseOrder'), validate(invPoController.dismissReservationSchema), invPoController.dismissEstimateReservation);

export default router;
