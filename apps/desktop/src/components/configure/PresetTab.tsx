import { useEffect, useState } from "react";
import { Button, ButtonGroup, Chip, Modal, Spinner } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import { FIELD_INPUT } from "../fieldClasses";
import { ActionFeedbackContent } from "../ActionFeedback";
import { useActionFeedback } from "../../hooks/useActionFeedback";
import { useLivePresets } from "../../hooks/useLivePresets";
import { ACTION_UNAVAILABLE, type ActionResult } from "../../lib/actionResult";
import type { PresetSlot } from "../../lib/bindings";
import { Hint } from "../Hint";
import { CenteredScrollPane } from "./parts";

/** True for a slot the device reports as unused. The FC=59 list parser
 * returns every slot verbatim (empty/`"null"` filtering is explicitly a UI
 * concern, see `parse_preset_list`), and the device spells "unused" two
 * different ways depending on whether the slot was never written or was
 * cleared, so both collapse to the same empty state here. */
function isEmptySlot(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === "null";
}

/** Fixed widths, so a preset row's two buttons form straight columns down the
 * list. Recall's also holds `ActionFeedbackContent`, which fills its parent. */
const PRESET_RECALL_WIDTH = 72;

const PRESET_STORE_WIDTH = 88;

/** The dimmed caption every secondary line in this tab uses. */
const PRESET_MUTED =
  "text-[length:var(--amp-font-size-xs)] text-[var(--amp-color-dimmed)]";

/** One row of the preset list. Kept deliberately thin: with 40 slots, a
 * card per preset put ~80 labelled buttons on screen at once, which read as
 * a wall rather than a list you scan. The actions are labelled, because an
 * icon couldn't say what they do. An empty slot renders no Recall control at all rather than a greyed
 * one — on a mostly-empty device that alone removes most of the clutter.
 *
 * Store is the destructive half (it overwrites the slot with the amp's
 * current DSP state, and the wire protocol offers no undo), so it never
 * fires from the row at all: it opens a modal that names the slot, warns when
 * it is about to overwrite, and asks again. Nothing in the resting row is red:
 * a solid column of red buttons stops reading as a warning. Red appears once,
 * on the modal's Overwrite button. */
