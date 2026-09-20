import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { notifications } from "../lib/notify";
import { ACTION_OK, ACTION_UNAVAILABLE, actionFailed } from "../lib/actionResult";
import { commands, type DevicePresets, type DevicePresetsSnapshot } from "../lib/bindings";
import { showRollingNotification } from "../lib/rollingNotification";

/** Keyed by `DiscoveredDevice.id`. Unlike `useLiveChannelConfig`/telemetry,
 * FC=59 preset data is never background-polled (preset names change rarely)
 * — `refresh()` triggers `live_control_fetch_presets` on demand (mount +
 * manual button), but the store/listen half mirrors those hooks exactly so
 * every mounted view stays in sync via `live_presets:updated`.
 *
 * Errors surface as toasts rather than inline state — `refresh()`
 * failures are otherwise easy to miss (e.g. the on-mount fetch failing
 * silently before the user has looked at the tab), and a failed `recall()`
 * has no other feedback at all, so a toast is the only confirmation the user
 * gets that it fired (or didn't). Both `recall()` and `store()` refresh on
 * success, since both can change which slot the device reports active and
 * there is no background poll to catch that up otherwise. */
export function useLivePresets(deviceId: string | undefined) {
  const [presetsById, setPresetsById] = useState<Record<string, DevicePresetsSnapshot>>({});
  const [loading, setLoading] = useState(false);
  // Read inside recall()'s toast without retriggering the callback's own
  // identity on every fetch — recall is passed down as a stable click
  // handler, not something that should re-render its consumers on refresh.
  const presetsRef = useRef(presetsById);
  presetsRef.current = presetsById;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<DevicePresets>("live_presets:updated", (event) => {
        setPresetsById((prev) => ({ ...prev, [event.payload.deviceId]: event.payload.presets }));
      });
      const initial = await commands.liveControlGetPresets();
      if (!cancelled && initial.status === "ok") {
        setPresetsById(Object.fromEntries(initial.data.map((d) => [d.deviceId, d.presets])));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    const result = await commands.liveControlFetchPresets(deviceId);
    setLoading(false);
    if (result.status === "error") {
      // Same convention as `liveConfigureAdapter`'s `reportWrite`: failures
      // stack (no `id`) and persist until dismissed.
      notifications.show({
        color: "red",
        title: "Preset fetch failed",
        message: result.error.message,
        autoClose: false,
      });
    }
  }, [deviceId]);

  const recall = useCallback(
    async (slotIndex: number) => {
      if (!deviceId) return ACTION_UNAVAILABLE;
      const result = await commands.liveControlRecallPreset(deviceId, slotIndex);
      if (result.status === "error") {
        notifications.show({
          color: "red",
          title: "Preset recall failed",
          message: result.error.message,
          autoClose: false,
        });
        return actionFailed(result.error.message);
      }
      const slotName = presetsRef.current[deviceId]?.slots.find((s) => s.index === slotIndex)?.name;
      // Success replaces rather than stacks, matching `notifySuccess`. Must go
      // through `showRollingNotification` — a stable `id` on
      // `notifications.show()` is ignored, not replaced.
      showRollingNotification("preset-recall", {
        color: "green",
        title: "Preset recalled",
        message: slotName ? `"${slotName}" applied` : `Slot ${slotIndex + 1} applied`,
        autoClose: 1500,
      });
      // Same reasoning as `store()`: recalling changes which slot is active,
      // and there is no background poll for FC=59 to catch that up on its
      // own — without this the `Active` chip stays on the previous row until
      // the user hits Refresh by hand.
      await refresh();
      return ACTION_OK;
    },
    [deviceId, refresh],
  );

  /** Saves the device's *current* DSP state into `slotIndex` under `name`.
   * Refreshes afterwards, same as `recall`: storing renames the slot, so the
   * list the user is looking at is stale the moment the write lands and there
   * is no background poll for FC=59 to correct it. */
  const store = useCallback(
    async (slotIndex: number, name: string) => {
      if (!deviceId) return ACTION_UNAVAILABLE;
      const result = await commands.liveControlStorePreset(deviceId, slotIndex, name);
      if (result.status === "error") {
        notifications.show({
          color: "red",
          title: "Preset store failed",
          message: result.error.message,
          autoClose: false,
        });
        return actionFailed(result.error.message);
      }
      showRollingNotification("preset-store", {
        color: "green",
        title: "Preset stored",
        message: `"${name}" saved to slot ${slotIndex + 1}`,
        autoClose: 1500,
      });
      await refresh();
      return ACTION_OK;
    },
    [deviceId, refresh],
  );

  useEffect(() => {
    refresh();
  }, [deviceId]);

  return {
    presets: deviceId ? presetsById[deviceId] : undefined,
    loading,
    refresh,
    recall,
    store,
  };
}
