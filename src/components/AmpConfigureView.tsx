import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  MultiSelect,
  NumberInput,
  Popover,
  ScrollArea,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  Eye,
  FlipVertical2,
  GitCompare,
  Plug,
  RefreshCw,
  Route,
  SquareArrowRightEnter,
  Unplug,
  SquareArrowRightExit,
  ShieldAlert,
  ListPlus,
  Lock,
  Radio,
  Volume2,
  VolumeX,
  Waves,
  WifiOff,
} from "lucide-react";
import { CommitNumberInput } from "./CommitNumberInput";
import { EqEditor } from "./EqEditor";
import {
  FingerprintInspector,
  type FingerprintTarget,
} from "./FingerprintInspector";
import { FingerprintMismatchModal } from "./FingerprintMismatchModal";
import { LimiterEditor } from "./LimiterEditor";
import { RotaryLockToggle } from "./RotaryLockToggle";
import { StandbyToggle } from "./StandbyToggle";
import { ChannelStateBadge } from "./ChannelStateBadge";
import { InputClipPill } from "./InputClipPill";
import {
  PresetActionTile,
  STAT_TILE_FOCUS,
  StatEditorTile,
  StatReadout,
  StatToggle,
} from "./StatTiles";
import { DEFAULT_LEVEL_GRADIENT, VuMeter, type VuMeterMark } from "./VuMeter";
import { useActionFeedback } from "../hooks/useActionFeedback";
import { useLiveBridge } from "../hooks/useLiveBridge";
import { useLivePresets } from "../hooks/useLivePresets";
import { ACTION_UNAVAILABLE, type ActionResult } from "../lib/actionResult";
import {
  commands,
  type AmpAssignment,
  type AmpCapability_Serialize as AmpCapability,
  type AmpEditLock,
  type AmpModelCatalogEntry,
  type ChannelConfigSnapshot,
  type ChannelEq,
  type ChannelSource,
  type DiscoveredDevice,
  type PowerMode,
  type PresetSlot,
  type Project,
  type SourceChannelCount,
  type SourceKind,
  type Telemetry,
} from "../lib/bindings";
import {
  channelTelemetry,
  type ChannelTelemetry,
} from "../lib/channelTelemetry";
import {
  createProjectConfigureActions,
  lockConfigureActions,
  LOCKED_CONFIGURE_CAPABILITIES,
  PROJECT_CONFIGURE_CAPABILITIES,
  type ConfigureActions,
  type ConfigureCapabilities,
} from "../lib/configureActions";
import {
  buildLiveAssignmentViewModel,
  createLiveConfigureActions,
  LIVE_CONFIGURE_CAPABILITIES,
} from "../lib/liveConfigureAdapter";
import { FirPanel } from "./FirPanel";
import { usePreference } from "../lib/preferences";

/** Which project (persisted) or live device (Direct Edit, no project) this
 * Configure screen instance targets — the single seam that lets the same
 * capability-driven tab UI serve both modes (see `configureActions.ts`/
 * `liveConfigureAdapter.ts`). */
export type ConfigureSource =
  | {
      kind: "project";
      project: Project;
      assignment: AmpAssignment;
      ampModel?: AmpModelCatalogEntry;
      onProjectUpdate: (project: Project) => void;
      /** Edit-lock state for this amp (`useAmpEditLock`); `locked` makes the
       * whole editor read-only. */
      editLock?: AmpEditLock | null;
      /** The discovered network amp this project amp is linked to, if any. */
      linkedDevice?: DiscoveredDevice;
      /** Set while this amp is matched with its linked amp and following it
       * (`useLinkedSync`): the editor then reads and writes that amp
       * directly, exactly like Direct Edit, and the project mirrors it. */
      liveThrough?: {
        device: DiscoveredDevice;
        channelConfig?: ChannelConfigSnapshot;
        telemetry?: Telemetry;
      };
    }
  | {
      kind: "live";
      device: DiscoveredDevice;
      channelConfig?: ChannelConfigSnapshot;
      ampModel?: AmpModelCatalogEntry;
      /** Latest FC=6 heartbeat reading for this device, if one has arrived
       * (see `useLiveTelemetry`). Drives the meters and the V/A/°C/LIM stat
       * tiles; absent for a Project source and until the first heartbeat
       * lands, in which case every reading renders as unlit/"—" rather than
       * as a fabricated zero. */
      telemetry?: Telemetry;
    };

interface AmpConfigureViewProps {
  /** Omitted while a Project/live device hasn't been picked yet. */
  source?: ConfigureSource;
  /** Lets a parent that outlives this view own the selected tab, so the
   * selection survives anything that unmounts the editor — switching
   * between open amps, or a layout that re-renders around it. Uncontrolled
   * (falling back to internal state) when omitted. */
  activeTab?: string | null;
  onActiveTabChange?: (tab: string | null) => void;
}

type SkeletonVariant = "list" | "grid";

const DEFAULT_CHANNEL_COUNT = 4;

const LOCKED_MESSAGE = "Locked — the offline amp differs from the online amp.";

const TABS = [
  {
    value: "input",
    label: "Input",
    icon: SquareArrowRightEnter,
    skeleton: "list",
  },
  {
    value: "output",
    label: "Output",
    icon: SquareArrowRightExit,
    skeleton: "list",
  },
  { value: "routing", label: "Routing", icon: Route, skeleton: "grid" },
  {
    value: "presetConfiguration",
    label: "Preset Configuration",
    icon: ListPlus,
    skeleton: "list",
  },
] as const satisfies {
  value: string;
  label: string;
  icon: unknown;
  skeleton: SkeletonVariant;
}[];

/** Tabs wired to real capability + persisted values this phase — every other
 * tab keeps rendering `TabSkeleton` as before. Preset Configuration is
 * deliberately not in this set — it has no amp-model/capability dependency
 * at all (FC=59 is a live wire-protocol feature, not model-catalog-driven),
 * so it's special-cased in the render loop below instead of going through
 * the capability-gated dispatch every other tab here shares. */
const CONFIGURABLE_TABS = new Set(["input", "output", "routing"]);

const SOURCE_LABELS: Record<SourceKind, string> = {
  analog: "Analog",
  dante: "Dante",
  aes3: "AES3",
  backup: "Backup",
};

/** Source picker for a single channel — a flat list for single-channel
 * kinds (e.g. AES3), a hover sub-menu for multi-channel kinds (e.g. 4
 * physical Analog inputs on a 4-channel amp) so picking "Analog" also picks
 * *which* analog input feeds this channel. */
/** Source picker for a single digital input slot (`channelIndex`). Only
 * patchable kinds (Analog) get a free sub-menu of every physical input —
 * a non-patchable kind (Dante) is hard-wired 1:1 to this slot, so it's a
 * single fixed option ("Dante-N"), not a choice. */
/** Width of the Routing tab's Source column — wider than a strip tile, since
 * it holds a source name rather than a short number. The grid column reads
 * this too, so the tile always fills its column exactly. */
const SOURCE_TILE_WIDTH = 150;

