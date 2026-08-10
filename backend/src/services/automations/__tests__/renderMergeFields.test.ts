import { describe, it, expect } from 'vitest';
import { renderMergeFields } from '../renderMergeFields';

const CTX: Record<string, string> = {
  'customer.first_name': 'Sarah',
  'org.name': 'Blue Ridge Plumbing',
  'job.scheduled_time': '9:00 AM',
};

describe('renderMergeFields', () => {
  it('substitutes known fields', () => {
    expect(renderMergeFields('Hi {{customer.first_name}}, from {{org.name}}!', CTX, { html: false }))
      .toBe('Hi Sarah, from Blue Ridge Plumbing!');
  });

  it('leaves unknown fields literal so typos are visible to the author', () => {
    expect(renderMergeFields('Hi {{customer.frist_name}}!', CTX, { html: false }))
      .toBe('Hi {{customer.frist_name}}!');
  });

  it('renders known-but-empty values as empty string', () => {
    expect(renderMergeFields('Time: {{job.scheduled_time}}', { 'job.scheduled_time': '' }, { html: false }))
      .toBe('Time: ');
  });

  it('escapes values in html mode (user-controlled names cannot inject markup)', () => {
    const ctx = { 'customer.first_name': '<script>alert(1)</script>' };
    const out = renderMergeFields('Hi {{customer.first_name}}', ctx, { html: true });
    expect(out).toBe('Hi &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not escape in plain-text mode (SMS keeps raw characters)', () => {
    const ctx = { 'customer.first_name': "O'Brien & Sons" };
    expect(renderMergeFields('{{customer.first_name}}', ctx, { html: false }))
      .toBe("O'Brien & Sons");
  });

  it('handles repeated fields and adjacent braces', () => {
    expect(renderMergeFields('{{org.name}} {{org.name}}', CTX, { html: false }))
      .toBe('Blue Ridge Plumbing Blue Ridge Plumbing');
  });

  it('does NOT resolve inherited Object.prototype keys — {{constructor}}/{{__proto__}} stay literal', () => {
    expect(renderMergeFields('a {{constructor}} b', CTX, { html: false })).toBe('a {{constructor}} b');
    expect(renderMergeFields('a {{__proto__}} b', CTX, { html: false })).toBe('a {{__proto__}} b');
  });
});
