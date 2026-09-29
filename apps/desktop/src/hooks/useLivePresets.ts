import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@heroui/react";
import { ACTION_OK, ACTION_UNAVAILABLE, actionFailed } from "../lib/actionResult";
import { commands } from "../lib/bindings";
import { showRollingNotification } from "../lib/rollingNotification";
import { useLiveMap } from "./useLiveMap";

/** Keyed by `DiscoveredDevice.id`. Unlike `useLiveChannelConfig`/telemetry,
 * FC=59 preset data is never background-polled (preset names change rarely)
 * — `refresh()` triggers `live_control_fetch_presets` on demand (mount +
 * manual button), but the store is the same `useLiveMap`, so every mounted
 * view stays in sync via `live_presets:updated`.
 *
 * Errors surface as toasts rather than inline state — `refresh()`
 * failures are otherwise easy to miss (e.g. the on-mount fetch failing
 * silently before the user has looked at the tab), and a failed `recall()`
 * has no other feedback at all, so a toast is the only confirmation the user
 * gets that it fired (or didn't). Both `recall()` and `store()` refresh on
 * success, since both can change which slot the device reports active and
 * there is no background poll to catch that up otherwise. */
export function useLivePresets(deviceId: string | undefined) {
  const [presetsById] = useLiveMap("live_presets:updated", commands.liveControlGetPresets, (d) => d.presets);
  const [loading, setLoading] = useState(false);
  // Read inside recall()'s toast without retriggering the callback's own
  // identity on every fetch — recall is passed down as a stable click
  // handler, not something that should re-render its consumers on refresh.
  const presetsRef = useRef(presetsById);
  presetsRef.current = presetsById;

  const refresh = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    const result = await commands.liveControlFetchPresets(deviceId);
    setLoading(false);
    if (result.status === "error") {
      // Same convention as `liveConfigureAdapter`'s `reportWrite`: failures
      // stack (no `id`) and persist until dismissed.
      toast.danger("Preset fetch failed", { description: result.error.message, timeout: 0 });
    }
  }, [deviceId]);

  const recall = useCallback(
    async (slotIndex: number) => {
      if (!deviceId) return ACTION_UNAVAILABLE;
      const result = await commands.liveControlRecallPreset(deviceId, slotIndex);
      if (result.status === "error") {
        toast.danger("Preset recall failed", { description: result.error.message, timeout: 0 });
        return actionFailed(result.error.message);
      }
      const slotName = presetsRef.current[deviceId]?.slots.find((s) => s.index === slotIndex)?.name;
      // Success replaces rather than stacks, matching `notifySuccess`.
      showRollingNotification(
        "preset-recall",
        "Preset recalled",
        slotName ? `"${slotName}" applied` : `Slot ${slotIndex + 1} applied`,
      );
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
        toast.danger("Preset store failed", { description: result.error.message, timeout: 0 });
        return actionFailed(result.error.message);
      }
      showRollingNotification("preset-store", "Preset stored", `"${name}" saved to slot ${slotIndex + 1}`);
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
