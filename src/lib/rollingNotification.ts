import { notifications } from "./notify";

type NotificationProps = Parameters<typeof notifications.show>[0];

/** Notification id currently on screen for each rolling key. */
const activeByKey = new Map<string, string>();
let sequence = 0;

/**
 * Shows a notification that *replaces* the previous one for the same `key`,
 * restarting its auto-close timer — a single rolling confirmation rather than
 * a stack.
 *
 * HeroUI's `toast()` (see `./notify.ts`) always queues a brand-new toast on
 * every call — there's no caller-supplied id it dedupes or replaces by — so
 * calling it again for, say, "preset recalled" while the previous one is
 * still showing would stack two toasts instead of refreshing one. This
 * closes the previous toast for `key` first, then opens a new one, which
 * also reads as a visible swap rather than a silently mutating toast.
 *
 * `key` scopes the rolling behaviour: two different keys coexist and stack
 * normally. Only repeats of the same key replace each other.
 */
export function showRollingNotification(key: string, props: Omit<NotificationProps, "id" | "onClose">): void {
  // Hide first, then record: `hide` fires the old notification's `onClose`,
  // which clears the map entry. Doing it in the other order would let that
  // callback delete the entry we just wrote for the new toast.
  const previous = activeByKey.get(key);
  if (previous) {
    notifications.hide(previous);
  }

  const id = `${key}#${++sequence}`;
  activeByKey.set(key, id);
  notifications.show({
    ...props,
    id,
    onClose: () => {
      // Guard against a late auto-close from a superseded toast evicting the
      // entry belonging to a newer one.
      if (activeByKey.get(key) === id) {
        activeByKey.delete(key);
      }
    },
  });
}
