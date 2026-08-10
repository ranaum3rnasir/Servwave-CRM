import { describe, it, expect } from 'vitest';
import { crewPeopleOf, ownerOf, fullName } from './eventPeople';

const jobRaw = {
  assignees: [
    { user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng' } },
    { user: { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz' } },
  ],
  estimate: { lead: { commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } } },
};
const leadRaw = {
  walkthrough_performers: [{ user: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' } }],
  commission_owner: { id: 'u-eve', first_name: 'Eve', last_name: 'Park' },
};

describe('crewPeopleOf', () => {
  it('job → assignees[].user (the crew, in order)', () => {
    expect(crewPeopleOf('job', jobRaw).map((p) => p.id)).toEqual(['u-alice', 'u-bob']);
  });
  it('walkthrough → walkthrough_performers[].user', () => {
    expect(crewPeopleOf('walkthrough', leadRaw).map((p) => p.id)).toEqual(['u-eve']);
  });
  it('empty / missing → []', () => {
    expect(crewPeopleOf('job', {})).toEqual([]);
    expect(crewPeopleOf('walkthrough', { walkthrough_performers: [] })).toEqual([]);
  });
  it('drops a wrapper row whose user is null', () => {
    expect(crewPeopleOf('job', { assignees: [{ user: null }, { user: { id: 'u-x' } }] }).map((p) => p.id)).toEqual(['u-x']);
  });
});

describe('ownerOf (commission owner — off-board)', () => {
  it('walkthrough → lead.commission_owner', () => {
    expect(ownerOf('walkthrough', leadRaw)?.id).toBe('u-eve');
  });
  it('job → estimate.lead.commission_owner (detail only)', () => {
    expect(ownerOf('job', jobRaw)?.id).toBe('u-eve');
  });
  it('null when absent (e.g. standalone job / list payload without estimate)', () => {
    expect(ownerOf('job', {})).toBeNull();
    expect(ownerOf('walkthrough', {})).toBeNull();
  });
});

describe('fullName', () => {
  it('joins and trims; null for empty', () => {
    expect(fullName({ first_name: 'A', last_name: 'B' })).toBe('A B');
    expect(fullName({ first_name: 'A' })).toBe('A');
    expect(fullName(null)).toBeNull();
    expect(fullName(undefined)).toBeNull();
    expect(fullName({})).toBeNull();
  });
});
