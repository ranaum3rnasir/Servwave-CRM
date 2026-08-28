import { SelectField } from "@/components/form/SelectField";

/** Sentinels. Radix needs a non-empty string for every item, so "no selection"
 *  travels as NONE rather than "" and is translated at the boundary. */
const NONE = "__none__";
const SEPARATOR = "__separator__";
const ADD_NEW = "__add_new__";
const MANAGE = "__manage__";

export type CatalogOption = { value: string; label: string };

/**
 * The ONE dropdown every entity-backed inventory field uses.
 *
 * Before this, six fields hand-rolled the same control and drifted: two of them
 * carried a separate `+` button next to the select AND an "+ Add new …" entry
 * inside it (two routes to one dialog), the sentinel handling was copy-pasted
 * per call site, and each repeated the same trigger classes. Consolidating is
 * the point - a new catalog field should be one <CatalogSelect>, never another
 * variation on the theme.
 *
 * `onAddNew` is invoked instead of `onChange` when the add-new entry is picked;
 * the caller opens its creator dialog and the selection is left untouched, so
 * cancelling the dialog leaves the previous value in place. `onManage` behaves
 * the same way and opens ManageCatalogDialog, which is where deleting lives -
 * see that file for why the trash is not a per-row icon in here.
 */
export function CatalogSelect({
  label,
  value,
  onChange,
  onAddNew,
  onManage,
  managePlural,
  options,
  noun,
  noneLabel,
  keepUnknownValue = false,
  className = "",
}: {
  /** Accessible name for the trigger. */
  label: string;
  /** Current value; "" means nothing selected. */
  value: string;
  /** Fired with the picked value, or "" when the none entry is chosen. */
  onChange: (value: string) => void;
  /** Fired when "+ Add new …" is picked. Open the creator dialog here. */
  onAddNew: () => void;
  /**
   * Fired when "Manage …" is picked. Omit where rows cannot be deleted -
   * vendors and locations have no delete endpoint, so the entry would open a
   * dialog that could only refuse.
   */
  onManage?: () => void;
  /** Plural noun for the manage entry, e.g. "finishes". Required with onManage. */
  managePlural?: string;
  options: CatalogOption[];
  /** Singular noun for the add-new entry, e.g. "brand" -> "+ Add new brand…". */
  noun: string;
  /** Set to offer an explicit empty choice. Omit for a required field. */
  noneLabel?: string;
  /**
   * Keep a current value the options list does not contain, labelled with the
   * value itself. Only correct where the value IS the human-readable token -
   * unit of measure stores the code ("EA"), not a foreign key. Without this an
   * item saved as "EA" renders a BLANK trigger whenever the options have not
   * loaded yet, which is exactly what the empty-list case looked like in the
   * wild. For id-valued fields leave it false: showing a raw uuid is worse than
   * falling back to the none entry, and the label appears once the list loads.
   */
  keepUnknownValue?: boolean;
  className?: string;
}) {
  const isKnown = options.some((o) => o.value === value);
  const orphan = keepUnknownValue && value && !isKnown ? [{ value, label: value }] : [];

  return (
    <SelectField
      aria-label={label}
      value={value || (noneLabel ? NONE : "")}
      onValueChange={(next) => {
        if (next === ADD_NEW) {
          onAddNew();
          return;
        }
        if (next === MANAGE) {
          onManage?.();
          return;
        }
        onChange(next === NONE ? "" : next);
      }}
      className={
        `w-full min-w-0 truncate rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10 ${className}`.trim()
      }
      options={[
        ...(noneLabel ? [{ value: NONE, label: noneLabel }] : []),
        ...options,
        ...orphan,
        { value: SEPARATOR, label: "──────────", disabled: true },
        { value: ADD_NEW, label: `+ Add new ${noun}…` },
        ...(onManage ? [{ value: MANAGE, label: `Manage ${managePlural ?? `${noun}s`}…` }] : []),
      ]}
    />
  );
}
