import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { cn } from '@/ui-kit/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * The kit's Select in the `{ value, label }[]` shape the settings screens use.
 *
 * A local adapter rather than the app's `components/form/SelectField`, so the
 * whole v2 module renders one Select family. The radix trigger keeps
 * `role="combobox"`, which is what every spec on this module selects on
 * (`getByRole('combobox')` / `getAllByRole('combobox')`).
 */
export function SelectField({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  'aria-label': ariaLabel,
  disabled,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={cn(className)} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
