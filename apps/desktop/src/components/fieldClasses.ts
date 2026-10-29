/** Shared class string for the app's raw `<input>` elements — the few places
 * that need a bare controlled input rather than a HeroUI `TextField`
 * (`CommitNumberInput` and the two inline text inputs in `AmpConfigureView`).
 *
 * Every token here is one of HeroUI's own field variables, so these inputs
 * follow the user's accent and radius choices and sit flush next to real
 * HeroUI fields. They previously hardcoded `--amp-*` borders and an amber
 * focus colour, which is what made them read as a different design system. */
export const FIELD_INPUT =
  "w-full rounded-md border border-field-border bg-field px-2 py-1 text-sm text-field-foreground " +
  "outline-none placeholder:text-field-placeholder hover:border-field-border-hover " +
  "focus:border-field-border-focus disabled:opacity-(--disabled-opacity)";

/** A titled card's small uppercase heading (Input / Output and Overview tabs). */
export const SECTION_TITLE =
  "text-[length:var(--amp-font-size-xs)] font-semibold uppercase tracking-widest text-[var(--amp-color-dimmed)]";
