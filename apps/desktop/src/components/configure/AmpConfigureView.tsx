import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button, Alert, Spinner, Tabs, Tooltip } from "@heroui/react";
import { Eye, GitCompare, Plug, Unplug, Lock, Radio, WifiOff } from "lucide-react";
import { AmplifierIcon, CabinetIcon, CrosspointMatrixIcon, GangedFadersIcon, MemorySlotsIcon, RackPanelIcon } from "../HardwareIcons";
import { FingerprintInspector, type FingerprintTarget } from "../FingerprintInspector";
import { FingerprintMismatchModal } from "../FingerprintMismatchModal";
import { LinkingTab } from "../LinkingTab";
import { RotaryLockToggle } from "../RotaryLockToggle";
import { StandbyToggle } from "../StandbyToggle";
import { useLiveBridge } from "../../hooks/useLiveBridge";
import { commands, type AmpAssignment, type AmpCapability_Serialize as AmpCapability, type AmpEditLock, type AmpModelCatalogEntry, type ChannelConfigSnapshot, type DiscoveredDevice, type Project, type Telemetry } from "../../lib/bindings";
import { linkConfigureActions, NO_LINKS } from "../../lib/channelLinks";
import { createProjectConfigureActions, lockConfigureActions, type ConfigureActions } from "../../lib/configureActions";
import { buildLiveAssignmentViewModel, createLiveConfigureActions } from "../../lib/liveConfigureAdapter";
import { OverviewTab } from "../OverviewTab";
import { SpeakersTab } from "../SpeakersTab";
import { useSpeakerLibrary, useSpeakerStates } from "../../lib/speakers";
import { usePreference } from "../../lib/preferences";
import { ampGainReading } from "../../lib/ampGain";
import { MainTab } from "./MainTab";
import { PresetConfigurationTab } from "./PresetTab";
import { RoutingTab } from "./RoutingTab";
import { type ConfigurableTabProps, RenameableLabel, type SkeletonVariant, TabSkeleton } from "./parts";

/** Which project (persisted) or live device (Direct Edit, no project) this
 * Configure screen instance targets — the single seam that lets the same
 * capability-driven tab UI serve both modes (see `configureActions.ts`/
 * `liveConfigureAdapter.ts`). */
type ConfigureSource =
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

const DEFAULT_CHANNEL_COUNT = 4;

/** FC=60 CUSTOMER_NAME_MODIFY's wire field width (`DEVICE_NAME_FIELD_LEN` in
 * `write_v118.rs`) — fixed by the protocol, not model/firmware-dependent, so
 * unlike channel name length it isn't part of `AmpCapability`. */
const DEVICE_NAME_MAX_LENGTH = 32;

const LOCKED_MESSAGE = "Locked — the offline amp differs from the online amp.";