function SourcePicker({
  source,
  sourceCounts,
  channelIndex,
  onSelect,
}: {
  source: ChannelSource;
  sourceCounts: SourceChannelCount[];
  channelIndex: number;
  onSelect: (kind: SourceKind, index: number) => Promise<ActionResult>;
}) {
  // The tile only opens the menu; the write fires from a menu item, so the
  // tile follows this controller rather than its own click.
  const feedback = useActionFeedback();
  const select = (kind: SourceKind, index: number) =>
    void feedback.track(onSelect(kind, index));

  return (
    <Menu shadow="md" width={180} position="bottom-start" withinPortal>
      <Menu.Target>
        <div>
          <StatEditorTile
            width={SOURCE_TILE_WIDTH}
            value={SOURCE_LABELS[source.kind]}
            label={`Input ${source.index + 1}`}
            visualValidation={feedback}
          />
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        {sourceCounts.map((sc) => {
          if (sc.patchable && sc.channelCount > 1) {
            return (
              <Menu
                key={sc.kind}
                trigger="hover"
                position="right-start"
                offset={4}
                shadow="md"
                withinPortal
              >
                <Menu.Target>
                  <Menu.Item rightSection={<ChevronRight size={14} />}>
                    {SOURCE_LABELS[sc.kind]}
                  </Menu.Item>
                </Menu.Target>
                <Menu.Dropdown>
                  {Array.from({ length: sc.channelCount }).map((_, i) => (
                    <Menu.Item key={i} onClick={() => select(sc.kind, i)}>
                      {SOURCE_LABELS[sc.kind]} {i + 1}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            );
          }
          // Not patchable (or only ever has one physical channel): a single
          // fixed option, pinned to this slot's own index for non-patchable
          // kinds (e.g. Dante channel N always feeds digital input N).
          const fixedIndex = sc.patchable ? 0 : channelIndex;
          return (
            <Menu.Item
              key={sc.kind}
              onClick={() => select(sc.kind, fixedIndex)}
            >
              {SOURCE_LABELS[sc.kind]} {fixedIndex + 1}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

/** The standard content shell for a tab whose body is a stack of rows:
 * vertically centered while it fits, plainly scrollable once it doesn't.
 * `Center` alone can't do both — a `Center` taller than its content clips
 * the overflow at *both* ends, so on a short or narrow window the first
 * rows became unreachable. The nested `min-h-full` column is what keeps
 * centering and scrolling from fighting each other. Padding steps down on
 * small windows, where 32px of gutter is a meaningful share of the width. */
/* Channel-strip column caps. Both the Input and Output panes render a
 * centred column of channel rows; without a cap a row's `wrap="wrap"` Group
 * simply grows to whatever the window gives it, which is why the Output tab
 * stretched edge-to-edge on a wide window while Input did not.
 *
 * The two values differ because the rows genuinely differ: an input row is a
 * meter plus 4 tiles, an output row a meter plus up to 12 (V, °C, Mute, Vol,
 * Trim, EQ, FIR, Delay, Pol, LIM, Gate, Mode). Each cap is that row's
 * natural one-line width — 72px per tile, a 10px `gap="xs"` between them,
 * plus the meter's 200px flex basis — so the row fills its cap exactly and
 * wraps below it rather than stranding a gutter or stretching. */
const INPUT_ROW_MAX_WIDTH = 760;
const OUTPUT_ROW_MAX_WIDTH = 1180;

function CenteredScrollPane({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="flex min-h-full min-w-0 flex-col justify-center gap-4 p-4">
        {children}
      </div>
    </div>
  );
}

function TabSkeleton({
  label,
  variant,
}: {
  label: string;
  variant: SkeletonVariant;
}) {
  return (
    <Stack h="100%" p="xl" gap="md">
      <Text fw={600}>{label}</Text>

      <Stack className="flex-1 opacity-50 pointer-events-none" gap="md">
        {variant === "list" && (
          <Stack gap="xs" className="flex-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={34} radius="sm" />
            ))}
          </Stack>
        )}

        {variant === "grid" && (
          <SimpleGrid
            cols={{ base: 2, xs: 3, sm: 4 }}
            spacing="md"
            className="flex-1 content-start"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} height={80} radius="md" />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      <Center>
        <Text size="xs" c="dimmed">
          Coming soon
        </Text>
      </Center>
    </Stack>
  );
}

interface ConfigurableTabProps {
  assignment: AmpAssignment;
  capability: AmpCapability;
  /** Latest heartbeat reading for a `"live"` source — `undefined` for a
   * Project source and before the first heartbeat arrives. Read through the
   * `channelTelemetry` helper rather than indexed directly, so a short
   * array (a firmware whose packet carries fewer channels than the model's
   * topology) degrades to `null`/unlit instead of `0`. */
  telemetry?: Telemetry;
  /** Every mutation a tab can make, targeting either a Project or a live
   * device — see `configureActions.ts`. Fields with no write support for
   * the current source (Project-only concepts, or live writes not built
   * yet) are simply absent; a handler guards with `if (!actions.setX)
   * return;` rather than assuming every field is always writable. */
  actions: ConfigureActions;
  capabilities: ConfigureCapabilities;
  /** The live amp this editor can reach right now, if any — Direct Edit's own
   * device or the online amp a project amp is following, and `undefined` once
   * that amp is offline or deliberately disengaged (see `liveAmpDeviceId`).
   * Distinct from `telemetry`'s "is there a live source at all": a tab reads
   * this to decide whether a *device-only* feature can be queried. Today just
   * FIR, whose coefficients exist nowhere but on the amp. */
  deviceId?: string;
}

const METER_FLOOR_DB = -60;

/** Shared dB scale for every channel level meter in this view. `0` is the
 * top for all of them, but means different things per tab: rated max output
 * on Output/Routing (`outputLevelDb`), and 1V on Input (`inputDbv`).
 * `-60` is `METER_FLOOR_DB`, the value a `null` reading renders at. */
const LEVEL_MARKS: VuMeterMark[] = [-60, -48, -36, -24, -12, 0].map(
  (value) => ({ value, label: String(value) }),
);

/** The one channel level meter used by every tab — Input, Output and
 * Routing all render this, so a meter reads identically wherever it appears
 * rather than each tab styling its own. `VuMeter` itself stays the generic
 * primitive (orientation, gradient, scale, thickness are all its props);
 * this fixes the single house style for a *channel level* reading, so those
 * choices live in one place instead of being re-decided per call site.
 *
 * `wide` drops the usual `maxWidth` cap — the Output tab's row wants the
 * meter to fill most of its width (matching the reference hardware view),
 * unlike the compact fixed-width meter every other tab uses.
 *
 * `levelDb` is `null` for a Project source, before the first heartbeat, and
 * for a channel with no signal — all of which render fully unlit, the same
 * as a real reading at the floor. The neighbouring stat tile reads "—"
 * rather than a number, which is what keeps those cases distinguishable. */
function ChannelLevelMeter({
  levelDb,
  disabled,
  wide,
}: {
  levelDb: number | null;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className="min-w-0"
      style={{
        flex: "1 1 200px",
        minWidth: 120,
        maxWidth: wide ? undefined : 260,
      }}
    >
      <VuMeter
        orientation="horizontal"
        min={METER_FLOOR_DB}
        max={0}
        value={levelDb ?? METER_FLOOR_DB}
        gradient={DEFAULT_LEVEL_GRADIENT}
        thickness={24}
        marks={LEVEL_MARKS}
        peakHold
        disabled={disabled}
      />
    </div>
  );
}

/** How many filters in a chain are engaged — the parametric bands plus the
 * two crossover slots. Only ever compared against zero (the EQ tile shows a
 * binary "is this chain doing anything"), but kept as a count because that
 * is the cheap thing to compute and callers may want more later. */
function activeFilterCount(eq: ChannelEq | undefined): number {
  if (!eq) return 0;
  let count = eq.bands.filter((band) => band.active).length;
  if (eq.hp.active) count += 1;
  if (eq.lp.active) count += 1;
  return count;
}

/** Click-to-rename label shared by `InputChannelRow`/`OutputChannelRow` —
 * shows the user-assigned `name` when set, otherwise the default numbered/
 * lettered label. Opens a small `Popover` with a `TextInput` capped at
 * `maxLength` (`AmpParamRanges.channelNameMaxLength`); saving an empty value
 * clears back to the default (`name: null`). */
function RenameableLabel({
  defaultLabel,
  name,
  maxLength,
  onRename,
  trailing,
}: {
  defaultLabel: string;
  name: string | null | undefined;
  maxLength: number;
  onRename: (name: string | null) => void;
  /** Status pills shown beside the name — the channel state, an input clip
   * flag. They live in this header rather than in the row's tile `Group`
   * because that row has a fixed width budget (`OUTPUT_ROW_MAX_WIDTH`) that
   * an extra item wraps, and because a pill that comes and goes with
   * telemetry would move the wrap point at runtime. The reference app floats
   * its pills over the card's top-left corner for the same reason. */
  trailing?: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(name ?? "");

  function commit() {
    const trimmed = draft.trim();
    onRename(trimmed.length > 0 ? trimmed : null);
    setOpened(false);
  }

  return (
    <Popover
      opened={opened}
      onChange={(o) => {
        setOpened(o);
        if (o) setDraft(name ?? "");
      }}
      position="bottom-start"
      withArrow
      shadow="md"
      width={220}
    >
      {/* The header's bottom margin belongs to whichever element is the
          outermost one here, so it stays a single 6px whether or not there
          are pills — putting it on the `Text` as well would double it. */}
      <Group gap={6} align="center" wrap="nowrap" mb={6} className="min-w-0">
        <Popover.Target>
          {/* A bordered tile rather than bare text: every other editable
           * value in the app is a Tile+Popover, and a plain label gave no
           * hint at all that the channel could be renamed — a hint that
           * can't be a hover effect, since this ships to touch. Sized to
           * its content, not to `STAT_TILE_W`, because the row beneath it
           * has a fixed width budget an oversized header would wrap. */}
          <UnstyledButton
            onClick={() => setOpened((o) => !o)}
            aria-label={`Rename channel (${name && name.length > 0 ? name : defaultLabel})`}
            px={6}
            py={2}
            className={`inline-flex min-w-0 shrink cursor-pointer items-center transition-colors duration-200 ${STAT_TILE_FOCUS}`}
            style={{
              borderRadius: "var(--mantine-radius-sm)",
              border: "1px solid var(--mantine-color-default-border)",
            }}
          >
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" truncate>
              {name && name.length > 0 ? name : defaultLabel}
            </Text>
          </UnstyledButton>
        </Popover.Target>
        {trailing}
      </Group>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
            Rename
          </Text>
          <TextInput
            size="sm"
            value={draft}
            maxLength={maxLength}
            placeholder={defaultLabel}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <Group gap="xs" justify="flex-end">
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                onRename(null);
                setDraft("");
                setOpened(false);
              }}
            >
              Reset
            </Button>
            <Button size="xs" onClick={commit}>
              Save
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function InputChannelRow({
  channel,
  telemetry,
  delayMin,
  delayMax,
  nameMaxLength,
  onDelayChange,
  onMuteToggle,
  onOpenEq,
  onRename,
}: {
  channel: AmpAssignment["channels"][number];
  telemetry: ChannelTelemetry;
  delayMin: number | null;
  delayMax: number | null;
  nameMaxLength: number;
  onDelayChange: (value: number) => Promise<ActionResult>;
  onMuteToggle: () => Promise<ActionResult>;
  onOpenEq: () => void;
  onRename: (name: string | null) => void;
}) {
  const [delayOpened, setDelayOpened] = useState(false);
  // The delay tile only opens its editor; the write is committed from the
  // popover, so the tile follows this controller rather than its own click.
  const delayFeedback = useActionFeedback();
  const muted = channel.inputMuted ?? false;
  const delayInMs = channel.delayInMs ?? 0;
  const eqActive = activeFilterCount(channel.inputEq);

  return (
    <div>
      <RenameableLabel
        defaultLabel={`In${channel.channelIndex + 1}`}
        name={channel.inputName}
        maxLength={nameMaxLength}
        onRename={onRename}
        trailing={<InputClipPill clipping={telemetry.inputClipping} raw={telemetry.inputStateRaw} />}
      />
      <Group gap="xs" wrap="wrap" align="center">
        <ChannelLevelMeter levelDb={telemetry.inputDbv} disabled={muted} />
        <StatReadout
          value={
            telemetry.inputDbv === null ? "—" : telemetry.inputDbv.toFixed(1)
          }
          label="dBV"
        />
        {/* Mute is the first control after the meter and its live readouts on
         * both the input and the output strip, so the one control that
         * silences a channel is always in the same place rather than at the
         * end of a queue of editors. */}
        <StatToggle
          label="Mute"
          engaged={muted}
          visualValidation
          onClick={onMuteToggle}
          icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        />
        <Popover
          opened={delayOpened}
          onChange={setDelayOpened}
          position="bottom"
          withArrow
          shadow="md"
          width={200}
        >
          {/* `StatEditorTile` forwards its ref to the underlying button, so
           * Popover.Target can take it directly — an intermediate `<div>`
           * here used to be an extra flex item with its own auto block
           * height, which rounded slightly differently than the button's own
           * fixed height and nudged the tile off the row's shared baseline.
           * (`display: contents` on that div was tried first, but it makes
           * the div report an empty bounding rect, which floating-ui's
           * `hideDetached` reads as "reference not visible" and never shows
           * the popover at all — a real ref avoids that entirely.) */}
          <Popover.Target>
            <StatEditorTile
              value={delayInMs.toFixed(1)}
              label="Delay ms"
              modified={delayInMs !== 0}
              visualValidation={delayFeedback}
              onClick={() => setDelayOpened((o) => !o)}
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Input Delay
              </Text>
              <CommitNumberInput
                value={delayInMs}
                min={delayMin ?? undefined}
                max={delayMax ?? undefined}
                step={0.5}
                suffix=" ms"
                onCommit={(value) =>
                  void delayFeedback.track(onDelayChange(value))
                }
              />
            </Stack>
          </Popover.Dropdown>
        </Popover>
        {/* Accented when the chain is doing anything at all. Deliberately
         * binary rather than a band count: a count says how many boxes are
         * ticked, not whether the channel is shaped — one band at +12 dB and
         * one at -0.5 dB both read as "2". */}
        <StatEditorTile
          label="EQ In"
          opens="view"
          modified={eqActive > 0}
          icon={<Activity size={16} />}
          onClick={onOpenEq}
        />
      </Group>
    </div>
  );
}

/** Per-channel vertical rail — the "third level" tab selector nested inside
 * the Input/Output tabs, alongside the top-level app tabs (now in the title
 * bar) and `AmpConfigureView`'s own tab list. Only shown in a sub-tab whose
 * content is scoped to one channel at a time (e.g. EQ, FIR); the plain
 * Input/Output sub-tab already shows every channel at once, so a channel
 * selector there would be redundant. `labelFor` lets callers keep each
 * axis's own convention — inputs are numbered, outputs are lettered. */
function ChannelRail({
  channels,
  activeChannelIndex,
  onSelectChannel,
  labelFor,
}: {
  channels: AmpAssignment["channels"];
  activeChannelIndex: number;
  onSelectChannel: (channelIndex: number) => void;
  labelFor: (channel: AmpAssignment["channels"][number]) => string;
}) {
  return (
    <Stack
      gap={4}
      p={4}
      w={44}
      justify="center"
      className="shrink-0 overflow-y-auto border-r border-[var(--mantine-color-default-border)]"
    >
      {channels.map((channel) => {
        const isActive = channel.channelIndex === activeChannelIndex;
        return (
          <UnstyledButton
            key={channel.channelIndex}
            onClick={() => onSelectChannel(channel.channelIndex)}
            p={4}
            className={`rounded-[var(--mantine-radius-sm)] border ${
              isActive
                ? "border-[var(--mantine-color-amber-filled)] bg-[var(--mantine-color-amber-light)]"
                : "border-transparent"
            }`}
          >
            <Text fz={11} fw={600} ta="center">
              {labelFor(channel)}
            </Text>
          </UnstyledButton>
        );
      })}
    </Stack>
  );
}

function InputTab({
  assignment,
  capability,
  actions,
  telemetry,
}: ConfigurableTabProps) {
  const { min, max } = capability.paramRanges.delayInMs;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const [eqChannelIndex, setEqChannelIndex] = useState(0);
  const [view, setView] = useState<string | null>("input");
  const eqChannel =
    assignment.channels.find((c) => c.channelIndex === eqChannelIndex) ??
    assignment.channels[0];

  async function handleDelayChange(channelIndex: number, delayInMs: number) {
    return actions.setChannelDelayIn(channelIndex, delayInMs);
  }

  async function handleMuteToggle(channelIndex: number, muted: boolean) {
    return actions.setChannelInputMute(channelIndex, muted);
  }

  async function handleRename(channelIndex: number, name: string | null) {
    if (!actions.setChannelName) return;
    await actions.setChannelName(channelIndex, "input", name);
  }

  function openEq(channelIndex: number) {
    setEqChannelIndex(channelIndex);
    setView("eq");
  }

  return (
    <div className="flex h-full min-w-0">
      {view === "eq" && (
        <ChannelRail
          channels={assignment.channels}
          activeChannelIndex={eqChannel.channelIndex}
          onSelectChannel={setEqChannelIndex}
          labelFor={(c) => String(c.channelIndex + 1)}
        />
      )}
      <Stack gap={0} className="min-w-0 flex-1">
        <Tabs value={view} onChange={setView} variant="pills" radius="sm">
          <Tabs.List className="justify-center" py={6}>
            <Tabs.Tab value="input">Input</Tabs.Tab>
            <Tabs.Tab value="eq">EQ</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <div className="min-h-0 flex-1">
          {view === "eq" ? (
            <div className="h-full overflow-y-auto">
              <EqEditor
                key={eqChannel.channelIndex}
                assignment={assignment}
                channelIndex={eqChannel.channelIndex}
                direction="input"
                capability={capability}
                actions={actions}
              />
            </div>
          ) : (
            <CenteredScrollPane>
              {/* Rows stretch to the pane so their tiles can wrap, but stop
               * at the width the meter's own cap plus four tiles actually
               * need — past that they'd sit in a sea of empty gutter. */}
              <Stack
                gap="md"
                w="100%"
                maw={INPUT_ROW_MAX_WIDTH}
                mx="auto"
                className="min-w-0"
              >
                {assignment.channels.map((channel) => (
                  <InputChannelRow
                    key={channel.channelIndex}
                    channel={channel}
                    telemetry={channelTelemetry(
                      telemetry,
                      channel.channelIndex,
                      ratedRmsVoltage,
                    )}
                    delayMin={min}
                    delayMax={max}
                    nameMaxLength={capability.paramRanges.channelNameMaxLength}
                    onDelayChange={(value) =>
                      handleDelayChange(channel.channelIndex, value)
                    }
                    onMuteToggle={() =>
                      handleMuteToggle(
                        channel.channelIndex,
                        !(channel.inputMuted ?? false),
                      )
                    }
                    onOpenEq={() => openEq(channel.channelIndex)}
                    onRename={(name) =>
                      handleRename(channel.channelIndex, name)
                    }
                  />
                ))}
              </Stack>
            </CenteredScrollPane>
          )}
        </div>
      </Stack>
    </div>
  );
}

const POWER_MODE_LABELS: Record<PowerMode, string> = {
  lowOhm: "Low-Ω",
  v70: "70V",
  v100: "100V",
};

function OutputChannelRow({
  channel,
  telemetry,
  trimMin,
  trimMax,
  volumeMin,
  volumeMax,
  delayMin,
  delayMax,
  noiseGateThresholdMin,
  noiseGateThresholdMax,
  noiseGateThresholdAdjustable,
  nameMaxLength,
  powerModes,
  onChange,
  onOpenFir,
  onOpenEq,
  onOpenLimiter,
  onNoiseGateChange,
  onPhaseInvertToggle,
  onPowerModeChange,
  onMuteToggle,
  onRename,
}: {
  channel: AmpAssignment["channels"][number];
  telemetry: ChannelTelemetry;
  trimMin: number | null;
  trimMax: number | null;
  volumeMin: number | null;
  volumeMax: number | null;
  delayMin: number | null;
  delayMax: number | null;
  noiseGateThresholdMin: number | null;
  noiseGateThresholdMax: number | null;
  noiseGateThresholdAdjustable: boolean;
  nameMaxLength: number;
  /** Which power/impedance modes the assigned model actually offers — read
   * from `capability.topology.powerModes`, not hardcoded, so a future model
   * that restricts modes is respected automatically. */
  powerModes: PowerMode[];
  onChange: (
    field: "trim" | "volume" | "delay",
    value: number,
  ) => Promise<ActionResult>;
  onOpenFir: () => void;
  onOpenEq: () => void;
  onOpenLimiter: () => void;
  onNoiseGateChange: (
    enabled: boolean,
    thresholdDbu: number,
  ) => Promise<ActionResult>;
  onPhaseInvertToggle: () => Promise<ActionResult>;
  onPowerModeChange: (mode: PowerMode) => Promise<ActionResult>;
  onMuteToggle: () => Promise<ActionResult>;
  onRename: (name: string | null) => void;
}) {
  const [openPopover, setOpenPopover] = useState<
    "trim" | "volume" | "delay" | "gate" | "mode" | null
  >(null);
  // One controller per tile whose request is committed from a popover rather
  // than fired by the tile's own click (see `VisualValidation`). Tiles whose
  // click *is* the request (Mute, Pol, the direct Gate toggle) track
  // themselves via `visualValidation`. LIM/FIR/EQ only navigate, so they have
  // nothing to validate.
  const volumeFeedback = useActionFeedback();
  const trimFeedback = useActionFeedback();
  const delayFeedback = useActionFeedback();
  const modeFeedback = useActionFeedback();
  const gateFeedback = useActionFeedback();
  const trimDb = channel.outputTrimDb ?? 0;
  const volumeDb = channel.outputVolumeDb ?? 0;
  const delayMs = channel.delayOutMs ?? 0;
  const noiseGateEnabled = channel.noiseGateEnabled ?? false;
  const noiseGateThresholdDbu = channel.noiseGateThresholdDbu ?? 0;
  const phaseInverted = channel.outputPhaseInverted ?? false;
  const muted = channel.outputMuted ?? false;
  const powerMode = channel.powerMode ?? "lowOhm";
  const eqActive = activeFilterCount(channel.outputEq);

  return (
    <div>
      <RenameableLabel
        defaultLabel={`Out${String.fromCharCode(65 + channel.channelIndex)}`}
        name={channel.outputName}
        maxLength={nameMaxLength}
        onRename={onRename}
        trailing={
          <ChannelStateBadge
            state={telemetry.outputState}
            raw={telemetry.outputStateRaw}
            hideNominal
          />
        }
      />
      <Group gap="xs" wrap="wrap" align="center">
        {/* Grouped by role, left to right in rough order of how often each is
         * touched: live readouts beside the meter, then level (Mute/Vol/Trim),
         * speaker tuning (EQ/FIR/Delay/Pol), dynamics (LIM/Gate), and the amp
         * hardware setting (Mode) last. Deliberately not a signal-flow order —
         * the CVR DSP chain order is not confirmed. */}
        <ChannelLevelMeter
          levelDb={telemetry.outputLevelDb}
          disabled={muted}
          wide
        />
        <StatReadout
          value={
            telemetry.outputVoltage === null
              ? "—"
              : telemetry.outputVoltage.toFixed(1)
          }
          label="V"
        />
        <StatReadout
          value={
            telemetry.temperatureC === null
              ? "—"
              : telemetry.temperatureC.toFixed(1)
          }
          label="°C"
        />
        {/* Same slot as on the input strip — see the note in InputChannelRow. */}
        <StatToggle
          label="Mute"
          engaged={muted}
          visualValidation
          onClick={onMuteToggle}
          icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        />
        <Popover
          opened={openPopover === "volume"}
          onChange={(o) => setOpenPopover(o ? "volume" : null)}
          position="bottom"
          withArrow
          shadow="md"
          width={200}
        >
          {/* No wrapper div — see the note on the Delay tile in
           * InputChannelRow. */}
          <Popover.Target>
            <StatEditorTile
              value={volumeDb.toFixed(1)}
              label="Vol dB"
              modified={volumeDb !== 0}
              visualValidation={volumeFeedback}
              onClick={() =>
                setOpenPopover((o) => (o === "volume" ? null : "volume"))
              }
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Output Volume
              </Text>
              <CommitNumberInput
                value={volumeDb}
                min={volumeMin ?? undefined}
                max={volumeMax ?? undefined}
                step={0.5}
                suffix=" dB"
                onCommit={(value) =>
                  void volumeFeedback.track(onChange("volume", value))
                }
              />
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <Popover
          opened={openPopover === "trim"}
          onChange={(o) => setOpenPopover(o ? "trim" : null)}
          position="bottom"
          withArrow
          shadow="md"
          width={200}
        >
          {/* No wrapper div — see the note on the Delay tile in
           * InputChannelRow. */}
          <Popover.Target>
            <StatEditorTile
              value={trimDb.toFixed(1)}
              label="Trim dB"
              modified={trimDb !== 0}
              visualValidation={trimFeedback}
              onClick={() =>
                setOpenPopover((o) => (o === "trim" ? null : "trim"))
              }
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Output Trim
              </Text>
              <CommitNumberInput
                value={trimDb}
                min={trimMin ?? undefined}
                max={trimMax ?? undefined}
                step={0.5}
                suffix=" dB"
                onCommit={(value) =>
                  void trimFeedback.track(onChange("trim", value))
                }
              />
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <StatEditorTile
          label="EQ Out"
          opens="view"
          modified={eqActive > 0}
          icon={<Activity size={16} />}
          onClick={onOpenEq}
        />
        <StatEditorTile
          label="FIR"
          opens="view"
          icon={<Waves size={16} />}
          onClick={onOpenFir}
        />
        <Popover
          opened={openPopover === "delay"}
          onChange={(o) => setOpenPopover(o ? "delay" : null)}
          position="bottom"
          withArrow
          shadow="md"
          width={200}
        >
          {/* No wrapper div — see the note on the Delay tile in
           * InputChannelRow. */}
          <Popover.Target>
            <StatEditorTile
              value={delayMs.toFixed(1)}
              label="Delay ms"
              modified={delayMs !== 0}
              visualValidation={delayFeedback}
              onClick={() =>
                setOpenPopover((o) => (o === "delay" ? null : "delay"))
              }
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Output Delay
              </Text>
              <CommitNumberInput
                value={delayMs}
                min={delayMin ?? undefined}
                max={delayMax ?? undefined}
                step={0.5}
                suffix=" ms"
                onCommit={(value) =>
                  void delayFeedback.track(onChange("delay", value))
                }
              />
            </Stack>
          </Popover.Dropdown>
        </Popover>
        {/* Amber, not red: an inverted polarity is a deliberate setting, and
         * red is reserved for "this channel's audio is cut". */}
        <StatToggle
          label="Pol"
          engaged={phaseInverted}
          accent="var(--mantine-color-amber-6)"
          visualValidation
          onClick={onPhaseInvertToggle}
          icon={<FlipVertical2 size={16} />}
        />
        <StatEditorTile
          label="LIM"
          opens="view"
          onClick={onOpenLimiter}
          // Accented only while the limiter is actually pulling gain down, so
          // the tile doubles as a live "limiting now" indicator instead of a
          // permanently-highlighted button. Icon-only now — the live gain
          // reduction dB reads as a precise measurement when it's really a
          // momentary number that stops mattering the instant you look away;
          // the accent alone answers "is it limiting right now."
          modified={
            telemetry.gainReductionDb !== null && telemetry.gainReductionDb < 0
          }
          accent="var(--mantine-color-red-6)"
          icon={<ListPlus size={16} />}
        />
        {/* Firmware without an adjustable threshold (1.1.8) has nothing to
         * put in a dropdown but the same on/off state the pill already
         * shows — a popover there was a second click to reach a switch that
         * duplicates the pill itself. That firmware gets a direct toggle;
         * only firmware with a real threshold field (`noiseGateThresholdAdjustable`)
         * gets the popover. */}
        {noiseGateThresholdAdjustable ? (
          <Popover
            opened={openPopover === "gate"}
            onChange={(o) => setOpenPopover(o ? "gate" : null)}
            position="bottom"
            withArrow
            shadow="md"
            width={200}
          >
            {/* No wrapper div — see the note on the Delay tile in
             * InputChannelRow. A hybrid otherwise: it opens a popover, but
             * its enabled/disabled state is what matters at a glance, so it
             * wears the toggle styling. */}
            <Popover.Target>
              <StatToggle
                label="Gate"
                engaged={noiseGateEnabled}
                accent="var(--mantine-color-amber-6)"
                visualValidation={gateFeedback}
                onClick={() =>
                  setOpenPopover((o) => (o === "gate" ? null : "gate"))
                }
                icon={<ShieldAlert size={16} />}
              />
            </Popover.Target>
            <Popover.Dropdown>
              <Stack gap="sm">
                <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                  Noise Gate
                </Text>
                <Switch
                  size="sm"
                  label="Enabled"
                  checked={noiseGateEnabled}
                  onChange={(e) =>
                    void gateFeedback.track(
                      onNoiseGateChange(
                        e.currentTarget.checked,
                        noiseGateThresholdDbu,
                      ),
                    )
                  }
                />
                <NumberInput
                  size="sm"
                  value={noiseGateThresholdDbu}
                  min={noiseGateThresholdMin ?? undefined}
                  max={noiseGateThresholdMax ?? undefined}
                  step={0.5}
                  suffix=" dBu"
                  onChange={(value) => {
                    if (typeof value === "number") {
                      void gateFeedback.track(
                        onNoiseGateChange(noiseGateEnabled, value),
                      );
                    }
                  }}
                />
              </Stack>
            </Popover.Dropdown>
          </Popover>
        ) : (
          <StatToggle
            label="Gate"
            engaged={noiseGateEnabled}
            accent="var(--mantine-color-amber-6)"
            visualValidation
            onClick={() =>
              onNoiseGateChange(!noiseGateEnabled, noiseGateThresholdDbu)
            }
            icon={<ShieldAlert size={16} />}
          />
        )}
        {/* Last, and as far from Mute as the row allows: power mode is rarely
         * changed, and switching Low-Ω/70V/100V on a live system is not a
         * click that should sit next to one people make quickly. */}
        <Popover
          opened={openPopover === "mode"}
          onChange={(o) => setOpenPopover(o ? "mode" : null)}
          position="bottom"
          withArrow
          shadow="md"
          width={180}
        >
          {/* No wrapper div — see the note on the Delay tile in
           * InputChannelRow. */}
          <Popover.Target>
            <StatEditorTile
              value={POWER_MODE_LABELS[powerMode]}
              label="Mode"
              visualValidation={modeFeedback}
              onClick={() =>
                setOpenPopover((o) => (o === "mode" ? null : "mode"))
              }
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Power Mode
              </Text>
              <Select
                size="sm"
                data={powerModes.map((mode) => ({
                  value: mode,
                  label: POWER_MODE_LABELS[mode],
                }))}
                value={powerMode}
                allowDeselect={false}
                onChange={(value) => {
                  if (value)
                    void modeFeedback.track(
                      onPowerModeChange(value as PowerMode),
                    );
                }}
              />
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Group>
    </div>
  );
}

/** Shown on the bridge controls when the active source has no
 * `setOutputBridge`. Direct Edit mode is the case that matters: the write
 * command exists, but nothing reads bridge state back off the device (it is
 * absent from FC=27 — see `liveConfigureAdapter`'s `outputBridged` note), so
 * offering the toggle would mean changing a power amp's output topology with
 * no way to confirm or even display that it happened. */
const BRIDGE_UNAVAILABLE_REASON =
  "Bridging isn't available for a live device yet — the amp doesn't report bridge state back, so the app can't show whether it took effect.";

/** Colored sidebar spanning a bridged output pair's two rows — matches the
 * reference hardware view's rotated `{A}/{B}` `ON`/`OFF` bar. This app has
 * no live status distinct from planned config the way real hardware does,
 * so the sidebar doubles as the toggle control itself (click to flip
 * `output_bridged`) as well as the status display, unlike the reference
 * where the equivalent control lives elsewhere. */
function BridgePairSidebar({
  leaderLetter,
  followerLetter,
  bridged,
  disabled,
  onClick,
}: {
  leaderLetter: string;
  followerLetter: string;
  bridged: boolean;
  /** No `setOutputBridge` for this source. Rendered visibly dead with a
   * reason rather than accepting the click and dropping it — see
   * `BRIDGE_UNAVAILABLE_REASON`. */
  disabled?: boolean;
  onClick: () => void;
}) {
  const bar = (
    <UnstyledButton
      onClick={disabled ? undefined : onClick}
      w={28}
      bdrs="sm"
      bd={`1px solid ${bridged ? "var(--mantine-color-green-6)" : "var(--mantine-color-default-border)"}`}
      className={disabled ? "cursor-not-allowed opacity-[0.45]" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bridged
          ? "color-mix(in srgb, var(--mantine-color-green-light) 50%, transparent)"
          : undefined,
      }}
    >
      <Text
        size="xs"
        fw={700}
        c={bridged ? "green" : "dimmed"}
        style={{
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          whiteSpace: "nowrap",
        }}
      >
        {leaderLetter}/{followerLetter} {bridged ? "ON" : "OFF"}
      </Text>
    </UnstyledButton>
  );
  return disabled ? (
    <Tooltip
      label={BRIDGE_UNAVAILABLE_REASON}
      multiline
      w={240}
      withArrow
      position="right"
    >
      <div style={{ display: "flex" }}>{bar}</div>
    </Tooltip>
  ) : (
    bar
  );
}

function OutputTab({
  assignment,
  capability,
  actions,
  capabilities,
  telemetry,
  deviceId,
}: ConfigurableTabProps) {
  const trimRange = capability.paramRanges.outputTrimDb;
  const volumeRange = capability.paramRanges.outputVolumeDb;
  const delayRange = capability.paramRanges.delayOutMs;
  const noiseGateThresholdRange = capability.paramRanges.noiseGateThresholdDbu;
  const nameMaxLength = capability.paramRanges.channelNameMaxLength;
  const noiseGateThresholdAdjustable = capability.firmware.noiseGateThreshold;
  const powerModes = capability.topology.powerModes;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const [subChannelIndex, setSubChannelIndex] = useState(0);
  const [view, setView] = useState<string | null>("output");
  const subChannel =
    assignment.channels.find((c) => c.channelIndex === subChannelIndex) ??
    assignment.channels[0];

  async function handleChange(
    channelIndex: number,
    field: "trim" | "volume" | "delay",
    value: number,
  ) {
    return actions.setChannelOutput(
      channelIndex,
      field === "trim" ? value : null,
      field === "volume" ? value : null,
      field === "delay" ? value : null,
    );
  }

  async function handleNoiseGateChange(
    channelIndex: number,
    enabled: boolean,
    thresholdDbu: number,
  ) {
    if (!actions.setChannelNoiseGate) return ACTION_UNAVAILABLE;
    return actions.setChannelNoiseGate(channelIndex, enabled, thresholdDbu);
  }

  async function handlePhaseInvertToggle(
    channelIndex: number,
    inverted: boolean,
  ) {
    return actions.setChannelPhaseInvert(channelIndex, inverted);
  }

  async function handleRename(channelIndex: number, name: string | null) {
    if (!actions.setChannelName) return;
    await actions.setChannelName(channelIndex, "output", name);
  }

  async function handleMuteToggle(channelIndex: number, muted: boolean) {
    return actions.setChannelOutputMute(channelIndex, muted);
  }

  async function handlePowerModeChange(channelIndex: number, mode: PowerMode) {
    return actions.setChannelPowerMode(channelIndex, mode);
  }

  async function handleBridgeToggle(
    pairLeaderChannelIndex: number,
    bridged: boolean,
  ) {
    if (!actions.setOutputBridge) return;
    await actions.setOutputBridge(pairLeaderChannelIndex, bridged);
  }

  function openSubTab(channelIndex: number, target: "fir" | "eq" | "limiter") {
    setSubChannelIndex(channelIndex);
    setView(target);
  }

  const letterLabel = (c: AmpAssignment["channels"][number]) =>
    String.fromCharCode(65 + c.channelIndex);

  // Fixed adjacent pairing (0,1), (2,3), … — mirrors the old app's bridging
  // convention. A trailing unpaired channel (odd total count) has no
  // partner and no bridge option, per `AmpChannel.output_bridged`'s doc
  // comment.
  const channelPairs: Array<
    [
      AmpAssignment["channels"][number],
      AmpAssignment["channels"][number] | undefined,
    ]
  > = [];
  for (let i = 0; i < assignment.channels.length; i += 2) {
    channelPairs.push([assignment.channels[i], assignment.channels[i + 1]]);
  }

  return (
    <div className="flex h-full min-w-0">
      {(view === "fir" || view === "eq" || view === "limiter") && (
        <ChannelRail
          channels={assignment.channels}
          activeChannelIndex={subChannel.channelIndex}
          onSelectChannel={setSubChannelIndex}
          labelFor={letterLabel}
        />
      )}
      <Stack gap={0} className="min-w-0 flex-1">
        <Tabs value={view} onChange={setView} variant="pills" radius="sm">
          <Tabs.List className="justify-center" py={6}>
            <Tabs.Tab value="output">Output</Tabs.Tab>
            <Tabs.Tab value="fir">FIR</Tabs.Tab>
            <Tabs.Tab value="eq">EQ</Tabs.Tab>
            <Tabs.Tab value="limiter">Limiter</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <div className="min-h-0 flex-1">
          {view === "fir" ? (
            <FirPanel
              key={subChannel.channelIndex}
              deviceId={deviceId}
              channelIndex={subChannel.channelIndex}
              label={letterLabel(subChannel)}
              capability={capability}
            />
          ) : view === "eq" ? (
            <div className="h-full overflow-y-auto">
              <EqEditor
                key={subChannel.channelIndex}
                assignment={assignment}
                channelIndex={subChannel.channelIndex}
                direction="output"
                capability={capability}
                actions={actions}
              />
            </div>
          ) : view === "limiter" ? (
            <CenteredScrollPane>
              <LimiterEditor
                key={subChannel.channelIndex}
                assignment={assignment}
                channelIndex={subChannel.channelIndex}
                telemetry={channelTelemetry(
                  telemetry,
                  subChannel.channelIndex,
                  ratedRmsVoltage,
                )}
                capability={capability}
                actions={actions}
                capabilities={capabilities}
              />
            </CenteredScrollPane>
          ) : (
            <CenteredScrollPane>
              {/* Same centred, width-capped column as the Input tab — see
               * OUTPUT_ROW_MAX_WIDTH. */}
              <Stack
                gap="md"
                w="100%"
                maw={OUTPUT_ROW_MAX_WIDTH}
                mx="auto"
                className="min-w-0"
              >
                {channelPairs.map(([leader, follower]) => {
                  const bridged = Boolean(
                    follower && (leader.outputBridged ?? false),
                  );
                  const row = (channel: AmpAssignment["channels"][number]) => (
                    <OutputChannelRow
                      key={channel.channelIndex}
                      channel={channel}
                      telemetry={channelTelemetry(
                        telemetry,
                        channel.channelIndex,
                        ratedRmsVoltage,
                      )}
                      trimMin={trimRange.min}
                      trimMax={trimRange.max}
                      volumeMin={volumeRange.min}
                      volumeMax={volumeRange.max}
                      delayMin={delayRange.min}
                      delayMax={delayRange.max}
                      noiseGateThresholdMin={noiseGateThresholdRange.min}
                      noiseGateThresholdMax={noiseGateThresholdRange.max}
                      noiseGateThresholdAdjustable={
                        noiseGateThresholdAdjustable
                      }
                      nameMaxLength={nameMaxLength}
                      powerModes={powerModes}
                      onChange={(field, value) =>
                        handleChange(channel.channelIndex, field, value)
                      }
                      onOpenFir={() => openSubTab(channel.channelIndex, "fir")}
                      onOpenEq={() => openSubTab(channel.channelIndex, "eq")}
                      onOpenLimiter={() =>
                        openSubTab(channel.channelIndex, "limiter")
                      }
                      onNoiseGateChange={(enabled, thresholdDbu) =>
                        handleNoiseGateChange(
                          channel.channelIndex,
                          enabled,
                          thresholdDbu,
                        )
                      }
                      onPhaseInvertToggle={() =>
                        handlePhaseInvertToggle(
                          channel.channelIndex,
                          !(channel.outputPhaseInverted ?? false),
                        )
                      }
                      onPowerModeChange={(mode) =>
                        handlePowerModeChange(channel.channelIndex, mode)
                      }
                      onMuteToggle={() =>
                        handleMuteToggle(
                          channel.channelIndex,
                          !(channel.outputMuted ?? false),
                        )
                      }
                      onRename={(name) =>
                        handleRename(channel.channelIndex, name)
                      }
                    />
                  );
                  if (!follower) {
                    return (
                      <Fragment key={leader.channelIndex}>
                        {row(leader)}
                      </Fragment>
                    );
                  }
                  return (
                    <Group
                      key={leader.channelIndex}
                      align="stretch"
                      wrap="nowrap"
                      gap="xs"
                    >
                      <BridgePairSidebar
                        leaderLetter={letterLabel(leader)}
                        followerLetter={letterLabel(follower)}
                        bridged={bridged}
                        disabled={!actions.setOutputBridge}
                        onClick={() =>
                          handleBridgeToggle(leader.channelIndex, !bridged)
                        }
                      />
                      <Stack gap="md" className="flex-1 min-w-0">
                        {row(leader)}
                        <div
                          style={{
                            opacity: bridged ? 0.4 : 1,
                            pointerEvents: bridged ? "none" : "auto",
                            filter: bridged ? "grayscale(1)" : "none",
                          }}
                        >
                          {row(follower)}
                        </div>
                      </Stack>
                    </Group>
                  );
                })}
              </Stack>
            </CenteredScrollPane>
          )}
        </div>
      </Stack>
    </div>
  );
}

function MatrixCrosspointCell({
  active,
  gainDb,
  min,
  max,
  onGainChange,
  onActiveChange,
  onHoverChange,
}: {
  active: boolean;
  gainDb: number;
  min: number | null;
  max: number | null;
  onGainChange: (gainDb: number) => Promise<ActionResult>;
  onActiveChange: (active: boolean) => Promise<ActionResult>;
  onHoverChange: (hovering: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  // Both writes — gain and enable/disable — are committed from the popover,
  // so the tile follows this controller rather than its own click.
  const feedback = useActionFeedback();

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom"
      withArrow
      shadow="md"
      width={200}
    >
      <Popover.Target>
        {/* The wrapper carries the hover tracking that lights up this cell's
         * row and column headers, since the tile itself takes no mouse
         * handlers. */}
        <div
          onMouseEnter={() => onHoverChange(true)}
          onMouseLeave={() => onHoverChange(false)}
        >
          <StatEditorTile
            value={active ? `${gainDb.toFixed(1)} dB` : "Mute"}
            label={active ? "Active" : "Bypassed"}
            // An active crosspoint is routing engaged, which is what the
            // amber accent means on every other tile.
            modified={active}
            visualValidation={feedback}
            onClick={() => setOpened((o) => !o)}
          />
        </div>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
            Matrix Gain
          </Text>
          {/* Commit-on-blur/Enter like every other tile's popover, rather than
           * a write per keystroke — see `CommitNumberInput`. */}
          <CommitNumberInput
            value={gainDb}
            min={min ?? undefined}
            max={max ?? undefined}
            step={0.5}
            suffix=" dB"
            onCommit={(value) => void feedback.track(onGainChange(value))}
          />
          <Button
            fullWidth
            variant={active ? "filled" : "default"}
            onClick={() => void feedback.track(onActiveChange(!active))}
          >
            {active ? "Disable" : "Enable"}
          </Button>
          {min != null && max != null && (
            <Text size="xs" c="dimmed" ta="center">
              Range: {min.toFixed(1)} to {max > 0 ? "+" : ""}
              {max.toFixed(1)} dB
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Combines Source Selection and Matrix into one page: each channel row
 * picks its physical source and sets its matrix crosspoints side by side,
 * since both are "what feeds this channel" decisions a user makes together
 * when wiring up a routing scheme. */
function RoutingTab({
  assignment,
  capability,
  actions,
  telemetry,
}: ConfigurableTabProps) {
  const { min, max } = capability.paramRanges.matrixGainDb;
  const ratedRmsVoltage = capability.topology.ratedRmsVoltage;
  const sourceCount = capability.topology.matrixInputCount;
  const sourceCounts = capability.topology.sourceCounts;
  const [hoveredCell, setHoveredCell] = useState<{
    channelIndex: number;
    sourceIndex: number;
  } | null>(null);

  async function handleSourceChange(
    channelIndex: number,
    kind: SourceKind,
    index: number,
  ) {
    if (!actions.setChannelSource) return ACTION_UNAVAILABLE;
    return actions.setChannelSource(channelIndex, kind, index);
  }

  async function handleGainChange(
    channelIndex: number,
    sourceIndex: number,
    gainDb: number,
  ) {
    if (!actions.setMatrixCrosspoint) return ACTION_UNAVAILABLE;
    return actions.setMatrixCrosspoint(channelIndex, sourceIndex, gainDb, null);
  }

  async function handleActiveChange(
    channelIndex: number,
    sourceIndex: number,
    active: boolean,
  ) {
    if (!actions.setMatrixCrosspoint) return ACTION_UNAVAILABLE;
    return actions.setMatrixCrosspoint(channelIndex, sourceIndex, null, active);
  }

  return (
    <CenteredScrollPane>
      <Stack gap="md" align="center" className="min-w-0">
        <Text fw={600}>Routing</Text>
        {/* The matrix has an irreducible width (one tile-wide column per source),
         * so it stays a fixed grid and scrolls sideways inside its own
         * `ScrollArea` on a narrow window rather than squeezing columns to
         * illegibility. `max-w-full`/`min-w-0` is what stops that intrinsic
         * width from instead pushing the whole page wider than the window. */}
        <ScrollArea
          offsetScrollbars
          type="auto"
          scrollbarSize={8}
          className="min-w-0 max-w-full"
        >
          <div
            style={{
              display: "grid",
              // Crosspoint columns match `StatEditorTile`'s default 72px, and
              // the Source column matches `SOURCE_TILE_WIDTH`, so every cell
              // fills its column exactly.
              gridTemplateColumns: `20px ${SOURCE_TILE_WIDTH}px 28px repeat(${sourceCount}, 72px) minmax(150px, 230px)`,
              alignItems: "center",
              columnGap: 12,
              rowGap: 8,
            }}
          >
            <div />
            <div />
            <div />
            <Text
              size="xs"
              c="dimmed"
              ta="center"
              fw={600}
              style={{ gridColumn: `span ${sourceCount}` }}
            >
              Input
            </Text>
            <div />

            <div />
            <Text size="xs" c="dimmed" ta="center">
              Source
            </Text>
            <div />
            {Array.from({ length: sourceCount }).map((_, i) => {
              const highlighted = hoveredCell?.sourceIndex === i;
              return (
                <Stack key={i} gap={6} align="center">
                  <Text
                    size="sm"
                    ta="center"
                    style={{
                      color: highlighted
                        ? "var(--mantine-color-text)"
                        : "var(--mantine-color-dimmed)",
                      transition: "color 150ms ease",
                    }}
                  >
                    {i + 1}
                  </Text>
                  <div
                    style={{
                      width: 20,
                      height: 2,
                      borderRadius: 1,
                      backgroundColor: "var(--mantine-color-text)",
                      opacity: highlighted ? 1 : 0,
                      transition: "opacity 150ms ease",
                    }}
                  />
                </Stack>
              );
            })}
            <Text size="xs" c="dimmed" ta="center">
              Output
            </Text>

            {assignment.channels.map((channel) => {
              const highlighted =
                hoveredCell?.channelIndex === channel.channelIndex;
              return (
                <Fragment key={channel.channelIndex}>
                  <Text size="sm" c="dimmed">
                    {channel.channelIndex + 1}
                  </Text>
                  <SourcePicker
                    source={channel.source}
                    sourceCounts={sourceCounts}
                    channelIndex={channel.channelIndex}
                    onSelect={(kind, index) =>
                      handleSourceChange(channel.channelIndex, kind, index)
                    }
                  />
                  <div />
                  {/* Indexed by column (sourceCount), not by the raw stored
                   * array — keeps the grid's column count authoritative even
                   * if a project's stored crosspoints haven't been
                   * reconciled to the current topology yet. */}
                  {Array.from({ length: sourceCount }).map((_, sourceIndex) => {
                    const crosspoint = channel.matrixCrosspoints?.find(
                      (c) => c.sourceIndex === sourceIndex,
                    ) ?? {
                      sourceIndex,
                      gainDb: 0,
                      active: false,
                    };
                    return (
                      <MatrixCrosspointCell
                        key={sourceIndex}
                        active={crosspoint.active}
                        gainDb={crosspoint.gainDb ?? 0}
                        min={min}
                        max={max}
                        onGainChange={(value) =>
                          handleGainChange(
                            channel.channelIndex,
                            sourceIndex,
                            value,
                          )
                        }
                        onActiveChange={(value) =>
                          handleActiveChange(
                            channel.channelIndex,
                            sourceIndex,
                            value,
                          )
                        }
                        onHoverChange={(hovering) =>
                          setHoveredCell(
                            hovering
                              ? {
                                  channelIndex: channel.channelIndex,
                                  sourceIndex,
                                }
                              : null,
                          )
                        }
                      />
                    );
                  })}
                  <Group gap={8} wrap="nowrap" align="center">
                    <Group gap={8} wrap="nowrap" align="center">
                      <div
                        style={{
                          width: 2,
                          height: 20,
                          borderRadius: 1,
                          backgroundColor: "var(--mantine-color-text)",
                          opacity: highlighted ? 1 : 0,
                          transition: "opacity 150ms ease",
                        }}
                      />
                      <Text
                        size="sm"
                        fw={600}
                        style={{
                          color: highlighted
                            ? "var(--mantine-color-text)"
                            : "var(--mantine-color-dimmed)",
                          transition: "color 150ms ease",
                        }}
                      >
                        {String.fromCharCode(65 + channel.channelIndex)}
                      </Text>
                    </Group>
                    <ChannelLevelMeter
                      levelDb={
                        channelTelemetry(
                          telemetry,
                          channel.channelIndex,
                          ratedRmsVoltage,
                        ).outputLevelDb
                      }
                    />
                  </Group>
                </Fragment>
              );
            })}
          </div>
        </ScrollArea>
      </Stack>
    </CenteredScrollPane>
  );
}

/** True for a slot the device reports as unused. The FC=59 list parser
 * returns every slot verbatim (empty/`"null"` filtering is explicitly a UI
 * concern, see `parse_preset_list`), and the device spells "unused" two
 * different ways depending on whether the slot was never written or was
 * cleared, so both collapse to the same empty state here. */
function isEmptySlot(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === "null";
}

/** One row of the preset list. Kept deliberately thin: with 40 slots, a
 * card per preset put ~80 labelled buttons on screen at once, which read as
 * a wall rather than a list you scan. Actions are icon-only with tooltips,
 * and an empty slot renders no Recall control at all rather than a greyed
 * one — on a mostly-empty device that alone removes most of the clutter.
 *
 * Store is the destructive half (it overwrites the slot with the amp's
 * current DSP state, and the wire protocol offers no undo), so it never
 * fires straight from the row — it opens a popover that names the slot,
 * warns when it is about to overwrite, and requires a second click. */
function PresetSlotRow({
  slot,
  isActive,
  storeOpened,
  onStoreOpenChange,
  onRecall,
  onStore,
}: {
  slot: PresetSlot;
  isActive: boolean;
  storeOpened: boolean;
  onStoreOpenChange: (opened: boolean) => void;
  onRecall: () => Promise<ActionResult>;
  onStore: (name: string) => Promise<ActionResult>;
}) {
  const empty = isEmptySlot(slot.name);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Store is committed from the popover's confirm button, not the tile's own
  // click, so the Store tile follows this controller.
  const storeFeedback = useActionFeedback();

  async function commitStore() {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || saving) return;
    setSaving(true);
    const outcome = await storeFeedback.track(onStore(trimmed));
    setSaving(false);
    // Closes only on success: after a failure the typed name is still in the
    // field, ready to retry, and the toast explains what went wrong.
    if (outcome === "success") onStoreOpenChange(false);
  }

  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="xs"
      py={5}
      // Empty slots recede and lift on hover — the same treatment bypassed
      // columns get in the EQ strip, so "present but not doing anything"
      // looks the same everywhere in the app.
      className={`min-w-0 transition-opacity duration-150 ${empty ? "opacity-[0.55] hover:opacity-100" : ""}`}
      style={{
        borderTop: "1px solid var(--mantine-color-default-border)",
        // A left accent bar rather than a full border/fill — at row density a
        // boxed highlight fights the divider lines, a bar just marks the row.
        borderLeft: `2px solid ${isActive ? "var(--mantine-color-green-6)" : "transparent"}`,
        background: isActive
          ? "color-mix(in srgb, var(--mantine-color-green-light) 25%, transparent)"
          : undefined,
      }}
    >
      {/* Monospace and zero-padded so the numbers form a straight column
       * down the list instead of drifting between 1 and 40. */}
      <Text size="xs" fw={700} ff="monospace" c="dimmed" className="shrink-0">
        {String(slot.index + 1).padStart(2, "0")}
      </Text>
      <Text
        size="sm"
        truncate
        c={empty ? "dimmed" : undefined}
        fs={empty ? "italic" : undefined}
        fw={isActive ? 600 : 400}
        className="min-w-0 flex-1"
        title={empty ? undefined : slot.name}
      >
        {empty ? "Empty" : slot.name}
      </Text>
      {isActive && (
        <Badge size="xs" color="green" variant="light" className="shrink-0">
          Active
        </Badge>
      )}
      <Group gap={6} wrap="nowrap" className="shrink-0">
        {/* Nothing to recall from an empty slot. The tile is omitted rather
         * than disabled, so 29 empty rows do not each carry a dead control —
         * the spacer keeps Store in one straight column regardless. */}
        {empty ? (
          <div style={{ width: 58 }} className="shrink-0" />
        ) : (
          /* Direction is the meaning here: Recall lifts the preset out of
           * the slot, Store drops the amp's current settings into it. These
           * deliberately avoid `SquareArrowRightEnter`/`Exit` — that pair is
           * already the Input/Output tab icons in this same view, so reusing
           * it made the tiles read as "Input/Output". */
          <Tooltip label={`Recall "${slot.name}"`} openDelay={400} withArrow>
            <div>
              <PresetActionTile
                label="Recall"
                icon={<ArrowUpFromLine size={14} />}
                visualValidation
                onClick={onRecall}
              />
            </div>
          </Tooltip>
        )}
        <Popover
          opened={storeOpened}
          onChange={onStoreOpenChange}
          position="bottom-end"
          withArrow
          shadow="md"
          width={240}
          trapFocus
        >
          {/* No wrapper div — see the note on the Delay tile in
           * InputChannelRow. */}
          <Popover.Target>
            <PresetActionTile
              label="Store"
              icon={<ArrowDownToLine size={14} />}
              opens="popover"
              visualValidation={storeFeedback}
              // Occupied slots tint red: storing overwrites them, and red
              // carries the same "this destroys something" meaning it does
              // on the channel strips.
              accent={empty ? undefined : "var(--mantine-color-red-6)"}
              onClick={() => {
                setDraft(empty ? "" : slot.name);
                onStoreOpenChange(!storeOpened);
              }}
            />
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" ta="center">
                Store to slot {slot.index + 1}
              </Text>
              <Text size="xs" c="dimmed">
                {empty ? (
                  "Saves the amp's current settings into this slot."
                ) : (
                  <>
                    Overwrites <b>{slot.name}</b> with the amp&apos;s current
                    settings. This cannot be undone.
                  </>
                )}
              </Text>
              <TextInput
                size="sm"
                data-autofocus
                placeholder="Preset name"
                value={draft}
                maxLength={PRESET_NAME_MAX_LEN}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitStore();
                }}
              />
              <Text size="xs" c="dimmed" ta="right">
                {draft.length}/{PRESET_NAME_MAX_LEN}
              </Text>
              <Button
                size="xs"
                color={empty ? undefined : "red"}
                loading={saving}
                disabled={draft.trim().length === 0}
                onClick={commitStore}
              >
                {empty ? "Save preset" : "Overwrite"}
              </Button>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Group>
    </Group>
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

/** Wide enough for a full 32-character preset name plus its two action
 * tiles, and no wider. The header shares the cap so the Refresh button sits
 * over the list rather than a screen away from it on a wide window. */
const PRESET_LIST_MAX_WIDTH = 620;

/** FC=59 preset browser — fetch-on-demand (mount + manual Refresh) rather
 * than the continuous-poll pattern other tabs use, since preset names
 * change rarely (see `useLivePresets`). Deliberately not a
 * `ConfigurableTabProps` consumer like the other tabs in `TAB_COMPONENTS`:
 * presets are a live wire-protocol feature with no amp-model/capability
 * dependency, so it only needs `deviceId`/`firmwareFamily` (see the
 * special-cased branch in `AmpConfigureView`'s render loop below). */
function PresetConfigurationTab({
  deviceId,
  firmwareFamily,
}: {
  deviceId?: string;
  firmwareFamily?: string | null;
}) {
  const { presets, loading, refresh, recall, store } = useLivePresets(deviceId);
  const [storeOpenFor, setStoreOpenFor] = useState<number | null>(null);
  const [slotFilter, setSlotFilter] = useState<string[]>(PRESET_FILTER_DEFAULT);

  if (!deviceId) {
    return (
      <Center h="100%">
        <Text c="dimmed" size="sm">
          No live device selected.
        </Text>
      </Center>
    );
  }

  if (firmwareFamily !== "1.1.8") {
    return (
      <Center h="100%">
        <Text c="dimmed" size="sm">
          Preset fetching requires firmware 1.1.8 (detected:{" "}
          {firmwareFamily ?? "unknown"}).
        </Text>
      </Center>
    );
  }

  const slots = presets?.slots ?? [];
  const usedCount = slots.filter((slot) => !isEmptySlot(slot.name)).length;
  const visibleSlots =
    slotFilter.length === 0
      ? slots
      : slots.filter((slot) =>
          slotFilter.includes(isEmptySlot(slot.name) ? "empty" : "used"),
        );
  const hiddenCount = slots.length - visibleSlots.length;

  return (
    <Stack
      p="md"
      gap="md"
      h="100%"
      w="100%"
      maw={PRESET_LIST_MAX_WIDTH}
      mx="auto"
      className="min-w-0"
    >
      <Group justify="space-between" wrap="wrap" gap="xs">
        <div className="min-w-0">
          <Text fw={600}>Preset Configuration</Text>
          <Text size="xs" c="dimmed">
            {slots.length === 0
              ? "No preset data yet"
              : `${usedCount} of ${slots.length} slots used${
                  presets?.activePresetName &&
                  !isEmptySlot(presets.activePresetName)
                    ? ` — "${presets.activePresetName}" active`
                    : ""
                }${hiddenCount > 0 ? ` — ${hiddenCount} hidden` : ""}`}
          </Text>
        </div>
        <Group gap="xs" wrap="nowrap">
          <MultiSelect
            size="xs"
            w={168}
            data={PRESET_FILTER_OPTIONS}
            value={slotFilter}
            onChange={setSlotFilter}
            placeholder={slotFilter.length === 0 ? "All slots" : undefined}
            aria-label="Filter slots by state"
            clearable
            hidePickedOptions={false}
            comboboxProps={{ withinPortal: true }}
          />
          <Button
            size="xs"
            variant="default"
            leftSection={<RefreshCw size={14} />}
            loading={loading}
            onClick={refresh}
          >
            Refresh
          </Button>
        </Group>
      </Group>
      {slots.length === 0 && !loading && (
        <Text c="dimmed" size="sm">
          No preset data yet — click Refresh.
        </Text>
      )}
      {slots.length > 0 && visibleSlots.length === 0 && (
        <Text c="dimmed" size="sm">
          No slots match the current filter.
        </Text>
      )}
      {/* A single column capped in width: preset names are short, so letting
       * rows run the full width of a maximised window would strand the
       * actions a screen away from the name they belong to. Rows are divided
       * by hairlines rather than each being boxed. */}
      <ScrollArea className="min-h-0 flex-1">
        <div
          className="min-w-0"
          style={{
            borderBottom:
              visibleSlots.length > 0
                ? "1px solid var(--mantine-color-default-border)"
                : undefined,
          }}
        >
          {visibleSlots.map((slot) => (
            <PresetSlotRow
              key={slot.index}
              slot={slot}
              isActive={
                !isEmptySlot(slot.name) &&
                presets?.activePresetName === slot.name
              }
              storeOpened={storeOpenFor === slot.index}
              onStoreOpenChange={(opened) =>
                setStoreOpenFor(opened ? slot.index : null)
              }
              onRecall={() => recall(slot.index)}
              onStore={(name) => store(slot.index, name)}
            />
          ))}
        </div>
      </ScrollArea>
    </Stack>
  );
}

const TAB_COMPONENTS: Record<
  string,
  (props: ConfigurableTabProps) => ReactNode
> = {
  routing: RoutingTab,
  input: InputTab,
  output: OutputTab,
};

export function AmpConfigureView({
  source,
  activeTab,
  onActiveTabChange,
}: AmpConfigureViewProps) {
  const ampModel = source?.ampModel;
  // The live amp this view reads and writes: Direct Edit's own device, or the
  // online amp a matched project amp is following (`useLinkedSync`). Both
  // render from the amp's own readings and write straight to it; a project
  // amp additionally keeps its catalog model and its fingerprint/merge UI.
  const live =
    source?.kind === "live"
      ? source
      : source?.kind === "project"
        ? source.liveThrough
        : undefined;
  // Bridge state rides its own FC=50 poll rather than the FC=27 snapshot the
  // rest of the live view model comes from — see `live/cvr/bridge.rs`.
  const liveBridge = useLiveBridge(live?.device.id);
  const liveChannelCount = live
    ? live.device.outputChannels || DEFAULT_CHANNEL_COUNT
    : DEFAULT_CHANNEL_COUNT;
  const assignment: AmpAssignment | undefined = live
    ? buildLiveAssignmentViewModel(
        live.device,
        live.channelConfig,
        liveChannelCount,
        liveBridge,
      )
    : source?.kind === "project"
      ? source.assignment
      : undefined;
  const firmwareVersion = live
    ? live.device.firmwareVersion
    : source?.kind === "project"
      ? (source.assignment.firmwareVersion ?? null)
      : null;

  const [capability, setCapability] = useState<AmpCapability | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const showFingerprintMenu = usePreference("showFingerprintMenu");
  // Fallback for callers that don't own the tab themselves.
  const [ownTab, setOwnTab] = useState<string | null>("input");
  const currentTab = activeTab ?? ownTab;
  const handleTabChange = onActiveTabChange ?? setOwnTab;

  useEffect(() => {
    if (!ampModel) {
      setCapability(null);
      return;
    }
    let cancelled = false;
    setCapabilityLoading(true);
    commands
      .ampCapabilityResolve(ampModel.id, firmwareVersion)
      .then((result) => {
        if (cancelled) return;
        setCapabilityLoading(false);
        if (result.status === "ok") {
          setCapability(result.data);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ampModel, firmwareVersion]);

  const editLock =
    source?.kind === "project" ? (source.editLock ?? null) : null;
  // Following the amp means the amp *is* the plan, so there is nothing to
  // lock: a difference while following is only the moment before the next
  // pull (see `useLinkedSync`).
  const locked = !live && (editLock?.locked ?? false);
  // Stepped out of the live session by hand. The editor behaves exactly as it
  // does for an offline amp — the lock already resolves to editable — but the
  // amp is reachable, so anything that would *write* to it has to be held
  // back explicitly (see `liveAmpDeviceId` below).
  const disengaged = editLock?.state === "disengaged";
  const projectSource = source?.kind === "project" ? source : null;
  const [disengageBusy, setDisengageBusy] = useState(false);

  async function setDisengaged(next: boolean) {
    if (!projectSource) return;
    setDisengageBusy(true);
    const result = await commands.projectsSetAmpLiveDisengaged(
      projectSource.project.id,
      projectSource.assignment.id,
      next,
    );
    setDisengageBusy(false);
    // `project:updated` is what re-resolves the edit lock, so the banner
    // swaps itself — nothing else to do here.
    if (result.status === "ok") projectSource.onProjectUpdate(result.data);
  }

  const actions: ConfigureActions | undefined = live
    ? createLiveConfigureActions(live.device.id)
    : source?.kind === "project"
      ? locked
        ? lockConfigureActions(LOCKED_MESSAGE)
        : createProjectConfigureActions(
            source.project.id,
            source.assignment.id,
            source.onProjectUpdate,
          )
      : undefined;
  const capabilities: ConfigureCapabilities = live
    ? LIVE_CONFIGURE_CAPABILITIES
    : locked
      ? LOCKED_CONFIGURE_CAPABILITIES
      : PROJECT_CONFIGURE_CAPABILITIES;

  const [mismatchOpen, setMismatchOpen] = useState(false);
  // Opens the comparison straight onto the differing rows instead of its
  // collapsed summary — see `FingerprintMismatchModal`'s `focusDifferences`.
  const [focusDifferences, setFocusDifferences] = useState(false);
  const lockAssignmentId =
    source?.kind === "project" ? source.assignment.id : null;
  const showsDifferences =
    !live &&
    (editLock?.state === "mismatch" || editLock?.state === "unreadable");
  // Auto-opens on a real difference only, never on `unreadable`: that one
  // means "can't compare yet" (a reading still missing), so opening the
  // comparison then would flash an empty modal on the way in.
  const showsMismatch = !live && editLock?.state === "mismatch";

  // Every *transition* into a mismatch opens the comparison, not just the
  // first one per amp: an amp that drops out of sync while its editor is open
  // — a follow that failed, a change that couldn't be pulled — needs it as
  // much as one that was already mismatched when opened. Dismissing it keeps
  // it closed until the lock clears and comes back.
  const wasMismatched = useRef(false);
  const lastLockAssignment = useRef(lockAssignmentId);
  // Whether a conclusive lock verdict has already been seen for this amp
  // (`checking` doesn't count — it is the state on the way in). This is what
  // separates "opened an amp that was already mismatched", where the whole
  // fingerprint is worth a look, from "this amp just fell out of sync", where
  // only what changed matters.
  const sawLockVerdict = useRef(false);
  useEffect(() => {
    // A different amp starts over, so its own mismatch still counts as a
    // transition even if the previous amp was already mismatched.
    if (lastLockAssignment.current !== lockAssignmentId) {
      lastLockAssignment.current = lockAssignmentId;
      wasMismatched.current = false;
      sawLockVerdict.current = false;
    }
    if (showsMismatch && !wasMismatched.current) {
      setFocusDifferences(sawLockVerdict.current);
      setMismatchOpen(true);
    }
    wasMismatched.current = showsMismatch;
    if (editLock && editLock.state !== "checking") sawLockVerdict.current = true;
  }, [showsMismatch, lockAssignmentId, editLock]);

  // Target for the amp-level live controls (front-panel lock, standby): the
  // live device itself, or a project amp's linked network amp while it is
  // online. Not while disengaged: these two write straight to the amp, and
  // leaving them live would contradict the banner one row above them.
  const liveAmpDeviceId =
    live?.device.id ??
    (source?.kind === "project" && source.linkedDevice?.online && !disengaged
      ? source.linkedDevice.id
      : undefined);
  const rotaryLocked = live
    ? live.channelConfig?.rotaryLocked
    : editLock?.rotaryLocked;
  // Standby shares the rotary lock's target device and reads from the same
  // FC=27 snapshot, by the same two routes (live snapshot / project amp's
  // edit lock).
  const standby = live ? live.channelConfig?.standby : editLock?.standby;
  const standbyLocked = live
    ? live.channelConfig?.standbyLocked
    : editLock?.standbyLocked;

  // Preset Configuration is a live-device-only concept (FC=59 presets live on
  // the physical amp; a Project with no live amp behind it has nothing to
  // fetch) — hidden unless this view is reading one, not rendered disabled.
  const visibleTabs = TABS.filter((t) => {
    if (t.value === "presetConfiguration" && !live) return false;
    return true;
  });
  const telemetry = live?.telemetry;
  const deviceId = live?.device.id;
  const firmwareFamily = live?.device.firmwareFamily;
  const fingerprintTarget: FingerprintTarget | undefined =
    source?.kind === "project"
      ? {
          kind: "project",
          projectId: source.project.id,
          assignmentId: source.assignment.id,
        }
      : source?.kind === "live"
        ? { kind: "live", deviceId: source.device.id }
        : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {live && source?.kind === "project" && (
        <Alert radius={0} py={6} color="green" variant="light" icon={<Radio size={16} />}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm">
              Live — linked to {live.device.name || live.device.mac}. Edits go straight to the amp; this project
              follows.
            </Text>
            {/* A matched amp has nothing to jump to, so this opens the
                summary the way the modal normally starts. */}
            <Group gap="xs" wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                color="green"
                leftSection={<GitCompare size={14} />}
                onClick={() => {
                  setFocusDifferences(false);
                  setMismatchOpen(true);
                }}
              >
                Compare
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<Unplug size={14} />}
                loading={disengageBusy}
                onClick={() => void setDisengaged(true)}
              >
                Disengage
              </Button>
            </Group>
          </Group>
        </Alert>
      )}

      {/* Stepped out of the live session on purpose. Amber, not gray: this is
          a deliberate choice the user made and can undo, not a fault and not
          the amp having gone away — that one keeps its own Offline banner
          even while this flag is set. */}
      {disengaged && (
        <Alert radius={0} py={6} color="amber" variant="light" icon={<Unplug size={16} />}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm">
              Disengaged — edits stay in this project. The amp is untouched.
            </Text>
            <Group gap="xs" wrap="nowrap">
              {/* The fingerprints are still compared while disengaged, so the
                  drift is visible here — which is what informs re-engaging. */}
              <Button
                size="compact-xs"
                variant="light"
                color="amber"
                leftSection={<GitCompare size={14} />}
                onClick={() => {
                  setFocusDifferences(false);
                  setMismatchOpen(true);
                }}
              >
                Compare
              </Button>
              <Button
                size="compact-xs"
                variant="filled"
                color="amber"
                leftSection={<Plug size={14} />}
                loading={disengageBusy}
                onClick={() => void setDisengaged(false)}
              >
                Re-engage
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
      {/* The counterpart to the Live banner: this amp is linked to hardware
          that isn't reachable, so edits land in the plan alone. */}
      {editLock?.state === "offline" && (
        <Alert radius={0} py={6} color="gray" variant="light" icon={<WifiOff size={16} />}>
          <Text size="sm">
            Offline — the linked amp isn't reachable. Changes stay in this project until it's back.
          </Text>
        </Alert>
      )}
      {!live && editLock?.state === "checking" && (
        <Alert
          radius={0}
          py={6}
          color="gray"
          variant="light"
          icon={<Loader size={14} />}
        >
          <Text size="sm">Checking the linked amp — editing is paused until its settings are read.</Text>
        </Alert>
      )}
      {showsDifferences && (
        <Alert radius={0} py={6} color="red" variant="light" icon={<Lock size={16} />}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm">
              {editLock?.state === "unreadable"
                ? "Locked — the online amp's settings can't be fully compared."
                : "Locked — the offline amp differs from the online amp."}
            </Text>
            <Group gap="xs" wrap="nowrap">
              {/* Its label is a promise: open on the differing rows. */}
              <Button
                size="compact-xs"
                variant="light"
                color="red"
                leftSection={<Eye size={14} />}
                onClick={() => {
                  setFocusDifferences(true);
                  setMismatchOpen(true);
                }}
              >
                Show differences
              </Button>
              {/* The way out of a lock without resolving the merge: keep
                  planning offline and settle the difference later. */}
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<Unplug size={14} />}
                loading={disengageBusy}
                onClick={() => void setDisengaged(true)}
              >
                Disengage
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
      <FingerprintMismatchModal
        opened={mismatchOpen}
        onClose={() => setMismatchOpen(false)}
        lock={editLock}
        focusDifferences={focusDifferences}
        projectId={source?.kind === "project" ? source.project.id : undefined}
        assignmentId={source?.kind === "project" ? source.assignment.id : undefined}
        onProjectUpdate={source?.kind === "project" ? source.onProjectUpdate : undefined}
        following={Boolean(live)}
      />
    <Tabs
      value={currentTab}
      onChange={handleTabChange}
      orientation="vertical"
      className="min-h-0 flex-1"
    >
      {/* `min-w-0` on the panel is what lets the tab body shrink below its
          content's intrinsic width instead of pushing the whole window into
          a horizontal scroll; the rail itself scrolls once five tabs no
          longer fit a short window. */}
      <Tabs.List className="shrink-0 justify-center overflow-y-auto">
        {visibleTabs.map(({ value, label, icon: Icon }) => (
          <Tooltip
            key={value}
            label={label}
            position="right"
            withArrow
            openDelay={300}
          >
            <Tabs.Tab value={value} aria-label={label}>
              <Icon size={18} />
            </Tabs.Tab>
          </Tooltip>
        ))}
        {showFingerprintMenu && <FingerprintInspector target={fingerprintTarget} />}
        {/* Hidden entirely while disengaged rather than rendered inert: they
            are the only controls left that would reach the amp. */}
        {!disengaged && (live || (source?.kind === "project" && source.linkedDevice)) && (
          <>
            <RotaryLockToggle deviceId={liveAmpDeviceId} rotaryLocked={rotaryLocked} />
            <StandbyToggle
              deviceId={liveAmpDeviceId}
              standby={standby}
              standbyLocked={standbyLocked}
            />
          </>
        )}
      </Tabs.List>

      {visibleTabs.map(({ value, label, skeleton }) => {
        let content: ReactNode;

        if (value === "presetConfiguration") {
          content = (
            <PresetConfigurationTab
              deviceId={deviceId}
              firmwareFamily={firmwareFamily}
            />
          );
        } else if (!CONFIGURABLE_TABS.has(value) || !assignment || !actions) {
          content = <TabSkeleton label={label} variant={skeleton} />;
        } else if (!ampModel) {
          content = (
            <Center h="100%">
              <Text c="dimmed" size="sm">
                Assign an amp model to configure this device.
              </Text>
            </Center>
          );
        } else if (capabilityLoading || !capability) {
          content = (
            <Center h="100%">
              <Loader size="sm" />
            </Center>
          );
        } else {
          const TabComponent = TAB_COMPONENTS[value];
          content = (
            <TabComponent
              assignment={assignment}
              capability={capability}
              telemetry={telemetry}
              actions={actions}
              capabilities={capabilities}
              deviceId={liveAmpDeviceId}
            />
          );
        }

        return (
          <Tabs.Panel
            key={value}
            value={value}
            className="min-h-0 min-w-0 flex-1"
          >
            {/* Native disabled fieldset: every input and button inside goes
                inert while locked; `lockConfigureActions` backs it up. */}
            <fieldset
              disabled={locked}
              className="h-full min-h-0 min-w-0"
              style={{ border: 0, margin: 0, padding: 0 }}
            >
              {content}
            </fieldset>
          </Tabs.Panel>
        );
      })}
    </Tabs>
    </div>
  );
}
