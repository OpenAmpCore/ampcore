import type { CSSProperties } from "react";
import { Description, Label, ListBox, Select } from "@heroui/react";

export interface SimpleSelectOption {
  value: string;
  label: string;
}

/** Thin wrapper composing HeroUI's collection-based `Select` (Trigger/Popover/
 * ListBox.Item) behind a flat `data`/`value`/`onChange` shape — this exact
 * composition repeats at every dropdown call site across the app, so it's
 * centralized once here rather than duplicated per file.
 *
 * Label and description are HeroUI's own `Label`/`Description`, not bare
 * spans: rendered inside `Select` they pick up the `aria-labelledby` /
 * `aria-describedby` wiring from its context, which hand-rolled spans can't.
 * The trigger likewise keeps HeroUI's own field styling (background, focus
 * ring, disabled state) rather than overriding it with `--amp-*` vars — that
 * override is what used to make these dropdowns visibly foreign next to a
 * real `TextField` sitting beside them. */
export function SimpleSelect({
  data,
  value,
  onChange,
  label,
  description,
  placeholder,
  disabled,
  clearable,
  className,
  style,
}: {
  data: SimpleSelectOption[];
  value: string | null;
  /** `null` only ever arrives via a `clearable` select's clear button. */
  onChange: (value: string | null) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Shows a clear ("x") button once a value is selected. */
  clearable?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => onChange(key == null ? null : String(key))}
      onClear={clearable ? () => onChange(null) : undefined}
      isDisabled={disabled}
      placeholder={placeholder}
      fullWidth
      className={className}
      style={style}
    >
      {label && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        {/* Clear and the chevron both render: making them mutually exclusive
            meant a clearable select lost its dropdown affordance entirely as
            soon as it had a value. */}
        {clearable && value != null && <Select.ClearButton />}
        <Select.Indicator />
      </Select.Trigger>
      {description && <Description>{description}</Description>}
      <Select.Popover>
        <ListBox>
          {data.map((opt) => (
            <ListBox.Item key={opt.value} id={opt.value}>
              {opt.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
