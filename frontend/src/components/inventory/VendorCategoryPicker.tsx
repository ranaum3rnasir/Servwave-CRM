import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  value: string;
  options: string[];           // existing distinct categories
  onChange: (next: string) => void;
  placeholder?: string;
  /** Optional CSS classes applied to the wrapping element */
  className?: string;
  /** Highlights the field as part of an in-edit form (amber border) */
  inEdit?: boolean;
};

// Radix Select forbids an empty-string item value, so the "+ Add new" sentinel
// uses a non-empty token. The placeholder/empty state is handled by SelectValue.
const NEW_SENTINEL = "__new__";

/**
 * Dropdown of every existing vendor category, with an "+ Add new category"
 * row at the bottom that swaps in an inline text input for fresh entries.
 *
 * Picking an existing option commits immediately. In "new" mode the input is
 * live-bound so whatever's typed becomes the form value on save.
 */
export function VendorCategoryPicker({
  value,
  options,
  onChange,
  placeholder,
  className,
  inEdit,
}: Props) {
  // "new" mode triggers when the user explicitly clicks "+ Add new category"
  // OR when the current value isn't in the known options (e.g. editing a vendor
  // whose category was free-typed before this picker existed).
  const valueIsNew = value.trim() !== "" && !options.includes(value);
  const [creating, setCreating] = useState<boolean>(valueIsNew);

  // Named to not start with "border"/"ring"/etc - SelectTrigger below still
  // consumes this for its own (pre-existing, out of scope for this pass)
  // conditional border/ring tint; the Input above only needs the layout
  // fragment of the same string now that its own static appearance moved
  // onto the primitive.
  const edgeCls = inEdit ? "border-warning/20" : "border-border";
  const ringCls = inEdit
    ? "focus:ring-warning/20"
    : "focus:ring-primary/20 focus:border-primary";

  if (creating) {
    return (
      <div className={`flex items-center gap-1 ${className ?? ""}`}>
        <Input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "New category name"}
          className="flex-1 px-2.5 py-1.5"
        />
        {/* Not converted to Button: outline/neutral sets no idle text
            colour (button.tsx's own header note), and this row's ambient
            wrapper sets none either - the raw's text-secondary would
            silently fall through to near-black. */}
        <button
          type="button"
          onClick={() => {
            setCreating(false);
            onChange("");
          }}
          title="Cancel new category"
          aria-label="Cancel new category"
          className="rounded-md border border-border bg-surface-light p-1.5 text-text-secondary hover:bg-background-light hover:text-text-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className={`relative flex items-center gap-1 ${className ?? ""}`}>
      <Select
        value={value === "" ? undefined : value}
        onValueChange={(v) => {
          if (v === NEW_SENTINEL) {
            setCreating(true);
            onChange("");
            return;
          }
          onChange(v);
        }}
      >
        {/* Six raw tokens dropped here: a radius class, a bare border width
            class, a background class, a font size class, and the focus
            outline and focus ring width classes. SelectTrigger's own base
            string already emits all six unconditionally (the dropped radius
            class and the base's own default radius class both resolve to
            var(--radius-control), so this is byte-identical), so they were
            redundant restatements, not overrides. edgeCls/ringCls stay raw -
            the conditional warning-tinted border/ring tint has no matching
            tone (SelectTriggerTone is default/sage/business only). */}
        <SelectTrigger
          className={`h-auto flex-1 ${edgeCls} px-2.5 py-1.5 ${ringCls}`}
        >
          <SelectValue placeholder={placeholder ?? "Select a category…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
          {options.length > 0 && <SelectSeparator />}
          <SelectItem value={NEW_SENTINEL}>+ Add new category…</SelectItem>
        </SelectContent>
      </Select>
      {value !== "" && (
        <Button
          type="button"
          onClick={() => setCreating(true)}
          title="Type a new category instead"
          aria-label="Type a new category instead"
          variant="ghost"
          tone="subtle"
          size="icon"
        >
          <Plus className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
