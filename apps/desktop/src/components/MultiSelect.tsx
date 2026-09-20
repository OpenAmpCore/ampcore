import { useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { ListBox, Popover, popoverVariants } from "@heroui/react";
import { FIELD_INPUT } from "./fieldClasses";

export interface MultiSelectOption {
  value: string;
  label: string;
}

const POPOVER_SLOTS = popoverVariants();

/** A checkbox-style multi-select dropdown. Deliberately *not* HeroUI's
 * `Select` in `selectionMode="multiple"`: that mode is typed correctly
 * (react-stately's `SelectProps<T, M>` genuinely varies `value`/`onChange`
 * by `M`) but is unreliable at runtime in the installed version — the
 * trigger rendered only the locale list-connector word ("und") with the
 * item labels themselves blank, and the field reported `data-invalid`. Built
 * instead on the same controlled `Popover.Content`/`triggerRef` shape as
 * `AmpConfigureView`'s `TilePopover`, with a plain `ListBox`
 * (`selectionMode="multiple"`) inside — `ListBox` was never split across a
 * legacy single-select API the way `Select` is, so its `selectedKeys`/
 * `onSelectionChange` behave exactly as typed. The trigger's text is
 * computed here rather than left to a library default, so there's nothing
 * left to silently misrender. */
export function MultiSelect({
  data,
  values,
  onChange,
  emptyLabel = "Disabled",
  disabled,
  className,
  style,
}: {
  data: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  /** Shown in the trigger when `values` is empty. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const [opened, setOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selectedLabels = values
    .map((v) => data.find((opt) => opt.value === v)?.label)
    .filter((label): label is string => label !== undefined);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => setOpened((o) => !o)}
        className={`${FIELD_INPUT} flex items-center justify-between gap-2 text-left font-normal ${className ?? ""}`}
        // A fixed, field-sized width rather than `FIELD_INPUT`'s own
        // `w-full`: inside `SettingRow`'s `justify-between` row, a full-width
        // trigger claims the whole row and pushes the label onto its own
        // line above it instead of sitting beside it like every other
        // setting control.
        style={{ width: 220, ...style }}
      >
        <span className="min-w-0 truncate">
          {selectedLabels.length > 0 ? selectedLabels.join(", ") : emptyLabel}
        </span>
        <ChevronDown
          size={14}
          className="shrink-0 transition-transform duration-150"
          style={{ opacity: 0.6, transform: opened ? "rotate(180deg)" : undefined }}
        />
      </button>
      {/* No `Popover.Dialog` here — that slot's own CSS (`.popover__dialog`)
          bakes in 16px of padding meant for generic dialog content, which is
          exactly the "margin/padding around the buttons" that made the item
          rows look inset and boxy instead of flush against the popover's
          edges. HeroUI's own `Select.Popover` never uses `Dialog` either — it
          puts the `ListBox` directly inside a plain `Popover`, whose own
          `.popover` class is already zero-padding, so this now matches that
          exactly rather than approximating it. */}
      <Popover.Content
        className={POPOVER_SLOTS.base()}
        triggerRef={triggerRef}
        isOpen={opened}
        onOpenChange={setOpened}
        placement="bottom start"
      >
        <ListBox
          style={{ width: 220 }}
          selectionMode="multiple"
          selectedKeys={new Set(values)}
          onSelectionChange={(keys) =>
            onChange(keys === "all" ? data.map((opt) => opt.value) : Array.from(keys, String))
          }
        >
          {data.map((opt) => (
            <ListBox.Item key={opt.value} id={opt.value}>
              {opt.label}
              <ListBox.Item.Indicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Popover.Content>
    </>
  );
}
