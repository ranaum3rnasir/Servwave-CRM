import { describe, it, expect } from 'vitest';
import { JobStatus } from '@prisma/client';
import { STATUS_LABEL } from '../services/jobs-report';

const ALL_STATUSES = Object.values(JobStatus);

describe('every JobStatus is handled', () => {
  it('has seven values — a new one means every list in this file needs review', () => {
    expect(ALL_STATUSES.sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_SITE', 'SCHEDULED', 'UNASSIGNED'],
    );
  });

  it('jobs-report labels every status', () => {
    for (const s of ALL_STATUSES) expect(STATUS_LABEL[s]).toBeDefined();
  });

  it('jobs-report gives EN_ROUTE, ON_SITE and IN_PROGRESS distinct labels (Spec B1, B-8)', () => {
    // The plain "defined" check above passes vacuously if all three collapse to the same
    // string — the actual defect B-8 flags. Assert them pairwise distinct.
    const enRoute = STATUS_LABEL['EN_ROUTE'];
    const onSite = STATUS_LABEL['ON_SITE'];
    const inProgress = STATUS_LABEL['IN_PROGRESS'];
    expect(enRoute).not.toBe(onSite);
    expect(enRoute).not.toBe(inProgress);
    expect(onSite).not.toBe(inProgress);
  });
});
