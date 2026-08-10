import { describe, it, expect } from 'vitest';
import { AI_AGENTS } from './agents';

// The AI Center catalog is pre-sale copy for agents that are not built yet
// (see the file header of agents.ts). Two entries used to describe capabilities
// no schema column can back: Border Collie claimed skill/location-based
// auto-assignment, and Gecko claimed drive time, miles, tolls and traffic
// optimisation. Nothing geocodes a user, customer, service location or job, and
// there is no competency field anywhere, so these guards pin the absence.
//
// Scoped to whole entries, not single lines: AgentDetailModal renders every
// element of longDescription as a bullet in one list, so a corrected sentence
// sitting above an uncorrected one is still a contradiction on screen.

const mike = AI_AGENTS.find((a) => a.id === 'mike')!;
const leo = AI_AGENTS.find((a) => a.id === 'leo')!;

function entryStrings(agent: typeof mike): string[] {
  return [agent.tagline, agent.shortDescription, ...agent.longDescription];
}

// Exactly the strings this change authors. Deliberately narrower than the whole
// entries: the house-style hyphen rule binds lines we write, and agents.ts
// carries em dashes on dozens of lines this change does not touch.
const REWRITTEN = [
  mike.shortDescription,
  ...mike.longDescription.slice(0, 4),
  leo.tagline,
  leo.shortDescription,
  ...leo.longDescription,
];

describe('AI Center catalog copy claims only what the product can back', () => {
  it("Border Collie's whole entry claims only what the schema backs", () => {
    const forbidden = [
      /skill/i,
      /location/i,
      /auto-?assign/i,
      /priority/i,
      /performance/i,
      /full auto/i,
      /instant assignment/i,
      /traffic/i,
    ];
    for (const line of entryStrings(mike)) {
      for (const pattern of forbidden) {
        expect(line).not.toMatch(pattern);
      }
    }
  });

  it("Gecko's whole entry claims only what the schema backs", () => {
    const forbidden = [
      /drive time/i,
      /\bmiles\b/i,
      /tolls?/i,
      /bridges?/i,
      /traffic/i,
      /fuel/i,
      /\bETAs?\b/,
      /windshield/i,
    ];
    for (const line of entryStrings(leo)) {
      for (const pattern of forbidden) {
        expect(line).not.toMatch(pattern);
      }
    }
  });

  it('the catalog strings this change rewrites use plain hyphens', () => {
    for (const line of REWRITTEN) {
      expect(line).not.toMatch(/[—–]/);
    }
  });
});
