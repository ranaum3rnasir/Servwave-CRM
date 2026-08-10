/**
 * entities.ts — the four business entities a trigger can hang off, and the
 * order the builder groups them in. Mirrors the backend catalog's
 * `AutomationEntity`.
 */

import type { TriggerDef } from '@/lib/api/workflows';

export type AutomationEntity = TriggerDef['entity'];

export const ENTITY_ORDER: AutomationEntity[] = ['job', 'estimate', 'invoice', 'lead'];
