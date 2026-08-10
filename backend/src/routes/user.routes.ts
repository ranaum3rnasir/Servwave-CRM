import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import * as userController from '../controllers/user.controller';
import * as avatarController from '../controllers/user-avatar.controller';

const router = Router();

// memoryStorage, image-only. Route-level limit sits ABOVE the handler's real 8MB cap so an
// oversized photo 400s with the handler's precise message instead of multer's own error.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// All user routes require authentication and ability attachment
router.use(authenticate, attachAbility);

// Self-service routes — MUST precede /:id so "me" isn't parsed as an id. No canDo: any
// authenticated user manages their own profile/password/avatar.
router.patch('/me', validate(userController.meUpdateSchema), userController.updateMe);
router.post('/me/password', validate(userController.changePasswordSchema), userController.changeMyPassword);
// `withOrgContext` MUST come AFTER multer — multer's stream consumption drives the
// continuation outside authenticate's AsyncLocalStorage org scope (withOrgContext.ts).
router.post('/me/avatar', avatarUpload.single('file'), withOrgContext, avatarController.setAvatar);
router.delete('/me/avatar', avatarController.deleteAvatar);

router.get('/', canDo('read', 'User'), userController.list);
router.post('/', canDo('create', 'User'), validate(userController.createUserSchema), userController.create);
router.post('/invite', canDo('create', 'User'), validate(userController.inviteUserSchema), userController.inviteUser);
router.post('/:id/invite', canDo('create', 'User'), userController.invite);
router.post('/:id/revoke-login', canDo('update', 'User'), userController.revokeLogin);
// Per-user permission overrides (RBAC Phase 2). Managing a user's permissions is an admin
// action → both gated on `update User` (read User alone, e.g. a dispatcher, is not enough).
router.get('/:id/permissions', canDo('update', 'User'), userController.getPermissions);
router.put('/:id/permissions', canDo('update', 'User'), validate(userController.putPermissionsSchema), userController.putPermissions);
router.get('/:id', canDo('read', 'User'), userController.getById);
router.patch('/:id', canDo('update', 'User'), validate(userController.updateUserSchema), userController.update);
router.delete('/:id', canDo('delete', 'User'), userController.deactivate);
router.delete('/:id/permanent', canDo('delete', 'User'), userController.permanentDelete);
router.post('/:id/mfa/reset', canDo('delete', 'User'), userController.resetMfa);
router.post('/:id/avatar', canDo('update', 'User'), avatarUpload.single('file'), withOrgContext, avatarController.setAvatar);
router.delete('/:id/avatar', canDo('update', 'User'), avatarController.deleteAvatar);

export default router;
