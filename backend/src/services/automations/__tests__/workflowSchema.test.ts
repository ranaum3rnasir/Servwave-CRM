import { describe, it, expect } from 'vitest';
import {
  Prisma,
  WorkflowStatus,
  WorkflowStepType,
  WorkflowEnrollmentStatus,
  WorkflowStepRunStatus,
} from '@prisma/client';

// Pins the shape of the workflow-builder schema (Workflow, WorkflowStep,
// WorkflowVersion, WorkflowEnrollment, WorkflowStepRun + their enums). No
// engine code here — this only guards against silent drift between
// schema.prisma and the hand-authored migration that creates these tables.

describe('workflow builder schema — enums', () => {
  it('WorkflowStatus is exactly DRAFT + PUBLISHED', () => {
    expect(new Set(Object.values(WorkflowStatus))).toEqual(new Set(['DRAFT', 'PUBLISHED']));
  });

  it('WorkflowStepType is exactly the five step kinds', () => {
    expect(new Set(Object.values(WorkflowStepType))).toEqual(
      new Set(['WAIT', 'SEND_TEXT', 'SEND_EMAIL', 'NOTIFY_TEAM', 'STOP_IF']),
    );
  });

  it('WorkflowEnrollmentStatus is exactly the four enrollment states', () => {
    expect(new Set(Object.values(WorkflowEnrollmentStatus))).toEqual(
      new Set(['ACTIVE', 'COMPLETED', 'STOPPED', 'FAILED']),
    );
  });

  it('WorkflowStepRunStatus is exactly the five step-run outcomes', () => {
    expect(new Set(Object.values(WorkflowStepRunStatus))).toEqual(
      new Set(['SENT', 'SKIPPED', 'FAILED', 'STOPPED', 'CONTINUED']),
    );
  });
});

describe('workflow builder schema — models', () => {
  it('registers all five workflow builder models on Prisma.ModelName', () => {
    expect(Prisma.ModelName.Workflow).toBe('Workflow');
    expect(Prisma.ModelName.WorkflowStep).toBe('WorkflowStep');
    expect(Prisma.ModelName.WorkflowVersion).toBe('WorkflowVersion');
    expect(Prisma.ModelName.WorkflowEnrollment).toBe('WorkflowEnrollment');
    expect(Prisma.ModelName.WorkflowStepRun).toBe('WorkflowStepRun');
  });
});