function PresetSlotRow({
  slot,
  isActive,
  onRecall,
  onRequestStore,
}: {
  slot: PresetSlot;
  isActive: boolean;
  onRecall: () => Promise<ActionResult>;
  onRequestStore: () => void;
}) {
  const empty = isEmptySlot(slot.name);
  const recallFeedback = useActionFeedback();

  function handleRecall() {
    // A second click mid-request would fire the same recall again against a
    // state the UI hasn't caught up with yet.
    if (recallFeedback.busy) return;
    void recallFeedback.track(onRecall());
  }

  return (
    <div
      // Empty slots recede and lift on hover — the same treatment bypassed
      // columns get in the EQ strip, so "present but not doing anything"
      // looks the same everywhere in the app.
      className={`flex min-w-0 flex-nowrap items-center gap-2 rounded-md px-2 py-1 transition-opacity duration-150 hover:bg-[var(--amp-color-gray-light)] ${empty ? "opacity-[0.55] hover:opacity-100" : ""}`}
      style={{
        // The tint alone marks the active row now. This used to add a 2px
        // left accent bar, which made sense while rows were divided by
        // hairlines and a boxed highlight would have fought them — but with
        // rounded rows the bar fights the corners instead.
        background: isActive
          ? "color-mix(in srgb, var(--amp-color-green-light) 25%, transparent)"
          : undefined,
      }}
    >
      {/* Tabular figures and zero-padded so the numbers form a straight
       * column down the list instead of drifting between 1 and 40. */}
      <span
        className="shrink-0"
        style={{ fontSize: "var(--amp-font-size-xs)", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--amp-color-dimmed)" }}
      >
        {String(slot.index + 1).padStart(2, "0")}
      </span>
      <Hint text={empty ? undefined : slot.name} className="min-w-0 flex-1">
        <span
          className="block truncate"
          style={{
            fontSize: "var(--amp-font-size-sm)",
            color: empty ? "var(--amp-color-dimmed)" : undefined,
            fontStyle: empty ? "italic" : undefined,
            fontWeight: isActive ? 600 : 400,
          }}
        >
          {empty ? "Empty" : slot.name}
        </span>
      </Hint>
      {isActive && (
        <Chip size="sm" color="success" className="shrink-0">
          Active
        </Chip>
      )}
      <div className="flex shrink-0 flex-nowrap items-center gap-1">
        {/* Nothing to recall from an empty slot. The control is omitted
         * rather than disabled, so 29 empty rows do not each carry a dead
         * button — the spacer keeps Store in one straight column regardless. */}
        {empty ? (
          <div style={{ width: PRESET_RECALL_WIDTH }} className="shrink-0" />
        ) : (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Recall "${slot.name}"`}
            aria-busy={recallFeedback.busy || undefined}
            className="shrink-0 px-0"
            style={{ width: PRESET_RECALL_WIDTH }}
            onPress={handleRecall}
          >
            <ActionFeedbackContent status={recallFeedback.status} size={16}>
              {/* The feedback layer is absolute, so it has to centre its own content. */}
              <div className="flex h-full items-center justify-center">Recall</div>
            </ActionFeedbackContent>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={empty ? `Store to slot ${slot.index + 1}` : `Overwrite "${slot.name}"`}
          className="shrink-0 px-0"
          style={{ width: PRESET_STORE_WIDTH }}
          onPress={onRequestStore}
        >
          {empty ? "Store" : "Overwrite"}
        </Button>
      </div>
    </div>
  );
}

/** Store's confirmation step. One modal for the whole tab rather than one per
 * row — 40 rows would otherwise each carry an overlay — reseeded from `slot`
 * each time a row's Store or Overwrite button opens it.
 *
 * A modal suits the weight of the action, which is the one thing in this tab
 * that destroys something. */
function PresetStoreModal({
  slot,
  onClose,
  onStore,
}: {
  slot: PresetSlot | null;
  onClose: () => void;
  onStore: (name: string) => Promise<ActionResult>;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const empty = slot ? isEmptySlot(slot.name) : false;

  // Seeded from the slot being written: its current name when overwriting,
  // since the usual edit is a small one, and blank for an empty slot.
  useEffect(() => {
    if (slot) setDraft(isEmptySlot(slot.name) ? "" : slot.name);
  }, [slot]);

  async function commitStore() {
    const trimmed = draft.trim();
    if (!slot || trimmed.length === 0 || saving) return;
    setSaving(true);
    const result = await onStore(trimmed);
    setSaving(false);
    // Closes only on success: after a failure the typed name is still in the
    // field, ready to retry, and the toast explains what went wrong.
    if (result.ok) onClose();
  }

  return (
    <Modal.Backdrop isOpen={slot !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>
              {slot ? `Store to slot ${slot.index + 1}` : "Store preset"}
            </Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <span className={PRESET_MUTED}>
                {empty ? (
                  "Saves the amp's current settings into this slot."
                ) : (
                  <>
                    Overwrites <b>{slot?.name}</b> with the amp&apos;s current
                    settings. This cannot be undone.
                  </>
                )}
              </span>
              <input
                type="text"
                autoFocus
                placeholder="Preset name"
                value={draft}
                maxLength={PRESET_NAME_MAX_LEN}
                className={FIELD_INPUT}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitStore();
                }}
              />
              <span className={`${PRESET_MUTED} text-right`}>
                {draft.length}/{PRESET_NAME_MAX_LEN}
              </span>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" isDisabled={saving} onPress={onClose}>
                  Cancel
                </Button>
                {/* The one red control in this tab, and the only place the
                    overwrite can actually be committed. */}
                <Button
                  variant={empty ? "primary" : "danger"}
                  isDisabled={draft.trim().length === 0 || saving}
                  onPress={commitStore}
                >
                  {saving ? <Spinner size="sm" /> : empty ? "Save preset" : "Overwrite"}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Mirrors the device's own 32-byte ASCII name field, which
 * `live_control_store_preset` rejects anything longer than. Capping the
 * input means the user never types a name the command will refuse. */
const PRESET_NAME_MAX_LEN = 32;

/** Slot-state filter options. Defaults to "used" only: a device exposes 40
 * slots but typically has a handful written, so an unfiltered list is mostly
 * empty rows. Clearing the filter entirely shows everything, following the
 * usual convention that no selection means no filter — otherwise clearing it
 * would leave a blank list that reads as broken. */
const PRESET_FILTER_OPTIONS = [
  { value: "used", label: "Used" },
  { value: "empty", label: "Empty" },
];

const PRESET_FILTER_DEFAULT = ["used"];

/** Wide enough for a full 32-character preset name plus its two controls,
 * and no wider. The header shares the cap so the Refresh button sits over the
 * list rather than a screen away from it on a wide window. */
const PRESET_LIST_MAX_WIDTH = 620;

/** FC=59 preset browser — fetch-on-demand (mount + manual Refresh) rather
 * than the continuous-poll pattern other tabs use, since preset names
 * change rarely (see `useLivePresets`). Deliberately not a
 * `ConfigurableTabProps` consumer like the other tabs in `TAB_COMPONENTS`:
 * presets are a live wire-protocol feature with no amp-model/capability
 * dependency, so it only needs `deviceId`/`firmwareFamily` (see the
 * special-cased branch in `AmpConfigureView`'s render loop below). */
export function PresetConfigurationTab({
  deviceId,
  firmwareFamily,
}: {
  deviceId?: string;
  firmwareFamily?: string | null;
}) {
  const { presets, loading, refresh, recall, store } = useLivePresets(deviceId);
  const [storeTarget, setStoreTarget] = useState<PresetSlot | null>(null);
  const [slotFilter, setSlotFilter] = useState<string[]>(PRESET_FILTER_DEFAULT);

  if (!deviceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
          No live device selected.
        </span>
      </div>
    );
  }

  if (firmwareFamily !== "1.1.8" && firmwareFamily !== "1.1.9") {
    return (
      <div className="flex h-full items-center justify-center">
        <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
          Preset fetching requires firmware 1.1.8 or 1.1.9 (detected:{" "}
          {firmwareFamily ?? "unknown"}).
        </span>
      </div>
    );
  }

  const slots = presets?.slots ?? [];
  const usedCount = slots.filter((slot) => !isEmptySlot(slot.name)).length;
  const filterCounts: Record<string, number> = {
    used: usedCount,
    empty: slots.length - usedCount,
  };
  const visibleSlots =
    slotFilter.length === 0
      ? slots
      : slots.filter((slot) =>
          slotFilter.includes(isEmptySlot(slot.name) ? "empty" : "used"),
        );
  const activeName =
    presets?.activePresetName && !isEmptySlot(presets.activePresetName)
      ? presets.activePresetName
      : null;
  const activeRowVisible = visibleSlots.some((slot) => !isEmptySlot(slot.name) && slot.name === activeName);

  function toggleFilter(value: string) {
    setSlotFilter((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  }

  return (
    /* `CenteredScrollPane`, like every other tab in this view: it centres the
       column while it fits and scrolls once it doesn't. This used to be a
       hand-rolled `h-full` column with its own inner scroller, which pinned a
       short list to the top of a tall window with a void underneath it. */
    <CenteredScrollPane>
      {/* A single column capped in width: preset names are short, so letting
       * rows run the full width of a maximised window would strand the
       * controls a screen away from the name they belong to. */}
      <div
        className="mx-auto flex w-full min-w-0 flex-col gap-3"
        style={{ maxWidth: PRESET_LIST_MAX_WIDTH }}
      >
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div style={{ fontWeight: 600 }}>Preset Configuration</div>
          <div className="flex flex-nowrap items-center gap-2">
            {/* The counts ride on the filter buttons themselves, which is
                what retired the old header's "— N hidden" clause: the filter
                is the reason anything is hidden, so it can say so itself. */}
            <ButtonGroup size="sm" aria-label="Filter slots by state">
              {PRESET_FILTER_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={slotFilter.includes(opt.value) ? "primary" : "ghost"}
                  onPress={() => toggleFilter(opt.value)}
                >
                  {opt.label}
                  {slots.length > 0 && (
                    <span className="ml-1 opacity-60">{filterCounts[opt.value]}</span>
                  )}
                </Button>
              ))}
            </ButtonGroup>
            <Button size="sm" variant="secondary" isDisabled={loading} onPress={refresh}>
              {loading ? <Spinner size="sm" /> : <RefreshCw size={14} />} Refresh
            </Button>
          </div>
        </div>

        {/* The list's own row says which preset is active, so this line only
            appears when that row can't: filtered out, or nothing reported. */}
        {slots.length > 0 && !activeRowVisible && (
          <div className={`flex min-w-0 items-center gap-1.5 ${PRESET_MUTED}`}>
            {activeName ? (
              <>
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: "var(--amp-color-green-6)" }}
                />
                <span className="min-w-0 truncate">
                  <b>{activeName}</b> active on the amp
                </span>
              </>
            ) : (
              <span className="min-w-0 truncate">No preset reported as active</span>
            )}
          </div>
        )}

        {slots.length === 0 && !loading && (
          <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
            No preset data yet — click Refresh.
          </span>
        )}
        {slots.length > 0 && visibleSlots.length === 0 && (
          <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
            No slots match the current filter.
          </span>
        )}

        <div className="flex min-w-0 flex-col gap-0.5">
          {visibleSlots.map((slot) => (
            <PresetSlotRow
              key={slot.index}
              slot={slot}
              isActive={
                !isEmptySlot(slot.name) &&
                presets?.activePresetName === slot.name
              }
              onRecall={() => recall(slot.index)}
              onRequestStore={() => setStoreTarget(slot)}
            />
          ))}
        </div>
      </div>

      <PresetStoreModal
        slot={storeTarget}
        onClose={() => setStoreTarget(null)}
        onStore={(name) =>
          storeTarget ? store(storeTarget.index, name) : Promise.resolve(ACTION_UNAVAILABLE)
        }
      />
    </CenteredScrollPane>
  );
}
