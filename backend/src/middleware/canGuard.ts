import { Request, Response, NextFunction } from 'express';
import type { Action, Subject } from '../lib/permissions/catalog';

export function canDo(action: Action, subject: Subject) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.ability.can(action, subject)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
