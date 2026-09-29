import type { ReactNode } from "react";
import { toast } from "@heroui/react";

/** Toast id currently on screen for each rolling key. */
const activeByKey = new Map<string, string>();

/**
 * Shows a short green confirmation that *replaces* the previous one for the
 * same `key` — a single rolling confirmation rather than a stack.
 *
 * HeroUI's `toast()` always queues a brand-new toast and generates its own
 * id, so calling it again for, say, "preset recalled" while the previous one
 * is still showing would stack two. This closes the previous toast for `key`
 * first, which also reads as a visible swap rather than a silently mutating
 * toast. Different keys coexist and stack normally.
 */
export function showRollingNotification(key: string, title: ReactNode, description: ReactNode): void {
  const previous = activeByKey.get(key);
  if (previous) toast.close(previous);

  const id = toast.success(title, {
    description,
    timeout: 1500,
    // Guard against a late close from a superseded toast evicting the entry
    // belonging to a newer one.
    onClose: () => {
      if (activeByKey.get(key) === id) activeByKey.delete(key);
    },
  });
  activeByKey.set(key, id);
}
