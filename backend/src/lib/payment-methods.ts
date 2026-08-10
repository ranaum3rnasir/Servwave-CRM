import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';

export const ALL_PAYMENT_METHODS: PaymentMethod[] = [
  'CARD',
  'EXTERNAL_CARD',
  'CASH',
  'CHECK',
  'BANK_TRANSFER',
  // R5b (2026-07-22) — D3.
  'ZELLE',
  'VENMO',
  'CASH_APP',
  'OTHER',
];

export const acceptedPaymentMethodsSchema = z
  .array(z.nativeEnum(PaymentMethod))
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'accepted_payment_methods must not contain duplicates',
  });

export class PaymentMethodsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'PaymentMethodsError';
  }
}

export function assertAcceptedPaymentMethodsValid(
  submitted: PaymentMethod[],
  chargesEnabled: boolean,
  previous: PaymentMethod[],
): void {
  // `hasStripe` keeps the processor's name because that is what this flag actually means -
  // Stripe Connect charges being enabled on the org's account. The MESSAGES below deliberately
  // do not: they are returned to the API and rendered verbatim as UI toasts, and the org is
  // never shown which processor sits behind card payments (Ran, 2026-08-04). Internal naming
  // stays honest, user-facing copy stays about the capability.
  const hasStripe = chargesEnabled;
  const submittedHasCard = submitted.includes('CARD');
  const previousHasCard = previous.includes('CARD');

  if (submittedHasCard && !hasStripe) {
    throw new PaymentMethodsError(
      400,
      'Cannot enable Credit Card - card payments are not connected for this organization.',
    );
  }

  if (hasStripe && previousHasCard && !submittedHasCard) {
    throw new PaymentMethodsError(
      400,
      'Credit Card cannot be disabled once card payments are connected.',
    );
  }
}

export function publicCardRoute(
  sendConfigMethods: PaymentMethod[],
): 'STRIPE' | 'CALL_US' | 'NONE' {
  if (sendConfigMethods.includes('CARD')) return 'STRIPE';
  if (sendConfigMethods.includes('EXTERNAL_CARD')) return 'CALL_US';
  return 'NONE';
}
