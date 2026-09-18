import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Card, Chip, Modal, Spinner } from "@heroui/react";
import { Check, Link, Network, Server, X } from "lucide-react";
import {
  commands,
  type AmpAssignment,
  type AmpLinkCheckKind,
  type AmpLinkValidation,
  type AmpModelCatalogEntry,
  type DiscoveredDevice,
  type Project,
} from "../lib/bindings";
import { AMP_LINK_STATUS_META, ampLinkStatus, linkedDeviceFor } from "../lib/ampLinkStatus";
import { useIsCompact, useIsTight } from "../lib/breakpoints";

interface AmpLinkModalProps {
  project: Project;
  assignment: AmpAssignment | null;
  displayName: string;
  modelName: string | null;
  devices: DiscoveredDevice[];
  devicesReady: boolean;
  onProjectUpdate: (project: Project) => void;
  onClose: () => void;
}

const CHECK_LABELS: Record<AmpLinkCheckKind, string> = {
  deviceOnline: "Online",
  modelDetected: "Model detected",
  modelMatches: "Model",
  firmwareMatches: "Firmware",
  notLinkedElsewhere: "Not in use",
};

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--amp-font-size-xs)",
        fontWeight: 600,
        color: "var(--amp-color-dimmed)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </span>
  );
}

/** Same dot as the Workspace amp cards, plus a text label. */
function StatusDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-1.5">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `var(--amp-color-${color}-filled)` }}
      />
      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>{label}</span>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>{label}</div>
      <div className="truncate" style={{ fontSize: "var(--amp-font-size-sm)", fontFamily: mono ? "monospace" : undefined }}>
        {value}
      </div>
    </div>
  );
}

/** Catalog model per discovered device id, resolved exactly like Live Control's
 * model select (`deviceModelLinkAutoMatch`: a manual pick wins, otherwise the
 * firmware-string match). Only resolves while `enabled`, and only for device
 * ids it hasn't resolved yet. */
function useDetectedModels(devices: DiscoveredDevice[], enabled: boolean) {
  const [models, setModels] = useState<Record<string, AmpModelCatalogEntry | null>>({});
  const pendingKey = devices
    .filter((d) => !(d.id in models))
    .map((d) => d.id)
    .join(",");

  useEffect(() => {
    if (!enabled || !pendingKey) return;
    for (const device of devices.filter((d) => !(d.id in models))) {
      commands
        .deviceModelLinkAutoMatch(device.mac, device.firmwareVersion, device.digitalInputChannels, device.outputChannels)
        .then((result) => {
          setModels((prev) => ({ ...prev, [device.id]: result.status === "ok" ? result.data : null }));
        });
    }
    // `pendingKey` stands in for `devices`, whose identity changes on every discovery tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pendingKey]);

  return models;
}

type StripState = "idle" | "validating" | "compatible" | "incompatible";

/** `[project amp] ——— node ——— [network amp]`. On a compatible result the
 * connector fills green left→right and a check pops in; `animationKey`
 * replays that whenever a different device is validated. */
function ThemeIcon({
  color,
  size,
  className,
  children,
}: {
  color: string;
  size: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        background: `var(--amp-color-${color}-light)`,
        color: `var(--amp-color-${color}-6)`,
      }}
    >
      {children}
    </div>
  );
}

function LinkMatchStrip({ state, animationKey }: { state: StripState; animationKey: string }) {
  const compatible = state === "compatible";
  const iconColor = compatible ? "green" : "gray";

  return (
    <div className="flex min-w-0 items-center gap-3">
      <ThemeIcon color={iconColor} size={36} className="transition-colors">
        <Server size={18} />
      </ThemeIcon>

      <div className="relative h-7 min-w-0 flex-1">
        <div
          className={`absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden ${
            state === "idle" ? "" : "h-0.5 rounded-full bg-[var(--amp-color-default-border)]"
          }`}
          // Full shorthand, not `border-t-2 border-dashed`: without Tailwind's preflight the
          // other sides would fall back to a `medium` width and draw a second dashed line.
          style={state === "idle" ? { borderTop: "2px dashed var(--amp-color-default-border)" } : undefined}
        >
          {state === "validating" && (
            <div
              className="absolute inset-y-0 left-0 w-1/4 animate-[link-shimmer_1.1s_linear_infinite] motion-reduce:animate-none"
              style={{ background: "linear-gradient(90deg, transparent, var(--amp-color-gray-5), transparent)" }}
            />
          )}
          {compatible && (
            <div
              key={animationKey}
              className="absolute inset-0 origin-left animate-[link-fill_500ms_ease-out_both] bg-[var(--amp-color-green-filled)] motion-reduce:animate-none"
            />
          )}
          {state === "incompatible" && <div className="absolute inset-0 bg-[var(--amp-color-red-filled)]" />}
        </div>

        {(compatible || state === "incompatible") && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div
              key={animationKey}
              className={`flex size-7 items-center justify-center rounded-full motion-reduce:animate-none ${
                compatible
                  ? "animate-[link-pop_320ms_ease-out_450ms_both] bg-[var(--amp-color-green-filled)]"
                  : "animate-[link-pop_240ms_ease-out_both] bg-[var(--amp-color-red-filled)]"
              }`}
            >
              {compatible ? <Check size={16} strokeWidth={3} color="white" /> : <X size={16} strokeWidth={3} color="white" />}
            </div>
          </div>
        )}
      </div>

      <ThemeIcon color={iconColor} size={36} className="transition-colors">
        <Network size={18} />
      </ThemeIcon>
    </div>
  );
}

