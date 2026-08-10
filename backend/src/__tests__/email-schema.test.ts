import { describe, it, expect } from 'vitest';
import { emailSchema } from '../lib/email-schema';

describe('emailSchema (canonical email input gate)', () => {
  it('lowercases mixed-case input', () => {
    expect(emailSchema.parse('Sagiv@example.com')).toBe('sagiv@example.com');
  });

  it('trims surrounding whitespace then lowercases', () => {
    expect(emailSchema.parse('  Dana@Alpha.COM ')).toBe('dana@alpha.com');
  });

  it('leaves an already-normalized email unchanged', () => {
    expect(emailSchema.parse('jordan@example.com')).toBe('jordan@example.com');
  });

  it('rejects a non-email', () => {
    expect(() => emailSchema.parse('not-an-email')).toThrow();
  });
});
