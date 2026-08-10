import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MapPin, Pencil, PlusCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Location } from "@/lib/api/inventory";

type Props = {
  /** The parent location (warehouse) inside which the staging area lives. */
  parentLocation: Location | null | undefined;

  /** Current staging area value (free-form string). */
  value?: string;

  /** Fired whenever the user picks or types a new area. */
  onChange: (next: string | undefined) => void;

  /**
   * Compact mode renders just a clickable pill — good for inline placement
   * inside a stage card row. Default = full dropdown surface.
   */
  compact?: boolean;

  /** Optional className override for the wrapper. */
  className?: string;
};

/**
 * StagingAreaPicker — small dropdown that lets the warehouse manager pick
 * which zone inside a warehouse a staged job is sitting in. Sources options
 * from `parentLocation.stagingAreas` and also offers an inline "Add custom
 * area…" path so any floor-plan tweak doesn't need a settings trip.
 */
export function StagingAreaPicker({
  parentLocation,
  value,
  onChange,
  compact,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Position the portalled panel relative to the trigger so it tracks the
  // page (scroll / resize) without being clipped by any overflow-hidden
  // ancestor (the stage card, the scrollable list container, modals, etc.).
  const [panelPos, setPanelPos] = useState<{
    top: number;
    left: number;
    width: number;
    placeAbove: boolean;
    maxHeight: number;
  } | null>(null);

  function recomputePosition() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const PANEL_W = 288; // w-72 ≈ 18rem
    const MARGIN = 8;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    // Right-align under trigger by default; flip up when there's no room below.
    const spaceBelow = viewportH - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const placeAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      480,
      Math.max(220, (placeAbove ? spaceAbove : spaceBelow) - MARGIN),
    );
    // Default: right edge of panel = right edge of trigger; clamp into viewport.
    let left = rect.right - PANEL_W;
    if (left < MARGIN) left = MARGIN;
    if (left + PANEL_W > viewportW - MARGIN) left = viewportW - PANEL_W - MARGIN;
    const top = placeAbove ? rect.top - MARGIN : rect.bottom + 4;
    setPanelPos({ top, left, width: PANEL_W, placeAbove, maxHeight });
  }

  const presets = useMemo(
    () => parentLocation?.stagingAreas ?? [],
    [parentLocation?.stagingAreas],
  );

  // Include the current custom value (if any) in the list so users see it
  // as the active selection even when it's not in the configured presets.
  const allOptions = useMemo(() => {
    if (!value) return presets;
    if (presets.includes(value)) return presets;
    return [value, ...presets];
  }, [value, presets]);

  // Close on outside click (panel is portalled so check against both refs).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
      setEditing(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setEditing(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Recompute panel position on open + on window resize / ancestor scroll so
  // the portalled panel stays glued to its trigger.
  useLayoutEffect(() => {
    if (!open) return;
    recomputePosition();
    const onScroll = () => recomputePosition();
    const onResize = () => recomputePosition();
    window.addEventListener("scroll", onScroll, true); // capture: catch ancestor scrolls
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function pick(next: string | undefined) {
    onChange(next);
    setOpen(false);
    setEditing(false);
  }

  function saveCustom() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Persist the new area as a preset on the parent location so future
    // stages in the same warehouse see it as a configured option, not just
    // a one-off on this stage. In production this is a
    // `PATCH /inventory_locations/{id}` writing `staging_areas` — for the
    // v1 prototype we mutate the in-memory array (it's the same `locations`
    // object referenced everywhere in the app).
    if (parentLocation && !parentLocation.stagingAreas?.includes(trimmed)) {
      parentLocation.stagingAreas = [
        ...(parentLocation.stagingAreas ?? []),
        trimmed,
      ];
    }
    pick(trimmed);
    setDraft("");
  }

  // If there's no parent location at all, render an inactive hint.
  if (!parentLocation) {
    return (
      <span className={`text-[11px] italic text-secondary-dark ${className ?? ""}`}>
        Set a staging location first to pick an area
      </span>
    );
  }

  const triggerLabel = value || "Pick a staging area";

  return (
    <div
      ref={ref}
      className={`relative inline-block ${className ?? ""}`}
      onClick={(e) => {
        // Prevent the picker (and the dropdown panel below it) from bubbling
        // clicks up to any parent row / card that opens a detail view on
        // click. The picker is its own interactive surface.
        e.stopPropagation();
      }}
    >
      {/* Not converted to Button: two-state pill (primary-subtle/warning ring)
          has no matching variant/tone cell. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={[
          "inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium transition",
          compact
            ? "px-2 py-0.5"
            : "px-2.5 py-1",
          value
            ? "bg-primary-subtle text-primary ring-1 ring-primary/30 hover:bg-primary-subtle/80"
            : "bg-warning/10 text-warning ring-1 ring-warning/20 hover:bg-warning/10",
        ].join(" ")}
        title={
          value
            ? `Staged in: ${value} (click to change)`
            : "Pick where in the warehouse"
        }
      >
        <MapPin className="h-3 w-3" />
        {triggerLabel}
        <span className="text-[9px] opacity-60">▼</span>
      </button>

      {open &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[100] flex flex-col overflow-hidden rounded-md border border-border bg-surface-light shadow-xl"
            style={{
              top: panelPos.placeAbove ? undefined : panelPos.top,
              bottom: panelPos.placeAbove
                ? window.innerHeight - panelPos.top
                : undefined,
              left: panelPos.left,
              width: panelPos.width,
              maxHeight: panelPos.maxHeight,
            }}
            role="listbox"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — fixed */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border bg-background-light/60 px-3 py-1.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Staging area in {parentLocation.name}
                </p>
                <p className="text-[10px] text-text-secondary">
                  {presets.length} preset
                  {presets.length === 1 ? "" : "s"} configured for this warehouse
                </p>
              </div>
            </div>

            {/* "+ Add new staging area" — fixed, always visible above the
                scrollable preset list so a new zone is one click away. */}
            <div className="flex-shrink-0 border-b border-primary/20 bg-primary-subtle/40 p-2">
              {editing ? (
                <div>
                  {/* Not converted to FormField: the sibling below is an
                      input+button pair, not a single control FormField's
                      cloneElement can id, and outside the checkbox/select
                      render-prop precedent this batch adopts elsewhere. */}
                  <label className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-primary">
                    New staging area
                  </label>
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveCustom();
                        if (e.key === "Escape") {
                          setEditing(false);
                          setDraft("");
                        }
                      }}
                      placeholder="e.g. Mezzanine Bin 4"
                      className="flex-1 px-2 py-1 text-[11px]"
                    />
                    <Button
                      type="button"
                      onClick={saveCustom}
                      disabled={!draft.trim()}
                      size="3xs"
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        setEditing(false);
                        setDraft("");
                      }}
                      variant="ghost"
                      tone="subtle"
                      size="3xs"
                      title="Cancel"
                    >
                      ✕
                    </Button>
                  </div>
                  <p className="mt-1 text-[9px] italic text-primary/80">
                    Saved areas become presets for every future stage in {parentLocation.name}.
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  onClick={() => setEditing(true)}
                  size="sm"
                  className="w-full"
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Add new staging area
                </Button>
              )}
            </div>

            {/* Preset list — scrollable, fills remaining panel height */}
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {allOptions.length === 0 ? (
                <p className="px-3 py-2 text-[11px] italic text-text-secondary">
                  No areas configured yet. Use the button above to add one.
                </p>
              ) : (
                allOptions.map((opt) => {
                  const isActive = value === opt;
                  return (
                    // Not converted to Button: listbox-option row (role="listbox"
                    // parent above), not a Button shape.
                    <button
                      key={opt}
                      type="button"
                      onClick={() => pick(opt)}
                      className={[
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px]",
                        isActive
                          ? "bg-primary-subtle font-semibold text-primary"
                          : "text-text-secondary hover:bg-background-light",
                      ].join(" ")}
                    >
                      <span className="truncate">{opt}</span>
                      {isActive && (
                        <Check className="h-3 w-3 flex-shrink-0 text-primary" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Clear action — pinned to bottom of panel when a value is set */}
            {value && (
              <Button
                type="button"
                onClick={() => pick(undefined)}
                variant="ghost"
                tone="danger"
                size="3xs"
                className="w-full justify-start flex-shrink-0"
              >
                Clear staging area
              </Button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Read-only display of "Warehouse · Area" with a small Pencil affordance.
 * Useful in the doc preview header where we want a compact summary, not the
 * full dropdown trigger.
 */
export function StagingAreaInline({
  parentLocationName,
  area,
  onEdit,
}: {
  parentLocationName: string;
  area?: string;
  onEdit?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
      <MapPin className="h-3 w-3 text-text-secondary" />
      {parentLocationName}
      {area ? (
        <>
          <span className="text-text-secondary">·</span>
          <span className="font-medium text-text-primary">{area}</span>
        </>
      ) : null}
      {onEdit && (
        // Not converted to Button: idle-secondary/hover-brand icon with no
        // hover background has no matching ghost cell.
        <button
          type="button"
          onClick={onEdit}
          className="ml-0.5 inline-flex items-center text-text-secondary hover:text-primary"
          title="Change staging area"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
