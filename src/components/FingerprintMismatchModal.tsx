import { Fragment, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, Modal, Switch } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import type { AmpEditLock, AmpEditLockState, AmpMergeResult, FingerprintRow, Project } from "../lib/bindings";
import { useIsCompact } from "../lib/breakpoints";
import { AmpMergePanel, type MergeDirection } from "./AmpMergePanel";
import { AmpPushSteps } from "./AmpPushSteps";

const STATE_BADGE: Record<AmpEditLockState, { color: "default" | "success" | "danger" | "warning"; label: string }> = {
  unlinked: { color: "default", label: "Unlinked" },
  offline: { color: "default", label: "Offline" },
  checking: { color: "default", label: "Checking" },
  matches: { color: "success", label: "Matches" },
  mismatch: { color: "danger", label: "Mismatch" },
  unreadable: { color: "danger", label: "Unreadable" },
  disengaged: { color: "warning", label: "Disengaged" },
};

/** Minimal copy-to-clipboard button, replacing Mantine's `CopyButton` render
 * prop — see `FingerprintInspector.tsx`'s identical helper. */
function CopyJsonButton({ value, disabled }: { value: string; disabled: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant={copied ? "primary" : "secondary"}
      isDisabled={disabled}
      onPress={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy all as JSON"}
    </Button>
  );
}

// `transition-colors`: after a match, the red tints fade out instead of
// vanishing.
const CELL = "min-w-0 px-2 py-1 transition-colors duration-500";
const DIVIDER = "border-0 border-l border-solid border-[var(--amp-color-default-border)]";

/** Shows a falling count counting down rather than jumping, so differences
 * visibly drain away after a match; a rising count updates at once. */
function useCountDown(target: number, durationMs = 600) {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = shownRef.current;
    if (target >= from) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / durationMs);
      const value = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      shownRef.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}

/** The project amp's fingerprint next to its linked network amp's, row by row,
 * with differing settings in red. When the project context is passed, the
 * merge panel on top can match the offline amp to the online one. */
