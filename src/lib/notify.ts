import type { ReactNode } from "react";
import { toast } from "@heroui/react";

/**
 * Thin shim over HeroUI's `toast` exposing the old Mantine-shaped
 * `notifications.show()`/`.hide()` call signature, so the app's 6 call sites
 * (`RotaryLockToggle`, `StandbyToggle`, `useLinkedSync`, `useLivePresets`,
 * `rollingNotification`, `liveConfigureAdapter`) never had to change beyond
 * their import line during the Mantine→HeroUI migration. Could be inlined
 * into HeroUI's native `toast` API at each call site if this indirection
 * stops earning its keep.
 *
 * HeroUI's `toast()` generates and returns its own id rather than accepting
 * a caller-supplied one, so callers that pass a stable `id` (to `.hide()` it
 * later, e.g. `rollingNotification.ts`) are tracked here via `idMap`.
 */
export interface NotifyOptions {
  id?: string;
  color?: "red" | "green" | string;
  title?: ReactNode;
  message: ReactNode;
  autoClose?: number | false;
  onClose?: () => void;
}

const VARIANT_BY_COLOR: Record<string, "danger" | "success" | undefined> = {
  red: "danger",
  green: "success",
};

const idMap = new Map<string, string>();

export const notifications = {
  show(opts: NotifyOptions): string {
    const variant = opts.color ? VARIANT_BY_COLOR[opts.color] : undefined;
    const timeout = opts.autoClose === false ? 0 : opts.autoClose;
    const toastId = toast(opts.title ?? opts.message, {
      description: opts.title ? opts.message : undefined,
      variant,
      timeout,
      onClose: opts.onClose,
    });
    if (opts.id) idMap.set(opts.id, toastId);
    return toastId;
  },
  hide(id: string): void {
    const toastId = idMap.get(id) ?? id;
    toast.close(toastId);
    idMap.delete(id);
  },
};
