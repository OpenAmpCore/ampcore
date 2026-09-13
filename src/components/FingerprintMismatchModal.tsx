import { Fragment, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  Collapse,
  CopyButton,
  Divider,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { ChevronDown } from "lucide-react";
import type { AmpEditLock, AmpEditLockState, AmpMergeResult, FingerprintRow, Project } from "../lib/bindings";
import { useIsCompact } from "../lib/breakpoints";
import { AmpMergePanel, type MergeDirection } from "./AmpMergePanel";
import { AmpPushSteps } from "./AmpPushSteps";

const STATE_BADGE: Record<AmpEditLockState, { color: string; label: string }> = {
  unlinked: { color: "gray", label: "Unlinked" },
  offline: { color: "gray", label: "Offline" },
  checking: { color: "gray", label: "Checking" },
  matches: { color: "green", label: "Matches" },
  mismatch: { color: "red", label: "Mismatch" },
  unreadable: { color: "red", label: "Unreadable" },
  disengaged: { color: "amber", label: "Disengaged" },
};

// `transition-colors`: after a match, the red tints fade out instead of
// vanishing.
const CELL = "min-w-0 px-2 py-1 transition-colors duration-500";
const DIVIDER = "border-0 border-l border-solid border-[var(--mantine-color-default-border)]";

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
    <Modal opened={opened} onClose={onClose} title="Offline Amp vs. Online Amp" size="xl" centered fullScreen={compact}>
      <Stack gap="sm" className="min-w-0">
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
            <Divider />
          </>
        )}

        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs" wrap="wrap">
            {badge && (
              <Badge color={badge.color} variant="light">
                {badge.label}
              </Badge>
            )}
            {rows.length > 0 && (
              <Text size="sm" c="dimmed">
                {shownCount} {shownCount === 1 ? "difference" : "differences"}
              </Text>
            )}
          </Group>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            rightSection={
              <ChevronDown
                size={14}
                className={`transition-transform duration-200 ${detailsOpen ? "rotate-180" : ""}`}
              />
            }
          >
            {detailsOpen ? "Hide details" : "Show details"}
          </Button>
        </Group>

        {lock && lock.unreadable.length > 0 && (
          <Alert color="red" variant="light" title="Can't compare everything">
            <Stack gap={2}>
              {lock.unreadable.map((reason) => (
                <Text key={reason} size="sm">
                  {reason}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}

        {lock?.state === "checking" && (
          <Text size="sm" c="dimmed">
            Waiting for the amp's first settings reading…
          </Text>
        )}

        <Collapse expanded={detailsOpen}>
          <Stack gap="sm" className="min-w-0">
            <Group justify="flex-end" gap="sm" wrap="wrap">
              <Switch
                size="sm"
                label="Only differences"
                checked={onlyDifferences}
                onChange={(e) => setOnlyDifferences(e.currentTarget.checked)}
              />
              <CopyButton value={json}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant={copied ? "light" : "default"}
                    color={copied ? "green" : undefined}
                    disabled={!lock}
                    onClick={copy}
                  >
                    {copied ? "Copied" : "Copy all as JSON"}
                  </Button>
                )}
              </CopyButton>
            </Group>

            {remaining && (
              <Text size="xs" c="dimmed">
                Showing what still differs after the match attempt — nothing was saved.
              </Text>
            )}

            {rows.length > 0 && (
              <div className="min-w-0 overflow-x-auto">
                <div
                  className="grid min-w-[560px]"
                  style={{ gridTemplateColumns: "minmax(150px, 0.8fr) minmax(0, 1fr) minmax(0, 1fr)" }}
                >
                  <div className={CELL} />
                  <div className={CELL}>
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                      Offline Amp
                    </Text>
                    <Code>{lock?.project?.ampHash ?? "—"}</Code>
                  </div>
                  <div className={`${CELL} ${DIVIDER}`}>
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                      Online Amp
                    </Text>
                    <Code>{lock?.live?.ampHash ?? "—"}</Code>
                  </div>

                  {groups.map((group) => (
                    <Fragment key={group.name}>
                      <div className="col-span-3 mt-2 px-2 py-1">
                        <Text size="xs" fw={600} c="dimmed" tt="uppercase" lts={0.5}>
                          {group.name}
                        </Text>
                      </div>
                      {group.rows.map((row) => {
                        const tint = row.differs ? "bg-[var(--mantine-color-red-light)]" : "";
                        const valueColor = row.differs ? "red" : row.hashed ? undefined : "dimmed";
                        return (
                          <Fragment key={`${group.name}:${row.label}`}>
                            <div className={`${CELL} ${tint}`}>
                              <Text size="xs" c="dimmed">
                                {row.label}
                                {!row.hashed && " (not compared)"}
                              </Text>
                            </div>
                            <div className={`${CELL} ${tint}`}>
                              <Text size="xs" c={valueColor} fw={row.differs ? 500 : undefined}>
                                {row.project ?? "—"}
                              </Text>
                            </div>
                            <div className={`${CELL} ${DIVIDER} ${tint}`}>
                              <Text size="xs" c={valueColor} fw={row.differs ? 500 : undefined}>
                                {row.live ?? "—"}
                              </Text>
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
              <Text size="sm" c="dimmed" ta="center">
                No differences.
              </Text>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Modal>
  );
}
