"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Button } from "@/ui-kit/components/ui/button";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/ui-kit/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui-kit/components/ui/popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line - an address, an email, a role. */
  hint?: string;
  icon?: React.ReactNode;
  group?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  /**
   * `role="combobox"` (below) computes its accessible name from `aria-label`/
   * `aria-labelledby` ONLY - unlike a plain button, it does NOT fall back to the trigger's
   * own text content (ARIA's `nameFrom: author` for this role). A caller with no adjacent
   * `<Label htmlFor>` needs this or the control is unlabelled to assistive tech even though
   * the placeholder is visibly right there.
   */
  "aria-label"?: string;
}

/**
 * Searchable single-select.
 *
 * Rule of thumb: under ~8 options use <Select>; past that, people scan slower
 * than they type and a Select becomes a scrolling chore. Every CRM picker that
 * holds customers, technicians or sites belongs here.
 *
 * Width is pinned to the trigger via --radix-popover-trigger-width so the panel
 * never jumps around as results filter.
 */
function Combobox({
  options, value, onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No results found.",
  disabled, invalid, className, id, "aria-label": ariaLabel,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);
  const wheelCleanupRef = React.useRef<(() => void) | null>(null);

  /**
   * Wheel-scroll fix (SERV10X QA finding: the "Add team member…" list in the New
   * Event dialog opened but a mouse wheel over it did nothing).
   *
   * Root cause: the popover portals to `document.body` (Radix default), which
   * places it OUTSIDE the DOM subtree a modal <Dialog> registers as its
   * scroll-lock shard (`react-remove-scroll` only exempts `DialogContent`
   * itself - see `@radix-ui/react-dialog`'s `shards: [context.contentRef]`).
   * Any wheel event outside that shard gets `preventDefault()`'d by a
   * `document`-level capture listener the Dialog installs, so the list's own
   * `overflow-y-auto` (already correct on `CommandList`) never gets a native
   * scroll to run. Keyboard arrows still work because cmdk drives those with
   * `scrollIntoView`, not a wheel event - which is why this reads as "opens
   * fine, arrows work, mouse wheel does nothing."
   *
   * Driving `scrollTop` ourselves sidesteps the lock entirely, since it never
   * depends on the browser's native scroll running. That has to happen from a
   * real, non-passive `addEventListener('wheel', …)` rather than the JSX
   * `onWheel` prop: React always attaches its own delegated wheel listener as
   * `{ passive: true }` when the browser supports it, and that is not
   * configurable per element - `preventDefault()` called from inside a React
   * `onWheel` handler can never take effect, and only logs "Unable to
   * preventDefault inside passive event listener invocation" on every tick.
   * `preventDefault` here keeps this from double-scrolling when the combobox
   * is NOT nested inside a modal (native scroll would otherwise also fire on
   * the same event).
   *
   * A callback ref, not a `useEffect` keyed on `open`: Radix's Popover mounts
   * `PopoverContent` through its own Presence/Popper machinery, which does not
   * necessarily land in the DOM within the same commit our `open` state flips
   * in (position has to be measured first). An effect keyed on `[open]` can
   * run before that content exists and then never re-run once it does. A
   * callback ref sidesteps that entirely - React calls it exactly when this
   * div is actually inserted into (or removed from) the DOM, whatever that
   * timing turns out to be, and by then every one of its children (including
   * `CommandList`) is already present in its subtree.
   */
  const setListContainer = React.useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!node) return;

    const list = node.querySelector<HTMLElement>('[data-slot="command-list"]');
    if (!list) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      list.scrollTop += event.deltaY;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => list.removeEventListener("wheel", onWheel);
  }, []);

  const groups = React.useMemo(() => {
    const map = new Map<string, ComboboxOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(option);
    }
    return [...map.entries()];
  }, [options]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "w-full justify-between px-3 font-normal",
            !selected && "text-subtle-foreground",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon}
            <span className="truncate">{selected?.label ?? placeholder}</span>
          </span>
          <ChevronsUpDown className="text-subtle-foreground size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        {/* Plain host div, not another ui-kit wrapper: it exists solely so
            `setListContainer` above has an unambiguous DOM node to query
            `[data-slot="command-list"]` from, scoped to this one popover
            instance. */}
        <div ref={setListContainer}>
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              {groups.map(([group, items]) => (
                <CommandGroup key={group} heading={group || undefined}>
                  {items.map((option) => (
                    <CommandItem
                      key={option.value}
                      // Search the hint too - people look up a site by address
                      // as often as by customer name.
                      value={`${option.label} ${option.hint ?? ""}`}
                      disabled={option.disabled}
                      onSelect={() => {
                        onValueChange?.(option.value === value ? "" : option.value);
                        setOpen(false);
                      }}
                    >
                      {option.icon}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{option.label}</span>
                        {option.hint && (
                          <span className="text-subtle-foreground truncate text-[11.5px] font-normal">
                            {option.hint}
                          </span>
                        )}
                      </span>
                      <Check className={cn("text-brand ml-auto size-4 stroke-[3]", option.value !== value && "opacity-0")} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };
