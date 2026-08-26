import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as priceBookController from '../controllers/price-book.controller';

const router = Router();

router.use(authenticate, attachAbility);

// ─── Categories ─────────────────────────────────────────
router.get('/categories', canDo('read', 'PriceBook'), priceBookController.listCategories);
router.post('/categories', canDo('create', 'PriceBook'), validate(priceBookController.createCategorySchema), priceBookController.createCategory);
router.patch('/categories/:id', canDo('update', 'PriceBook'), validate(priceBookController.updateCategorySchema), priceBookController.updateCategory);
router.delete('/categories/:id', canDo('delete', 'PriceBook'), priceBookController.deleteCategory);

// ─── Items ──────────────────────────────────────────────
router.get('/items/search', canDo('read', 'PriceBook'), priceBookController.searchItems);
router.get('/items', canDo('read', 'PriceBook'), priceBookController.listItems);
router.post('/items', canDo('create', 'PriceBook'), validate(priceBookController.createItemSchema), priceBookController.createItem);
router.post('/items/import', canDo('create', 'PriceBook'), validate(priceBookController.importItemsEnvelopeSchema), priceBookController.importItems);
router.get('/items/:id', canDo('read', 'PriceBook'), priceBookController.getItem);
router.patch('/items/:id', canDo('update', 'PriceBook'), validate(priceBookController.updateItemSchema), priceBookController.updateItem);
router.delete('/items/:id', canDo('delete', 'PriceBook'), priceBookController.deleteItem);

// ─── Brands + Item Groups (single catalog write path — P0 §D2) ───────────────
router.post('/brands', canDo('create', 'PriceBook'), validate(priceBookController.upsertBrandSchema), priceBookController.upsertBrand);
router.delete('/brands/:id', canDo('delete', 'PriceBook'), priceBookController.deleteBrand);
router.post('/finishes', canDo('create', 'PriceBook'), validate(priceBookController.upsertFinishSchema), priceBookController.upsertFinish);
router.delete('/finishes/:id', canDo('delete', 'PriceBook'), priceBookController.deleteFinish);
router.post('/uom-options', canDo('create', 'PriceBook'), validate(priceBookController.upsertUomOptionSchema), priceBookController.upsertUomOption);
router.delete('/uom-options/:id', canDo('delete', 'PriceBook'), priceBookController.deleteUomOption);
router.post('/item-groups', canDo('create', 'PriceBook'), validate(priceBookController.upsertItemGroupSchema), priceBookController.upsertItemGroup);
router.delete('/item-groups/:id', canDo('delete', 'PriceBook'), priceBookController.deleteItemGroup);

export default router;
