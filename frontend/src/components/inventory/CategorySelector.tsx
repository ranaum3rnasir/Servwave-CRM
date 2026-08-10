import { useState } from "react";
import { Check, ChevronDown, FolderTree, Pencil, Plus, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { Category, Item } from "@/lib/api/inventory";

type Props = {
  categories: Category[];
  items: Item[];
  /** "all" or a category name (matches Item.category) */
  activeName: string;
  onChange: (name: string) => void;
  onAddNew: () => void;
  /**
   * Admin actions on each row — Edit + Delete. When `canManage` is false the
   * row stays read-only (techs see view-only). The parent owns persistence
   * (rename + propagation to items, delete-blocked-when-in-use, etc.) so this
   * component just signals intent.
   */
  canManage?: boolean;
  onEditCategory?: (cat: Category) => void;
  onDeleteCategory?: (cat: Category) => unknown;
};

/**
 * Pill + dropdown selector for the Inventory "Showing" row. Sits next to the
 * LocationSelector and filters items by their `category` field. Lists every
 * configured category with a live item count + an inline "Add new category"
 * link at the bottom for one-click taxonomy growth. Per-row hover shows the
 * description so the operator can pick the right bucket without leaving the
 * dropdown.
 */
export function CategorySelector({
  categories,
  items,
  activeName,
  onChange,
  onAddNew,
  canManage,
  onEditCategory,
  onDeleteCategory,
}: Props) {
  const [open, setOpen] = useState(false);

  const totalMaterials = items.filter((i) => i.kind === "material").length;
  const activeCount =
    activeName === "all"
      ? totalMaterials
      : items.filter((i) => i.category === activeName).length;
  const activeLabel = activeName === "all" ? "All Categories" : activeName;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Raw by design: PopoverTrigger asChild clones + ref-forwards onto this
            element - a Button primitive swap here is the never-convert asChild
            trigger shape. */}
        <button
          className={[
            "inline-flex items-center gap-2 rounded-md border bg-surface-light px-3 py-1.5 text-left text-xs font-medium transition hover:bg-background-light",
            open || activeName !== "all"
              ? "border-primary ring-2 ring-primary/20"
              : "border-border",
          ].join(" ")}
          title="Filter items by category"
        >
          <FolderTree className="h-3.5 w-3.5 text-primary" />
          <span className="flex flex-col">
            <span className="text-sm font-semibold text-text-primary">
              {activeLabel}
            </span>
            <span className="text-[10px] text-text-secondary">
              {categories.length} categories configured
            </span>
          </span>
          <span className="ml-1 rounded bg-background-light px-1.5 py-0.5 text-[10px] font-mono font-semibold text-text-secondary">
            {activeCount}
          </span>
          <ChevronDown
            className={[
              "h-3.5 w-3.5 text-text-secondary transition",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={4}
        role="listbox"
        // `border` dropped: PopoverContent's own base string already emits
        // an unconditional `border border-border` - this was a byte-for-byte
        // redundant restatement, not an override.
        className="flex max-h-[420px] w-72 flex-col overflow-hidden p-0"
      >
        {/* Sticky header — "All Categories" reset row. Raw by design: a
            role="listbox" row / list-row click target, not Button-shaped. */}
        <button
          type="button"
          onClick={() => {
            onChange("all");
            setOpen(false);
          }}
          className={[
            "flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-2 text-left text-xs",
            activeName === "all"
              ? "bg-primary-subtle font-semibold text-primary-dark"
              : "bg-background-light/60 text-text-secondary hover:bg-background-light",
          ].join(" ")}
        >
          <span className="flex items-center gap-2">
            <FolderTree className="h-3.5 w-3.5 text-primary" />
            All Categories
          </span>
          <span className="flex items-center gap-2">
            <span className="rounded bg-surface-light px-1.5 py-0.5 font-mono text-[10px] text-text-secondary ring-1 ring-border">
              {totalMaterials}
            </span>
            {activeName === "all" && <Check className="h-3.5 w-3.5 text-primary" />}
          </span>
        </button>

        {/* Scrollable category list */}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {categories.length === 0 ? (
            <p className="px-3 py-3 text-[11px] italic text-text-secondary">
              No categories configured yet. Use the button below to add one.
            </p>
          ) : (
            categories.map((c) => {
              const isActive = activeName === c.name;
              return (
                <div
                  key={c.id}
                  className={[
                    "group flex items-center gap-2 px-3 py-1.5 text-[11px]",
                    isActive
                      ? "bg-primary-subtle font-semibold text-primary-dark"
                      : "text-text-secondary hover:bg-background-light",
                  ].join(" ")}
                >
                  {/* Primary row click — picks the category as the active
                      filter. Per-row count badge was removed (rev 2026-05-27)
                      — the operator clicks the row to see the items. Raw by
                      design: a list-row click target, not Button-shaped. */}
                  <button
                    type="button"
                    onClick={() => {
                      onChange(c.name);
                      setOpen(false);
                    }}
                    title={c.description ?? ""}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{c.name}</span>
                      {c.description && (
                        <span className="truncate text-[9px] font-normal text-text-secondary">
                          {c.description}
                        </span>
                      )}
                    </span>
                    {isActive && (
                      <Check className="ml-auto h-3 w-3 flex-shrink-0 text-primary" />
                    )}
                  </button>

                  {/* Admin-only inline actions — hidden until row hover so
                      the dropdown stays clean for view-only users. */}
                  {canManage && (
                    <span className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                      {/* Raw by design: hover treatment is a primary-tinted
                          bg+text pairing that no minted ghost cell reproduces
                          (ghost/neutral and ghost/subtle both hover to
                          background-light/text-text-primary, not
                          primary-subtle/text-primary) — converting would
                          silently change the hover colour. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditCategory?.(c);
                        }}
                        className="rounded p-1 text-text-secondary hover:bg-primary-subtle hover:text-primary"
                        title={`Edit "${c.name}"`}
                        aria-label={`Edit ${c.name}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        tone="danger"
                        revealOnHover
                        size="3xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCategory?.(c);
                        }}
                        title={`Delete "${c.name}"`}
                        aria-label={`Delete ${c.name}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Pinned "Add new category" footer. Raw by design: a brand-tinted
            filled footer CTA (bg-primary-subtle/40, border-t border-primary/20,
            text-primary) — no minted Button cell (ghost/outline/solid all
            lack a brand-subtle-fill tone) reproduces this look. */}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onAddNew();
          }}
          className="flex flex-shrink-0 items-center justify-center gap-1.5 border-t border-primary/20 bg-primary-subtle/40 px-3 py-2 text-[11px] font-semibold text-primary hover:bg-primary-subtle"
        >
          <Plus className="h-3.5 w-3.5" />
          Add new category
        </button>
      </PopoverContent>
    </Popover>
  );
}
