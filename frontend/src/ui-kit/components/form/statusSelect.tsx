"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Badge, type BadgeProps } from "@/ui-kit/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/ui-kit/components/ui/select";

export interface StatusOption<T extends string = string> {
  value: T;
  label: string;
  tone: NonNullable<BadgeProps["variant"]>;
}

export interface StatusSelectProps<T extends string = string> {
  options: readonly StatusOption<T>[];
  value?: T;
  onValueChange?: (value: T) => void;
  placeholder?: string;
  size?: "sm" | "default";
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}

/**
 * Status picker whose options *are* the badge the table will render.
 *
 * The alternative - a coloured dot beside plain text - asks the user to hold a
 * legend in their head, and it means one value speaks two visual languages: a
 * solid pill in the cell, a small dot in the control. Rendering the real chip
 * removes the translation step entirely.
 *
 * Reserve the solid treatment for status, the field that defines a record.
 * Priority, category and similar qualifiers should use the soft Badge variants
 * so half a dozen pickers on one form don't shout over each other.
 */
function StatusSelect<T extends string = string>({
  options, value, onValueChange,
  placeholder = "Select status",
  size = "default", disabled, invalid, id, className,
}: StatusSelectProps<T>) {
  const selected = options.find((option) => option.value === value);

  return (
    <Select value={value} onValueChange={(next) => onValueChange?.(next as T)} disabled={disabled}>
      <SelectTrigger
        id={id}
        size={size}
        aria-invalid={invalid}
        // Tighter left padding: the badge carries its own inset, so the usual
        // 12px would leave the chip floating away from the edge.
        className={cn("ps-2", className)}
      >
        <SelectValue placeholder={placeholder}>
          {selected && <Badge variant={selected.tone}>{selected.label}</Badge>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          // Text stays in the item for type-ahead - Radix matches on
          // textContent, and a badge-only item would be unsearchable.
          <SelectItem key={option.value} value={option.value} textValue={option.label} className="py-1.5">
            <Badge variant={option.tone}>{option.label}</Badge>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Job statuses for this CRM. Tones map straight to Badge variants. */
export const JOB_STATUSES = [
  { value: "unscheduled", label: "Unscheduled", tone: "purple" },
  { value: "scheduled", label: "Scheduled", tone: "blue" },
  { value: "in_progress", label: "In progress", tone: "amber" },
  { value: "completed", label: "Completed", tone: "green" },
  { value: "overdue", label: "Overdue", tone: "red" },
  { value: "cancelled", label: "Cancelled", tone: "slate" },
] as const satisfies readonly StatusOption[];

export type JobStatus = (typeof JOB_STATUSES)[number]["value"];

export { StatusSelect };
