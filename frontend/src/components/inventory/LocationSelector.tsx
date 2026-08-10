import type React from "react";
import { useState } from "react";
import {
  Boxes,
  Check,
  ChevronDown,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Truck,
  Warehouse,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Item, Location } from "@/lib/api/inventory";
import type { LocationType } from "@/lib/api/_mock/inventory";

type Props = {
  locations: Location[];
  items: Item[];
  activeId: string; // "all" or a location id
  onChange: (id: string) => void;
  onAddNew: () => void;
  canManage?: boolean;
  onEditLocation?: (loc: Location) => void;
};

export function LocationSelector({
  locations,
  items,
  activeId,
  onChange,
  onAddNew,
  canManage,
  onEditLocation,
}: Props) {
  const [open, setOpen] = useState(false);

  const active = locations.find((l) => l.id === activeId);
  const totalItemsAtActive =
    activeId === "all"
      ? items.filter((i) => i.kind === "material").length
      : items.filter((i) =>
          i.stock.some((s) => s.locationId === activeId && s.onHand > 0),
        ).length;

  const truckCount = locations.filter((l) => l.type === "truck").length;
  const warehouseCount = locations.filter((l) => l.type === "warehouse").length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Raw by design: PopoverTrigger asChild clones + ref-forwards onto
            this element - the never-convert asChild trigger shape. */}
        <button
          className={[
            "flex min-w-[260px] items-center gap-2 rounded-card border bg-surface-light px-3 py-2 text-left transition",
            open
              ? "border-primary ring-2 ring-primary/20"
              : "border-border hover:border-secondary-dark",
          ].join(" ")}
        >
          <LocationIcon type={active?.type} active />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text-primary">
              {activeId === "all" ? "All Locations" : active?.name}
            </p>
            <p className="truncate text-[11px] text-text-secondary">
              {activeId === "all"
                ? `${warehouseCount} warehouse · ${truckCount} vans · ${locations.length - warehouseCount - truckCount} other`
                : active
                  ? `${active.branch} · ${formatType(active.type)}${active.primaryTech ? ` · ${active.primaryTech}` : ""}`
                  : ""}
            </p>
          </div>
          <span className="rounded-md bg-background-light px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-secondary">
            {totalItemsAtActive}
          </span>
          <ChevronDown
            className={[
              "h-4 w-4 text-text-secondary transition",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        // `border` dropped: PopoverContent's own base string already emits
        // an unconditional `border border-border` - this was a byte-for-byte
        // redundant restatement, not an override.
        className="w-[420px] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
      >
        <div className="max-h-[420px] overflow-y-auto py-1">
          <LocationRow
            label="All Locations"
            sub={`Show items across all ${locations.length} locations`}
            icon={<MapPin className="h-4 w-4 text-text-secondary" />}
            count={items.filter((i) => i.kind === "material").length}
            active={activeId === "all"}
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
          />
          <div className="my-1 border-t border-border" />
          {locations.map((loc) => {
            const itemCount = items.filter((i) =>
              i.stock.some((s) => s.locationId === loc.id && s.onHand > 0),
            ).length;
            return (
              <LocationRow
                key={loc.id}
                label={loc.name}
                sub={
                  loc.type === "truck"
                    ? `${loc.branch} · ${loc.primaryTech ?? "Unassigned tech"}${loc.vehicle ? ` · ${loc.vehicle}` : ""}`
                    : `${loc.branch} · ${formatType(loc.type)}`
                }
                icon={<LocationIcon type={loc.type} active />}
                count={itemCount}
                active={activeId === loc.id}
                onClick={() => {
                  onChange(loc.id);
                  setOpen(false);
                }}
                onEdit={
                  canManage && onEditLocation
                    ? () => {
                        onEditLocation(loc);
                        setOpen(false);
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
        <div className="border-t border-border bg-background-light px-2 py-1.5">
          {/* Raw by design: a brand-tinted footer CTA (text-primary,
              hover:bg-primary-subtle, no border) - no minted ghost/brand cell
              (ghost only has neutral/subtle/danger tones). */}
          <button
            onClick={() => {
              setOpen(false);
              onAddNew();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-primary hover:bg-primary-subtle"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-subtle">
              <Plus className="h-3.5 w-3.5" />
            </span>
            Add Location / Van
          </button>
          {canManage && (
            <p className="px-2.5 pb-1 pt-0.5 text-[10px] text-text-secondary">
              <ShieldCheck className="mr-0.5 inline h-2.5 w-2.5 text-success" />
              Admin · hover any location to edit
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LocationRow({
  label,
  sub,
  icon,
  count,
  active,
  onClick,
  onEdit,
}: {
  label: string;
  sub: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
}) {
  return (
    <div
      className={[
        "group flex w-full items-center gap-3 px-3 py-2 text-left transition",
        active ? "bg-primary-subtle" : "hover:bg-background-light",
      ].join(" ")}
    >
      {/* Raw by design: a list-row click target, not Button-shaped. */}
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <div
          className={[
            "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md",
            active ? "bg-surface-light ring-1 ring-primary/30" : "bg-background-light",
          ].join(" ")}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={[
              "truncate text-sm",
              active
                ? "font-semibold text-primary-dark"
                : "font-medium text-text-primary",
            ].join(" ")}
          >
            {label}
          </p>
          <p className="truncate text-[11px] text-text-secondary">{sub}</p>
        </div>
        <span className="rounded-md bg-background-light px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-secondary">
          {count}
        </span>
        {active && <Check className="h-3.5 w-3.5 text-primary" />}
      </button>
      {onEdit && (
        // Raw by design: the opacity-0/group-hover:opacity-100 visibility
        // toggle lives on this button's own className (not a wrapping span),
        // and the hover background (secondary-light) doesn't match any
        // minted ghost cell either - converting would add new SOFT classes
        // to a governed component, and the layering guard's soft ratchet has
        // zero slack (196/196 measured pre-batch).
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Edit location (admin)"
          aria-label="Edit location"
          className="ml-1 rounded-md p-1 text-text-secondary opacity-0 transition hover:bg-secondary-light hover:text-text-primary group-hover:opacity-100 focus:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function LocationIcon({
  type,
  active,
}: {
  type?: LocationType;
  active?: boolean;
}) {
  const cls = ["h-4 w-4", active ? "text-primary" : "text-text-secondary"].join(
    " ",
  );
  if (type === "truck") return <Truck className={cls} />;
  if (type === "warehouse") return <Warehouse className={cls} />;
  if (type === "counter") return <Boxes className={cls} />;
  if (type === "staging") return <MapPin className={cls} />;
  return <MapPin className={cls} />;
}

function formatType(type?: LocationType) {
  if (type === "truck") return "Truck";
  if (type === "warehouse") return "Warehouse";
  if (type === "counter") return "Counter";
  if (type === "staging") return "Staging";
  return "Location";
}
