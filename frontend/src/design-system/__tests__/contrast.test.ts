import { describe, it, expect } from 'vitest';
import { contrastRatio, compositeOver, rgbDistance } from '../contrast';
import { token } from '../tokens';
import { EVENT_TYPE_META, type EventType } from '@/components/schedule/scheduleModel';

// The two describe blocks below this line test the HELPER FUNCTIONS with hardcoded hex
// literals - they prove contrastRatio/compositeOver/rgbDistance compute the right numbers, and
// nothing else. They do NOT move if a token in tokens.css/tokens.ts changes, so they cannot be
// the thing that catches a token regressing into an AA failure - that was exactly how the
// original --bronze-600 defect shipped (a number computed once, by hand, off to one side, never
// re-checked against a live value). The regression guards that DO read live tokens are further
// down this file, under "the LIVE design tokens".

describe('contrastRatio', () => {
  it('black vs white → 21:1 (the WCAG maximum)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });
  it('identical colors → 1:1 (no contrast)', () => {
    expect(contrastRatio('#5A5A2E', '#5A5A2E')).toBeCloseTo(1, 5);
  });
  it('is symmetric — argument order does not change the ratio', () => {
    expect(contrastRatio('#5A5A2E', '#EEF1F3')).toBeCloseTo(contrastRatio('#EEF1F3', '#5A5A2E'), 5);
  });
  it('a known WCAG-documented pair: #767676 on white is exactly 4.5:1', () => {
    // The canonical "just passes AA" grey from the WCAG spec itself.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.5, 1);
  });
});

describe('compositeOver', () => {
  it('alpha 1 → the foreground, unchanged', () => {
    expect(compositeOver('#5A5A2E', 1, '#EEF1F3')).toBe('#5a5a2e');
  });
  it('alpha 0 → the background, unchanged', () => {
    expect(compositeOver('#5A5A2E', 0, '#EEF1F3')).toBe('#eef1f3');
  });
  it('a 10% tint over a light canvas stays close to the canvas, not the foreground', () => {
    const mixed = compositeOver('#5A5A2E', 0.1, '#EEF1F3');
    // Sanity: the mixed color sits nearer the light canvas than the dark foreground.
    expect(rgbDistance(mixed, '#EEF1F3')).toBeLessThan(rgbDistance(mixed, '#5A5A2E'));
  });
});

describe('rgbDistance', () => {
  it('identical colors → 0', () => expect(rgbDistance('#5A5A2E', '#5A5A2E')).toBe(0));
  it('black vs white → the maximum, ≈441.67', () =>
    expect(rgbDistance('#000000', '#FFFFFF')).toBeCloseTo(441.67, 1));
});

/**
 * The LIVE design tokens (regression guard, calendar-entries §9 risk 4).
 *
 * `token()` resolves through tokens.ts's FALLBACKS map under vitest — frontend/vitest.config.ts
 * sets `css: false`, so no real stylesheet is ever loaded here, and FALLBACKS is kept honest by
 * the tokens-fallback-drift guard. So unlike the describes above, these tests MOVE when
 * tokens.css/tokens.ts change: proven by reverting `--event` to the original failing bronze
 * (139 111 71 / #8B6F47) and re-running this file — both tests below went red at 3.696:1 and
 * 23.6 (the exact numbers the defect shipped with), then green again on restore.
 */
describe('contrastRatio × the LIVE --event token', () => {
  const CANVAS = token('--background-light'); // the board canvas the card composites over
  const eventHex = token('--event');

  it('text-event on its own real 5% board tint (EVENT_TYPE_META\'s bg-event/5) clears WCAG AA', () => {
    expect(contrastRatio(eventHex, compositeOver(eventHex, 0.05, CANVAS))).toBeGreaterThanOrEqual(4.5);
  });
  it('text-event on its own real 10% board tint (SchedulePage.tsx\'s bg-event/10) clears WCAG AA', () => {
    expect(contrastRatio(eventHex, compositeOver(eventHex, 0.10, CANVAS))).toBeGreaterThanOrEqual(4.5);
  });
  it('the 10% tint does not collapse into the completed treatment\'s fill (neutral-surface)', () => {
    const tint10 = compositeOver(eventHex, 0.10, CANVAS);
    expect(rgbDistance(tint10, token('--neutral-surface'))).toBeGreaterThan(25);
  });
  it('stays separated from warning/amber — the near-collision (79.4/441) the old bronze shipped with', () => {
    expect(rgbDistance(eventHex, token('--warning'))).toBeGreaterThan(60);
  });
});

/**
 * Generalises the --event check across every EVENT_TYPE_META accent (§9 risk 4's real scope):
 * ANY board accent painted as a low-alpha tint over the canvas has the same trap --event shipped
 * with, and this table makes that mechanical rather than something the next person has to
 * remember to re-derive by hand.
 *
 * Measured while building this guard: job/walkthrough/service-plan (info/warning/ai) ALL
 * currently fail AA on their own 10% tint too — 2.92:1 / 3.88:1 / 3.26:1, the exact figures
 * tokens.css's own STATUS_SCALE comment already cites as the reason the badge quartet exists
 * ("FAILS WCAG AA in every family... measured: 4.38 on white... down to 2.92 for info"). That is
 * a real, pre-existing defect spanning the whole scheduler board, not something this task
 * introduced — but re-tuning three tokens used across the entire app is a materially bigger,
 * riskier change than the one --event needed, so it is flagged as a follow-up (see the spawned
 * task alongside this commit) rather than silently absorbed here.
 *
 * `knownFailing` is the ratchet: it pins today's actual state so a change either direction is
 * caught — a regression on `event` (knownFailing: false) fails loud, same as above, and a FIX
 * landing for job/walkthrough/service-plan trips its `knownFailing: true` assertion, which is
 * the prompt to flip it to false rather than "fix the test" back to green.
 */
describe('EVENT_TYPE_META board accents — AA on their real 10% composite tint (table-driven)', () => {
  const CANVAS = token('--background-light');
  const cases: { type: EventType; label: string; tokenVar: string; knownFailing: boolean }[] = [
    { type: 'job', label: 'job (info)', tokenVar: '--info', knownFailing: true },
    { type: 'walkthrough', label: 'walkthrough (warning)', tokenVar: '--warning', knownFailing: true },
    { type: 'service-plan', label: 'service-plan (ai)', tokenVar: '--ai', knownFailing: true },
    { type: 'calendar-entry', label: 'calendar-entry (event)', tokenVar: '--event', knownFailing: false },
  ];

  for (const { type, label, tokenVar, knownFailing } of cases) {
    it(`${label}: EVENT_TYPE_META label "${EVENT_TYPE_META[type].label}" — AA ${knownFailing ? 'still fails (pre-existing, tracked, not fixed by this task)' : 'clears 4.5:1'}`, () => {
      const hex = token(tokenVar);
      const ratio = contrastRatio(hex, compositeOver(hex, 0.10, CANVAS));
      if (knownFailing) {
        expect(ratio).toBeLessThan(4.5);
      } else {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