/** Project amp (left) vs. amps found on the network (right). Selecting a network
 * amp runs the Rust compatibility checks (`projects_validate_amp_link`); Assign
 * writes its MAC to the project amp, Unlink clears it. Only the link itself is
 * written here — matching offline and online config happens in the editor. */
export function AmpLinkModal({
  project,
  assignment,
  displayName,
  modelName,
  devices,
  devicesReady,
  onProjectUpdate,
  onClose,
}: AmpLinkModalProps) {
  const compact = useIsCompact();
  const tight = useIsTight();

  const status = AMP_LINK_STATUS_META[assignment ? ampLinkStatus(assignment, devices) : "unlinked"];
  const linkedDevice = assignment ? linkedDeviceFor(assignment, devices) : undefined;
  const detectedModels = useDetectedModels(devices, assignment !== null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ deviceId: string; result: AmpLinkValidation } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedDevice = devices.find((d) => d.id === selectedId);

  // Fresh state per opened amp; preselect its linked device when there is one.
  useEffect(() => {
    setSelectedId(linkedDevice?.id ?? null);
    setValidation(null);
    setValidationError(null);
    setActionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment?.id]);

  // Everything the checks read: selection, its online state, and every
  // project amp's model/firmware/MAC ("not linked elsewhere").
  const validationKey = [
    selectedId,
    selectedDevice?.online,
    detectedModels[selectedId ?? ""]?.id,
    ...project.ampAssignments.map((a) => `${a.id}:${a.ampModelId}:${a.firmwareVersion}:${a.mac}`),
  ].join("|");

  useEffect(() => {
    if (!assignment || !selectedId) return;
    let cancelled = false;
    const deviceId = selectedId;
    commands.projectsValidateAmpLink(project.id, assignment.id, deviceId).then((result) => {
      if (cancelled) return;
      if (result.status === "ok") {
        setValidation({ deviceId, result: result.data });
        setValidationError(null);
      } else {
        setValidation(null);
        setValidationError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
    // `validationKey` stands in for the project/device objects, whose identity changes constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, assignment?.id, validationKey]);

  function selectDevice(id: string) {
    setSelectedId(id);
    setValidationError(null);
    setActionError(null);
  }

  // A re-validation of the same device keeps showing its last result instead of
  // flashing back to "checking", so the animation only plays on a new selection.
  const result = validation && validation.deviceId === selectedId ? validation.result : null;
  const stripState: StripState = !selectedId
    ? "idle"
    : validationError
      ? "incompatible"
      : !result
        ? "validating"
        : result.compatible
          ? "compatible"
          : "incompatible";
  const alreadyLinked = !!selectedId && selectedId === linkedDevice?.id;
  const failedCount = result?.checks.filter((c) => !c.passed).length ?? 0;

  const caption =
    stripState === "idle"
      ? "Select a network amp to check compatibility"
      : stripState === "validating"
        ? "Checking compatibility…"
        : stripState === "compatible"
          ? alreadyLinked
            ? "Linked to this amp"
            : "Compatible"
          : validationError
            ? "Could not check compatibility"
            : `Not compatible — ${failedCount} ${failedCount === 1 ? "check" : "checks"} failed`;
  const captionColor = stripState === "compatible" ? "green" : stripState === "incompatible" ? "red" : "dimmed";

  async function handleAssign() {
    if (!assignment || !selectedId) return;
    setBusy("link");
    setActionError(null);
    const response = await commands.projectsLinkAmp(project.id, assignment.id, selectedId);
    setBusy(null);
    if (response.status === "ok") onProjectUpdate(response.data);
    else setActionError(response.error.message);
  }

  async function handleUnlink() {
    if (!assignment) return;
    setBusy("unlink");
    setActionError(null);
    const response = await commands.projectsUnlinkAmp(project.id, assignment.id);
    setBusy(null);
    if (response.status === "ok") onProjectUpdate(response.data);
    else setActionError(response.error.message);
  }

  return (
    <Modal.Backdrop isOpen={assignment !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Link Amp</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className={`flex min-w-0 ${tight ? "flex-col gap-4" : "flex-row items-stretch gap-5"}`}>
              {/* Project amp */}
              <div className="flex min-w-0 flex-1 basis-0 flex-col gap-2">
                <SectionLabel>Project Amp</SectionLabel>
                <Card className="p-[var(--amp-spacing-md)]">
                  <div className="flex flex-nowrap items-center gap-2">
                    <ThemeIcon color="gray" size={40}>
                      <Server size={20} />
                    </ThemeIcon>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" style={{ fontWeight: 600 }}>
                        {displayName}
                      </div>
                      <div className="truncate" style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                        {modelName ?? "No model"}
                      </div>
                    </div>
                    <StatusDot color={status.color} label={status.label} />
                  </div>
                  <hr className="my-3 border-t border-[var(--amp-color-default-border)]" />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Firmware" value={assignment?.firmwareVersion ?? "—"} />
                    <Field label="Outputs" value={assignment?.channels.length ?? "—"} />
                    <Field label="MAC" value={assignment?.mac ?? "Not linked"} mono={!!assignment?.mac} />
                    <Field label="IP" value={linkedDevice?.ip ?? "—"} mono={!!linkedDevice} />
                  </div>
                </Card>
              </div>

              <hr
                className={
                  tight
                    ? "m-0 w-full border-t border-[var(--amp-color-default-border)]"
                    : "m-0 h-auto self-stretch border-l border-t-0 border-[var(--amp-color-default-border)]"
                }
              />

              {/* Network amps */}
              <div className="flex min-w-0 flex-1 basis-0 flex-col gap-2">
                <div className="flex flex-nowrap items-center justify-between gap-2">
                  <SectionLabel>Network Amps</SectionLabel>
                  {devices.length > 0 && <Chip size="sm">{devices.length}</Chip>}
                </div>
                {devices.length === 0 ? (
                  <div
                    className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--amp-color-default-border)]"
                    style={{ minHeight: 140 }}
                  >
                    <Spinner size="sm" />
                    <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)", textAlign: "center" }}>
                      {devicesReady ? "Scanning the network…" : "Starting discovery…"}
                    </span>
                  </div>
                ) : (
                  <div className="overflow-y-auto" style={{ maxHeight: compact ? undefined : 360 }}>
                    <div className="flex flex-col gap-2">
                      {devices.map((d) => {
                        const isLinked = d.id === linkedDevice?.id;
                        const isSelected = d.id === selectedId;
                        const detected = detectedModels[d.id];
                        const modelLabel =
                          detected === undefined ? "Detecting…" : detected ? `${detected.brand} ${detected.model}` : "Unknown model";
                        return (
                          <button
                            type="button"
                            key={d.id}
                            onClick={() => selectDevice(d.id)}
                            aria-pressed={isSelected}
                            className="block w-full appearance-none bg-transparent p-0 text-left font-inherit"
                          >
                            <Card
                              className={`p-[var(--amp-spacing-sm)] transition-colors ${
                                isSelected
                                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                                  : "hover:border-[var(--amp-color-gray-6)]"
                              }`}
                            >
                              <div className="flex flex-nowrap items-center justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-nowrap items-center gap-1.5">
                                    <span className="truncate" style={{ fontWeight: 500, fontSize: "var(--amp-font-size-sm)" }}>
                                      {d.name || d.mac}
                                    </span>
                                    {isLinked && (
                                      <Chip size="sm" color="success" className="shrink-0">
                                        Linked
                                      </Chip>
                                    )}
                                  </div>
                                  <div className="truncate" style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                                    {modelLabel} · {d.ip} · {d.firmwareFamily ?? "unknown"}
                                  </div>
                                </div>
                                <StatusDot color={d.online ? "green" : "red"} label={d.online ? "Online" : "Offline"} />
                              </div>
                            </Card>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Match row */}
            <hr className="my-3 border-t border-[var(--amp-color-default-border)]" />
            <div className="flex min-w-0 flex-col gap-2">
              <LinkMatchStrip state={stripState} animationKey={`${selectedId}:${stripState}`} />
              <span
                style={{
                  fontSize: "var(--amp-font-size-sm)",
                  fontWeight: 500,
                  textAlign: "center",
                  color: captionColor === "dimmed" ? "var(--amp-color-dimmed)" : `var(--amp-color-${captionColor}-6)`,
                }}
              >
                {caption}
              </span>

              {result && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  {result.checks.map((check) => (
                    <div key={check.kind} className="flex min-w-0 flex-nowrap items-start gap-2">
                      <ThemeIcon color={check.passed ? "green" : "red"} size={16} className="mt-px">
                        {check.passed ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
                      </ThemeIcon>
                      <span className="shrink-0" style={{ fontSize: "var(--amp-font-size-xs)", fontWeight: 500, width: 104 }}>
                        {CHECK_LABELS[check.kind]}
                      </span>
                      <span className="min-w-0" style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                        {check.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {(validationError || actionError) && <Alert status="danger">{actionError ?? validationError}</Alert>}

              <div className="flex flex-wrap items-center justify-end gap-2">
                {assignment?.mac && (
                  <Button variant="secondary" isDisabled={busy === "link" || busy === "unlink"} onPress={handleUnlink}>
                    {busy === "unlink" ? <Spinner size="sm" /> : "Unlink"}
                  </Button>
                )}
                <Button
                  variant="primary"
                  isDisabled={stripState !== "compatible" || alreadyLinked || busy === "unlink" || busy === "link"}
                  onPress={handleAssign}
                >
                  {busy === "link" ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      {alreadyLinked ? <Check size={14} /> : <Link size={14} />} {alreadyLinked ? "Linked" : "Assign"}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