const TABS = [
  { value: "overview", label: "Overview", icon: RackPanelIcon, skeleton: "grid" },
  { value: "main", label: "Input / Output", icon: AmplifierIcon, skeleton: "list" },
  { value: "routing", label: "Matrix", icon: CrosspointMatrixIcon, skeleton: "grid" },
  { value: "speakers", label: "Speakers", icon: CabinetIcon, skeleton: "list" },
  {
    value: "presetConfiguration",
    label: "Preset Configuration",
    icon: MemorySlotsIcon,
    skeleton: "list",
  },
  { value: "linking", label: "Channel Linking", icon: GangedFadersIcon, skeleton: "list" },
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
const CONFIGURABLE_TABS = new Set(["overview", "main", "routing"]);

/** A rail tab's icon with its HeroUI tooltip. `Hint` can't wrap a `Tabs.Tab`
 * (RAC collection), and its trigger can't sit inside the tab's own button, so
 * this opens a standalone `Tooltip.Content` from the icon's hover instead. */
function RailTabIcon({ label, Icon }: { label: string; Icon: ComponentType<{ size?: number }> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span
        ref={ref}
        className="flex items-center justify-center"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <Icon size={24} />
      </span>
      {/* `isOpen` belongs on the root: positioning reads the root's state, so
          on `Tooltip.Content` it shows the tooltip unpositioned, top-left. */}
      <Tooltip isOpen={open}>
        <Tooltip.Content triggerRef={ref} placement="right" showArrow>
          {label}
        </Tooltip.Content>
      </Tooltip>
    </>
  );
}

const TAB_COMPONENTS: Record<
  string,
  (props: ConfigurableTabProps) => ReactNode
> = {
  overview: OverviewTab,
  main: MainTab,
  routing: RoutingTab,
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
  // Load is local, so it never comes from the reading once it has been set: a
  // project amp shows its project's, any other live amp this machine's.
  const liveLoadOhms = usePreference("liveLoadOhms");
  const assignment: AmpAssignment | undefined = live
    ? buildLiveAssignmentViewModel(
        live.device,
        live.channelConfig,
        liveChannelCount,
        liveBridge,
        (channelIndex) =>
          source?.kind === "project"
            ? source.assignment.channels.find((c) => c.channelIndex === channelIndex)?.ohms ?? undefined
            : liveLoadOhms[live.device.mac]?.[channelIndex],
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
  const [ownTab, setOwnTab] = useState<string | null>("overview");
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

  const baseActions: ConfigureActions | undefined = live
    ? {
        ...createLiveConfigureActions(live.device.id, live.device.mac),
        // A followed project amp writes the amp, but its Load is the project's.
        ...(source?.kind === "project" && {
          setChannelOhms: createProjectConfigureActions(
            source.project.id,
            source.assignment.id,
            source.onProjectUpdate,
          ).setChannelOhms,
        }),
      }
    : source?.kind === "project"
      ? locked
        ? lockConfigureActions(LOCKED_MESSAGE)
        : createProjectConfigureActions(
            source.project.id,
            source.assignment.id,
            source.onProjectUpdate,
          )
      : undefined;
  // Links follow the amp where there is one: the MAC outlasts a project, and
  // the assignment's stays known while the amp is offline.
  const linkKey = (
    live?.device.mac ??
    (source?.kind === "project" ? (source.assignment.mac ?? source.assignment.id) : undefined)
  )?.toLowerCase();
  const channelLinks = usePreference("channelLinks");
  const linkConfig = (linkKey && channelLinks[linkKey]) || NO_LINKS;
  const actions =
    baseActions && linkConfigureActions(baseActions, linkConfig, assignment?.channels.length ?? 0);

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
    // The speaker library sets up *project* outputs — a Direct Edit amp has
    // no project to hold the references (live-only writes come later).
    if (t.value === "speakers" && !projectSource) return false;
    return true;
  });
  const speakerLibrary = useSpeakerLibrary();
  const speakerStates = useSpeakerStates(projectSource?.project, projectSource?.assignment.id, speakerLibrary);
  const telemetry = live?.telemetry;
  const ampGains = live
    ? Array.from({ length: liveChannelCount }, (_, i) => ampGainReading(live.channelConfig, i))
    : undefined;
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
      {assignment && (
        <div className="px-3 pt-2">
          <RenameableLabel
            defaultLabel={ampModel ? `${ampModel.brand} ${ampModel.model}` : "Unnamed Amp"}
            name={assignment.deviceName}
            maxLength={DEVICE_NAME_MAX_LENGTH}
            onRename={(name) => void actions?.setDeviceName?.(name)}
          />
        </div>
      )}
      {live && source?.kind === "project" && (
        <Alert status="success" className="items-center rounded-none py-1.5">
          <Alert.Indicator>
            <Radio size={16} />
          </Alert.Indicator>
          <Alert.Content>
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                Live — linked to {live.device.name || live.device.mac}. Edits go straight to the amp; this project
                follows.
              </span>
              {/* A matched amp has nothing to jump to, so this opens the
                  summary the way the modal normally starts. */}
              <div className="flex flex-nowrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setFocusDifferences(false);
                    setMismatchOpen(true);
                  }}
                >
                  <GitCompare size={14} /> Compare
                </Button>
                <Button size="sm" variant="ghost" isDisabled={disengageBusy} onPress={() => void setDisengaged(true)}>
                  {disengageBusy ? <Spinner size="sm" /> : <Unplug size={14} />} Disengage
                </Button>
              </div>
            </div>
          </Alert.Content>
        </Alert>
      )}

      {/* Stepped out of the live session on purpose. Amber, not gray: this is
          a deliberate choice the user made and can undo, not a fault and not
          the amp having gone away — that one keeps its own Offline banner
          even while this flag is set. */}
      {disengaged && (
        <Alert status="warning" className="items-center rounded-none py-1.5">
          <Alert.Indicator>
            <Unplug size={16} />
          </Alert.Indicator>
          <Alert.Content>
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                Disengaged — edits stay in this project. The amp is untouched.
              </span>
              <div className="flex flex-nowrap items-center gap-2">
                {/* The fingerprints are still compared while disengaged, so the
                    drift is visible here — which is what informs re-engaging. */}
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setFocusDifferences(false);
                    setMismatchOpen(true);
                  }}
                >
                  <GitCompare size={14} /> Compare
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={disengageBusy}
                  onPress={() => void setDisengaged(false)}
                >
                  {disengageBusy ? <Spinner size="sm" /> : <Plug size={14} />} Re-engage
                </Button>
              </div>
            </div>
          </Alert.Content>
        </Alert>
      )}
      {/* The counterpart to the Live banner: this amp is linked to hardware
          that isn't reachable, so edits land in the plan alone. */}
      {editLock?.state === "offline" && (
        <Alert status="default" className="items-center rounded-none py-1.5">
          <Alert.Indicator>
            <WifiOff size={16} />
          </Alert.Indicator>
          <Alert.Content>
            <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
              Offline — the linked amp isn't reachable. Changes stay in this project until it's back.
            </span>
          </Alert.Content>
        </Alert>
      )}
      {!live && editLock?.state === "checking" && (
        <Alert status="default" className="items-center rounded-none py-1.5">
          <Alert.Indicator>
            <Spinner size="sm" />
          </Alert.Indicator>
          <Alert.Content>
            <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
              Checking the linked amp — editing is paused until its settings are read.
            </span>
          </Alert.Content>
        </Alert>
      )}
      {showsDifferences && (
        <Alert status="danger" className="items-center rounded-none py-1.5">
          <Alert.Indicator>
            <Lock size={16} />
          </Alert.Indicator>
          <Alert.Content>
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                {editLock?.state === "unreadable"
                  ? "Locked — the online amp's settings can't be fully compared."
                  : "Locked — the offline amp differs from the online amp."}
              </span>
              <div className="flex flex-nowrap items-center gap-2">
                {/* Its label is a promise: open on the differing rows. */}
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setFocusDifferences(true);
                    setMismatchOpen(true);
                  }}
                >
                  <Eye size={14} /> Show differences
                </Button>
                {/* The way out of a lock without resolving the merge: keep
                    planning offline and settle the difference later. */}
                <Button size="sm" variant="ghost" isDisabled={disengageBusy} onPress={() => void setDisengaged(true)}>
                  {disengageBusy ? <Spinner size="sm" /> : <Unplug size={14} />} Disengage
                </Button>
              </div>
            </div>
          </Alert.Content>
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
      selectedKey={currentTab ?? undefined}
      onSelectionChange={(key) => handleTabChange(String(key))}
      orientation="vertical"
      className="min-h-0 flex-1"
    >
      {/* `min-w-0` on the panel is what lets the tab body shrink below its
          content's intrinsic width instead of pushing the whole window into
          a horizontal scroll; the rail itself scrolls once five tabs no
          longer fit a short window.
          The extra rail controls (fingerprint/rotary-lock/standby) are real
          `size="lg"` icon-only HeroUI Buttons (44px), rendered below
          `Tabs.List` rather than inside it — a RAC collection component that
          only accepts Tab children. The whole column is pinned to one width
          so every icon (tab or button) lines up on one centerline,
          rather than each box shrink-wrapping to its own content and
          getting centered independently — that's what "centering" silently
          stopped meaning once the tabs' own width shrank to their icon.
          `justify-center` keeps the column centered in the rail's height
          regardless of how much header content sits above it; a short window
          that can't fit the whole column still scrolls instead of clipping,
          since a flex `center` that overflows falls back to `start`. */}
      <div className="flex w-14 shrink-0 flex-col items-center justify-center gap-1 overflow-y-auto">
        <Tabs.List className="w-full">
          {/* Labels are on `RailTabIcon`: `Tabs.List` is a RAC collection, so a
              `Tooltip.Trigger` wrapper here would leave it empty.
              `w-full` matches `.tabs__tab`'s own default, so the tab already
              fills the rail; `min-w-0!` forcibly drops its `min-w-20` floor
              (sized for a labelled tab, not an icon-only one) — `min-width`
              otherwise wins over `width` whenever the two disagree, and a
              plain (non-`!`) utility isn't reliably guaranteed to beat that
              default's own `@layer components` rule. */}
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <Tabs.Tab key={value} id={value} aria-label={label} className="h-12! w-full min-w-0! px-0!">
              <RailTabIcon label={label} Icon={Icon} />
            </Tabs.Tab>
          ))}
        </Tabs.List>
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
      </div>

      {visibleTabs.map(({ value, label, skeleton }) => {
        let content: ReactNode;

        if (value === "presetConfiguration") {
          content = (
            <PresetConfigurationTab
              deviceId={deviceId}
              firmwareFamily={firmwareFamily}
            />
          );
        } else if (value === "linking" && assignment && linkKey) {
          content = <LinkingTab linkKey={linkKey} channelCount={assignment.channels.length} />;
        } else if (value === "speakers" && projectSource) {
          // Refs and statuses come from the project amp even while following
          // the linked amp (the view's `assignment` is then built from the
          // amp and carries none); `speakersApply` pushes values through sync.
          content = (
            <SpeakersTab
              project={projectSource.project}
              assignment={projectSource.assignment}
              library={speakerLibrary}
              states={speakerStates}
              locked={locked}
              actions={actions}
              onProjectUpdate={projectSource.onProjectUpdate}
            />
          );
        } else if (!CONFIGURABLE_TABS.has(value) || !assignment || !actions) {
          content = <TabSkeleton label={label} variant={skeleton} />;
        } else if (!ampModel) {
          content = (
            <div className="flex h-full items-center justify-center">
              <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
                Assign an amp model to configure this device.
              </span>
            </div>
          );
        } else if (capabilityLoading || !capability) {
          content = (
            <div className="flex h-full items-center justify-center">
              <Spinner size="sm" />
            </div>
          );
        } else {
          const TabComponent = TAB_COMPONENTS[value];
          content = (
            <TabComponent
              assignment={assignment}
              capability={capability}
              telemetry={telemetry}
              ampGains={ampGains}
              actions={actions}
              linkConfig={linkConfig}
              deviceId={liveAmpDeviceId}
              speakerStates={speakerStates}
              onOpenSpeakers={() => handleTabChange("speakers")}
              locked={locked}
              device={live?.device}
              modelLabel={ampModel ? `${ampModel.brand} ${ampModel.model}` : undefined}
              presetName={live?.channelConfig?.presetName}
            />
          );
        }

        return (
          <Tabs.Panel
            key={value}
            id={value}
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
