/**
 * Combobox - the dropdown list must stay scrollable by mouse wheel even when the
 * combobox is opened inside a modal <Dialog> (SERV10X calendar-entries QA finding:
 * the "Add team member…" list in the New Event dialog opened but a mouse wheel over
 * it did nothing).
 *
 * Root cause (traced through @radix-ui/react-dialog + react-remove-scroll source, not
 * guessed): a modal Dialog wraps its content in `RemoveScroll` with
 * `shards: [context.contentRef]` - i.e. it only exempts the Dialog's own content node
 * from its scroll lock. The Popover this Combobox renders portals to `document.body`
 * by default (Radix's default Portal container), which puts it OUTSIDE that shard.
 * `react-remove-scroll` installs a `document`-level, capture-phase `wheel` listener
 * that calls `preventDefault()` on any wheel event whose target isn't inside the
 * Dialog's shard - so the list's own `overflow-y-auto` (present and correctly bounded
 * already) never gets a chance to run its native scroll. Keyboard arrows still work
 * because cmdk drives those via `scrollIntoView`, not a wheel event - which is exactly
 * why QA saw "opens fine, arrows work, wheel does nothing."
 *
 * First pass drove `scrollTop` from the JSX `onWheel` prop and called
 * `event.preventDefault()` there. Real-browser QA caught that this is dead code: React
 * always attaches its own delegated `wheel` listener as `{ passive: true }` when the
 * browser supports it (not configurable per element), so `preventDefault()` inside a
 * React `onWheel` handler can never take effect - it only logged "Unable to
 * preventDefault inside passive event listener invocation" once per tick. The fix
 * attaches a real listener directly to the list node with `addEventListener('wheel',
 * …, { passive: false })` in a `useEffect`, which is the only way to make
 * `preventDefault()` actually take effect.
 *
 * jsdom does not run real layout or perform real scrolling, so a test cannot prove the
 * wheel visibly moves the list on screen - a human confirms that in a browser. What
 * these tests assert instead is the structural fix: the list is a bounded, overflow-y
 * scrollable region (unchanged - it was never the problem); a wheel event drives
 * `scrollTop` directly; and - the part that actually matters after the browser
 * finding - the handler reaches the DOM through a genuine non-passive
 * `addEventListener` call, not the JSX prop React forces passive.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Combobox, type ComboboxOption } from './combobox';

const OPTIONS: ComboboxOption[] = [
  { value: 'alice', label: 'Alice Anders' },
  { value: 'bob', label: 'Bob Baker' },
  { value: 'cara', label: 'Cara Chu' },
];

function setup(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  const onValueChange = vi.fn();
  const utils = render(
    <Combobox
      options={OPTIONS}
      onValueChange={onValueChange}
      aria-label="Add team member"
      {...props}
    />,
  );
  return { onValueChange, ...utils };
}

async function openList() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Add team member' }));
  return user;
}

describe('Combobox', () => {
  it('renders the list as a bounded, overflow-y scrollable region', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]');
    expect(list).toBeInTheDocument();
    // max-h-64 + overflow-y-auto is what makes the list a scroll container at
    // all once its content outgrows the bound - both were already present
    // before this fix and are not what QA's bug was about.
    expect(list?.className).toMatch(/max-h-64/);
    expect(list?.className).toMatch(/overflow-y-auto/);
  });

  it('drives scrollTop from a wheel event instead of relying only on native scroll', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true });

    fireEvent.wheel(list, { deltaY: 40 });

    // This is the mechanism that survives an ancestor modal's scroll-lock
    // calling preventDefault() on the same event: the list moves via a JS
    // assignment we own, not via the browser's native wheel-scroll action,
    // which is exactly what a Dialog's react-remove-scroll shard check can
    // (and here, does) suppress.
    expect(list.scrollTop).toBe(40);
  });

  it('wires the scroll handler as a real, non-passive addEventListener call - not the JSX onWheel prop React forces passive', async () => {
    const calls: { target: EventTarget; type: string; options: unknown }[] = [];
    const original = EventTarget.prototype.addEventListener;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      handler: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      calls.push({ target: this, type, options });
      return original.call(this, type, handler, options);
    });

    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;

    // The bug QA found is specifically that a JSX `onWheel` prop's preventDefault()
    // is dead code, because React always registers ITS OWN delegated wheel listener
    // as passive. Proving the fix means proving the list's own scroll handler is a
    // separate, real DOM listener explicitly opted out of that - not that some
    // "wheel" listener merely exists somewhere.
    const wheelListener = calls.find(
      (call) => call.target === list && call.type === 'wheel',
    );
    expect(wheelListener).toBeDefined();
    expect(wheelListener?.options).toMatchObject({ passive: false });
  });

  it('actually prevents the wheel event default through that listener', async () => {
    setup();
    await openList();

    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;
    const event = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent;
    Object.defineProperty(event, 'deltaY', { value: 40 });

    list.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('keyboard navigation and selection still work unchanged', async () => {
    const { onValueChange } = setup();
    const user = await openList();

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('bob');
  });

  it('type-ahead filtering still narrows the list', async () => {
    setup();
    const user = await openList();

    await user.type(screen.getByPlaceholderText('Search…'), 'Cara');

    expect(screen.getByText('Cara Chu')).toBeInTheDocument();
    expect(screen.queryByText('Alice Anders')).not.toBeInTheDocument();
  });
});
