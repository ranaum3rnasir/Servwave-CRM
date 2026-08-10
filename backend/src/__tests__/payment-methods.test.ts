import { describe, it, expect } from 'vitest';
import {
  acceptedPaymentMethodsSchema,
  assertAcceptedPaymentMethodsValid,
  PaymentMethodsError,
  publicCardRoute,
} from '../lib/payment-methods';

describe('acceptedPaymentMethodsSchema (Zod layer)', () => {
  it('parses an empty array', () => {
    const result = acceptedPaymentMethodsSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it('parses a valid subset', () => {
    const result = acceptedPaymentMethodsSchema.safeParse([
      'CARD', 'CHECK', 'BANK_TRANSFER',
    ]);
    expect(result.success).toBe(true);
  });

  it('accepts EXTERNAL_CARD', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['EXTERNAL_CARD', 'CHECK']);
    expect(result.success).toBe(true);
  });

  it('rejects unknown values', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['CARD', 'WIRE']);
    expect(result.success).toBe(false);
  });

  it('rejects duplicate entries', () => {
    const result = acceptedPaymentMethodsSchema.safeParse(['CARD', 'CARD']);
    expect(result.success).toBe(false);
  });

  it('rejects a non-array input', () => {
    const result = acceptedPaymentMethodsSchema.safeParse('CARD' as any);
    expect(result.success).toBe(false);
  });
});

describe('assertAcceptedPaymentMethodsValid (business rules)', () => {
  it('allows EXTERNAL_CARD without Stripe charges enabled', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['EXTERNAL_CARD', 'CHECK'], false, ['EXTERNAL_CARD'])
    ).not.toThrow();
  });

  it('allows an empty submission', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid([], false, ['EXTERNAL_CARD'])
    ).not.toThrow();
  });

  // Task 1.7 re-key: the 2nd param is now the mirrored-from-Stripe `stripe_charges_enabled`
  // boolean, not the `stripe_account_id` string. This covers BOTH "Stripe never connected"
  // AND the mid-onboarding case (an account id exists but Stripe has not yet enabled
  // charges) — from this function's point of view they are the same `false` input, which
  // is exactly the point: an account id existing must NOT be enough to unlock CARD. The
  // controller-level tests (organization/invoices/estimates) cover the mid-onboarding
  // fixture with a real stripe_account_id alongside chargesEnabled=false.
  it('rejects CARD when Stripe charges are not enabled', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['CARD', 'CHECK'], false, [])
    ).toThrow(PaymentMethodsError);
    try {
      assertAcceptedPaymentMethodsValid(['CARD', 'CHECK'], false, []);
    } catch (err) {
      expect((err as PaymentMethodsError).status).toBe(400);
      // The processor's name never reaches a user-facing string (Ran, 2026-08-04): internally
      // this is Stripe, but the org only ever reads about "card payments".
      expect((err as PaymentMethodsError).message).toMatch(/card payments are not connected/i);
      expect((err as PaymentMethodsError).message).not.toMatch(/stripe/i);
    }
  });

  it('accepts CARD when Stripe charges are enabled', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['CARD', 'CHECK'], true, ['CARD', 'CHECK'])
    ).not.toThrow();
  });

  it('rejects removing CARD once Stripe charges are enabled', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['CHECK'], true, ['CARD', 'CHECK'])
    ).toThrow(PaymentMethodsError);
    try {
      assertAcceptedPaymentMethodsValid(['CHECK'], true, ['CARD', 'CHECK']);
    } catch (err) {
      expect((err as PaymentMethodsError).status).toBe(400);
      expect((err as PaymentMethodsError).message).toMatch(/cannot be disabled once card payments are connected/i);
      expect((err as PaymentMethodsError).message).not.toMatch(/stripe/i);
    }
  });

  it('allows adding CARD when charges are enabled and previous list did not include it', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['CARD', 'CHECK'], true, ['CHECK'])
    ).not.toThrow();
  });

  it('allows shuffling non-CARD methods freely when charges are enabled', () => {
    expect(() =>
      assertAcceptedPaymentMethodsValid(['CARD', 'BANK_TRANSFER'], true, ['CARD', 'CHECK'])
    ).not.toThrow();
  });

  it('allows removing CARD when charges are not enabled (previous CARD is impossible in practice, but defensive)', () => {
    // This combination shouldn't exist in real data, but the rule order is:
    //   1. submitted-CARD-without-charges-enabled → reject
    //   2. previous-CARD-with-charges-enabled-removed → reject
    // Neither fires here, so it must pass.
    expect(() =>
      assertAcceptedPaymentMethodsValid(['EXTERNAL_CARD'], false, ['CARD'])
    ).not.toThrow();
  });
});

describe('publicCardRoute (customer-page button routing)', () => {
  it('routes to STRIPE when CARD is in the list', () => {
    expect(publicCardRoute(['CARD', 'CHECK'])).toBe('STRIPE');
  });

  it('routes to STRIPE when both CARD and EXTERNAL_CARD are present (Stripe wins)', () => {
    expect(publicCardRoute(['CARD', 'EXTERNAL_CARD', 'CHECK'])).toBe('STRIPE');
  });

  it('routes to CALL_US when only EXTERNAL_CARD is present', () => {
    expect(publicCardRoute(['EXTERNAL_CARD', 'CHECK'])).toBe('CALL_US');
  });

  it('returns NONE when neither card flavor is present', () => {
    expect(publicCardRoute(['CHECK', 'BANK_TRANSFER'])).toBe('NONE');
  });

  it('returns NONE for an empty list', () => {
    expect(publicCardRoute([])).toBe('NONE');
  });
});