export function FingerprintMismatchModal({
  opened,
  onClose,
  lock,
  focusDifferences,
  projectId,
  assignmentId,
  following,
  onProjectUpdate,
}: {
  opened: boolean;
  onClose: () => void;
  lock: AmpEditLock | null;
  /** Open expanded and filtered to what differs, rather than on the collapsed
   * summary — for an opening that is *about* a difference (an amp that just
   * fell out of sync, or the banner's "Show differences"). Read only as the
   * modal opens, so the user can collapse or unfilter afterwards. */
  focusDifferences?: boolean;
  projectId?: string;
  assignmentId?: string;
  /** Set while this project amp is following its linked online amp. Pushing is
   * withdrawn then: the project is a mirror rather than a plan, edits already
   * go straight to the amp, and `useLinkedSync` would pull any difference back
   * out from under a push. */
  following?: boolean;
  onProjectUpdate?: (project: Project) => void;
}) {
  const compact = useIsCompact();
  const canMerge = Boolean(projectId && assignmentId && onProjectUpdate);
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  // With the merge panel on top, the row-by-row table is secondary — it stays
  // collapsed until asked for (or until a match attempt fails). Without the
  // panel it's the whole point of the modal.
  const [detailsOpen, setDetailsOpen] = useState(!canMerge);
  // Rows from a match attempt whose hashes still differed — shown instead of
  // the lock's own rows until the online amp changes.
  const [remaining, setRemaining] = useState<FingerprintRow[] | null>(null);
  // Which way the panel is pointing, owned here so the write plan below can
  // appear alongside it.
  const [direction, setDirection] = useState<MergeDirection>("pull");
  const [push, setPush] = useState({ running: false, attempt: 0 });

  const pushBlocked = following
    ? "This amp is following the online one, so its settings are already the amp's. Stop following to write to the amp instead."
    : null;

  const liveHash = lock?.live?.ampHash ?? null;
  useEffect(() => {
    setRemaining(null);
  }, [liveHash, assignmentId]);

  // Following can start while the modal is open, which withdraws the
  // direction the panel is currently pointing.
  useEffect(() => {
    if (pushBlocked) setDirection("pull");
  }, [pushBlocked]);

  // Applied on the closed → open edge only: a later toggle by the user must
  // not be undone by a re-render while the modal stays open.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (opened && !wasOpen.current && focusDifferences) {
      setDetailsOpen(true);
      setOnlyDifferences(true);
    }
    wasOpen.current = opened;
  }, [opened, focusDifferences]);

  function handleMergeResult(result: AmpMergeResult | null) {
    if (result && !result.merged) {
      setRemaining(result.remaining);
      setOnlyDifferences(true);
      setDetailsOpen(true);
    } else {
      setRemaining(null);
    }
  }

  const rows = remaining ?? lock?.rows ?? [];
  const differenceCount = rows.filter((r) => r.differs).length;
  const shownCount = useCountDown(differenceCount);
  const visible = onlyDifferences ? rows.filter((r) => r.differs) : rows;

  const groups: { name: string; rows: FingerprintRow[] }[] = [];
  for (const row of visible) {
    const last = groups[groups.length - 1];
    if (last && last.name === row.group) last.rows.push(row);
    else groups.push({ name: row.group, rows: [row] });
  }

  const badge = lock ? STATE_BADGE[lock.state] : null;

  // Everything, independent of the "Only differences" filter.
  const json = lock
    ? JSON.stringify(
        {
          state: lock.state,
          locked: lock.locked,
          offline: lock.project,
          online: lock.live,
          rows: lock.rows,
          unreadable: lock.unreadable,
        },
        null,
        2,
      )
    : "";

  return (
    <Modal.Backdrop isOpen={opened} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Offline Amp vs. Online Amp</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <div className="flex min-w-0 flex-col gap-2">
              {canMerge && projectId && assignmentId && onProjectUpdate && (
                <>
                  <AmpMergePanel
                    lock={lock}
                    projectId={projectId}
                    assignmentId={assignmentId}
                    direction={direction}
                    onDirectionChange={setDirection}
                    pushBlocked={pushBlocked}
                    onProjectUpdate={onProjectUpdate}
                    onResult={handleMergeResult}
                    onPushStateChange={(running, attempt) => setPush({ running, attempt })}
                  />
                  {direction === "push" && (
                    <AmpPushSteps
                      lock={lock}
                      projectId={projectId}
                      assignmentId={assignmentId}
                      running={push.running}
                      reloadKey={push.attempt}
                    />
                  )}
                  <hr className="m-0 border-t border-[var(--amp-color-default-border)]" />
                </>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {badge && <Chip color={badge.color}>{badge.label}</Chip>}
                  {rows.length > 0 && (
                    <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
                      {shownCount} {shownCount === 1 ? "difference" : "differences"}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                >
                  {detailsOpen ? "Hide details" : "Show details"}
                  <ChevronDown size={14} className={`transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`} />
                </Button>
              </div>

              {lock && lock.unreadable.length > 0 && (
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Title>Can't compare everything</Alert.Title>
                    <Alert.Description>
                      <div className="flex flex-col gap-0.5">
                        {lock.unreadable.map((reason) => (
                          <span key={reason} style={{ fontSize: "var(--amp-font-size-sm)" }}>
                            {reason}
                          </span>
                        ))}
                      </div>
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {lock?.state === "checking" && (
                <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
                  Waiting for the amp's first settings reading…
                </span>
              )}

              {detailsOpen && (
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <Switch isSelected={onlyDifferences} onChange={setOnlyDifferences}>
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span style={{ fontSize: "var(--amp-font-size-sm)" }}>Only differences</span>
                      </Switch.Content>
                    </Switch>
                    <CopyJsonButton value={json} disabled={!lock} />
                  </div>

                  {remaining && (
                    <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                      Showing what still differs after the match attempt — nothing was saved.
                    </span>
                  )}

                  {rows.length > 0 && (
                    <div className="min-w-0 overflow-x-auto">
                      <div
                        className="grid min-w-[560px]"
                        style={{ gridTemplateColumns: "minmax(150px, 0.8fr) minmax(0, 1fr) minmax(0, 1fr)" }}
                      >
                        <div className={CELL} />
                        <div className={CELL}>
                          <div style={{ fontSize: "var(--amp-font-size-xs)", fontWeight: 600, color: "var(--amp-color-dimmed)", textTransform: "uppercase" }}>
                            Offline Amp
                          </div>
                          <code className="font-mono text-xs">{lock?.project?.ampHash ?? "—"}</code>
                        </div>
                        <div className={`${CELL} ${DIVIDER}`}>
                          <div style={{ fontSize: "var(--amp-font-size-xs)", fontWeight: 600, color: "var(--amp-color-dimmed)", textTransform: "uppercase" }}>
                            Online Amp
                          </div>
                          <code className="font-mono text-xs">{lock?.live?.ampHash ?? "—"}</code>
                        </div>

                        {groups.map((group) => (
                          <Fragment key={group.name}>
                            <div className="col-span-3 mt-2 px-2 py-1">
                              <span
                                style={{
                                  fontSize: "var(--amp-font-size-xs)",
                                  fontWeight: 600,
                                  color: "var(--amp-color-dimmed)",
                                  textTransform: "uppercase",
                                  letterSpacing: 0.5,
                                }}
                              >
                                {group.name}
                              </span>
                            </div>
                            {group.rows.map((row) => {
                              const tint = row.differs ? "bg-[var(--amp-color-red-light)]" : "";
                              const valueColor = row.differs
                                ? "var(--amp-color-red-6)"
                                : row.hashed
                                  ? undefined
                                  : "var(--amp-color-dimmed)";
                              return (
                                <Fragment key={`${group.name}:${row.label}`}>
                                  <div className={`${CELL} ${tint}`}>
                                    <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                                      {row.label}
                                      {!row.hashed && " (not compared)"}
                                    </span>
                                  </div>
                                  <div className={`${CELL} ${tint}`}>
                                    <span
                                      style={{
                                        fontSize: "var(--amp-font-size-xs)",
                                        color: valueColor,
                                        fontWeight: row.differs ? 500 : undefined,
                                      }}
                                    >
                                      {row.project ?? "—"}
                                    </span>
                                  </div>
                                  <div className={`${CELL} ${DIVIDER} ${tint}`}>
                                    <span
                                      style={{
                                        fontSize: "var(--amp-font-size-xs)",
                                        color: valueColor,
                                        fontWeight: row.differs ? 500 : undefined,
                                      }}
                                    >
                                      {row.live ?? "—"}
                                    </span>
                                  </div>
                                </Fragment>
                              );
                            })}
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}

                  {onlyDifferences && visible.length === 0 && rows.length > 0 && (
                    <span
                      style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)", textAlign: "center" }}
                    >
                      No differences.
                    </span>
                  )}
                </div>
              )}
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
