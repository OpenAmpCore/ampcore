import type { ReactNode } from "react";
import { Tooltip } from "@heroui/react";

/** A HeroUI tooltip around `children`; no `text` means no tooltip. Use this
 * instead of a native `title=` — it must not sit inside a RAC collection
 * (`Tabs.List`, `Dropdown.Menu`, `ListBox`), see the tab rail in
 * `AmpConfigureView.tsx`. `className` styles the trigger wrapper (a `div`),
 * which is what takes the flex/min-w-0 role the child used to have. */
export function Hint({
  text,
  className,
  children,
}: {
  text: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip delay={300}>
      <Tooltip.Trigger className={className}>{children}</Tooltip.Trigger>
      <Tooltip.Content showArrow>{text}</Tooltip.Content>
    </Tooltip>
  );
}
