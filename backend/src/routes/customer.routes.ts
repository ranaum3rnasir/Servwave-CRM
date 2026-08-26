import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as customerController from '../controllers/customer.controller';
import * as jobCommunicationsController from '../controllers/job-communications.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Stats & export (must be before /:id)
router.get('/stats', canDo('read', 'Customer'), customerController.getStats);
router.get('/export', expensiveLimiter, canDo('export', 'Customer'), customerController.exportAll);
// List-level bulk tag (Customers list page) - same `update Customer` grant as POST /:id/tags
// below. Pure DB write, no email/PDF involved, so no expensiveLimiter - the house generalLimiter
// already covers it.
router.post('/bulk-tag', canDo('update', 'Customer'), validate(tagController.bulkTagEntitySchema), tagController.bulkAddTagToCustomers);

// List & detail
router.get('/', canDo('read', 'Customer'), customerController.list);
router.get('/:id', canDo('read', 'Customer'), customerController.getById);

// Create & delete
router.post('/', canDo('create', 'Customer'), validate(customerController.createCustomerSchema), customerController.create);
router.delete('/:id', canDo('delete', 'Customer'), customerController.remove);

// Update
router.patch('/:id', canDo('update', 'Customer'), validate(customerController.updateCustomerSchema), customerController.update);

// Editable record ID (Workiz dual-run) - preview is read-only/advisory (no lock);
// rename is the real write and takes the parent row lock itself.
router.post('/:id/number/preview', canDo('renumber', 'Customer'), validate(customerController.renumberCustomerSchema), customerController.previewCustomerNumber);
router.patch('/:id/number', canDo('renumber', 'Customer'), validate(customerController.renumberCustomerSchema), customerController.renameCustomer);

// Lifecycle (entity-redesign §10)
router.post('/:id/archive', canDo('archive', 'Customer'), customerController.archiveCustomer);
router.post('/:id/unarchive', canDo('archive', 'Customer'), customerController.unarchiveCustomer);
router.post('/:id/purge', canDo('force_purge', 'Customer'), customerController.purgeCustomer);
router.post('/:id/anonymize', canDo('anonymize', 'Customer'), customerController.anonymizeCustomer);

// Customer summary (financial aggregation)
router.get('/:id/summary', canDo('read', 'Customer'), customerController.getSummary);

// Customer communications roll-up (Communication ↔ Jobs)
router.get('/:id/communications', canDo('read', 'Communication'), jobCommunicationsController.getCustomerCommunications);

// Customer notes
router.post('/:id/notes', canDo('update', 'Customer'), validate(customerController.createNoteSchema), customerController.addNote);

// Tags (polymorphic)
// Tag routes take BOTH ids straight from the path into `where` clauses over Postgres
// `uuid` columns, so without these guards a stray segment makes the driver throw P2023
// and the controller's catch reports a 500 for what is only a bad URL. They sit AFTER
// canDo so a caller without the grant still gets 403 rather than learning whether the
// id was well-formed, and they return the SAME 404 text the handler gives for a row
// that genuinely is not there.
router.post('/:id/tags', canDo('update', 'Customer'), requireUuidParam('id', 'customer not found'), validate(tagController.addTagToEntitySchema), tagController.addTagToCustomer);
router.delete('/:id/tags/:tagId', canDo('update', 'Customer'), requireUuidParam('id', 'customer not found'), requireUuidParam('tagId', 'Tag not attached to this customer'), tagController.removeTagFromCustomer);

// Service locations
router.post('/:id/locations', canDo('update', 'Customer'), validate(customerController.createLocationSchema), customerController.addLocation);
router.patch('/:id/locations/:locId', canDo('update', 'Customer'), validate(customerController.updateLocationSchema), customerController.updateLocation);
router.post('/:id/locations/:locId/archive', canDo('archive', 'Customer'), customerController.archiveLocation);
router.delete('/:id/locations/:locId', canDo('delete', 'Customer'), customerController.removeLocation);

export default router;
