import { useEffect, useState } from "react";
import { Alert, Button, Chip, Modal, Spinner, Tooltip } from "@heroui/react";
import { Fingerprint, RefreshCw } from "lucide-react";
import {
  commands,
  type AmpFingerprint,
  type ChannelFingerprint,
} from "../lib/bindings";
import { useIsCompact } from "../lib/breakpoints";

/** Which amp to fingerprint — a planned project assignment or a live device.
 * Both go through the same backend canonicalization (`data/fingerprint.rs`),
 * so their hashes are directly comparable. */
export type FingerprintTarget =
  | { kind: "project"; projectId: string; assignmentId: string }
  | { kind: "live"; deviceId: string };

function targetKey(target: FingerprintTarget | undefined): string | null {
  if (!target) return null;
  return target.kind === "project"
    ? `project:${target.projectId}:${target.assignmentId}`
    : `live:${target.deviceId}`;
}

/** Match/drift/none for the `_XXXX` hash carried in an output name. */
function EmbeddedHashBadge({ channel }: { channel: ChannelFingerprint }) {
  if (channel.embeddedHash === null) {
    return (
      <Chip color="default" size="sm">
        none
      </Chip>
    );
  }
  if (channel.embeddedHashMatches === null) {
    return (
      <Chip color="default" size="sm">
        unknown
      </Chip>
    );
  }
  return channel.embeddedHashMatches ? (
    <Chip color="success" size="sm">
      match
    </Chip>
  ) : (
    <Chip color="danger" size="sm">
      drift
    </Chip>
  );
}

/** Minimal copy-to-clipboard button, replacing Mantine's `CopyButton` render
 * prop — flips to "Copied" for 1.5s then reverts. */
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
      {copied ? "Copied" : "Copy JSON"}
    </Button>
  );
}

/** Tab-rail button plus modal showing an amp's fingerprint: amp hash,
 * per-channel speaker hashes and the full canonical JSON to copy. Read-only
 * groundwork for online/offline matching — nothing here writes. */
export function FingerprintInspector({
  target,
}: {
  target?: FingerprintTarget;
}) {
  const compact = useIsCompact();
  const [opened, setOpened] = useState(false);
  const [fingerprint, setFingerprint] = useState<AmpFingerprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const key = targetKey(target);

  useEffect(() => {
    if (!opened || !target) return;
    let cancelled = false;
    setLoading(true);
    const call =
      target.kind === "project"
        ? commands.fingerprintProjectAmp(target.projectId, target.assignmentId)
        : commands.fingerprintLiveDevice(target.deviceId);
    call.then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.status === "ok") {
        setFingerprint(result.data);
        setError(null);
      } else {
        setFingerprint(null);
        setError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
    // `key` stands in for `target`, whose object identity changes every render.
  }, [opened, key, reloadToken]);

  const json = fingerprint ? JSON.stringify(fingerprint, null, 2) : "";

  return (
    <>
      <Tooltip delay={300}>
        <Tooltip.Trigger>
          <Button
            isIconOnly
            variant="ghost"
            size="lg"
            className="mt-2 self-center"
            aria-label="Fingerprint"
            isDisabled={!target}
            onPress={() => setOpened(true)}
          >
            <Fingerprint size={18} />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content placement="right" showArrow>
          Fingerprint
        </Tooltip.Content>
      </Tooltip>

      <Modal.Backdrop isOpen={opened} onOpenChange={setOpened}>
        <Modal.Container placement="center" size={compact ? "full" : "lg"}>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Amp Fingerprint</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
                      Amp hash
                    </span>
                    <code className="font-mono text-sm">{fingerprint?.ampHash ?? "—"}</code>
                    {fingerprint && (
                      <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
                        {fingerprint.identity.model ?? "unknown model"} · {fingerprint.identity.channelCount} ch · fw{" "}
                        {fingerprint.identity.firmwareFamily ?? "?"}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {loading && <Spinner size="sm" />}
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => setReloadToken((t) => t + 1)}
                    >
                      <RefreshCw size={14} /> Refresh
                    </Button>
                    <CopyJsonButton value={json} disabled={!fingerprint} />
                  </div>
                </div>

                {error && <Alert status="danger">{error}</Alert>}

                {fingerprint && fingerprint.missing.length > 0 && (
                  <Alert status="warning">
                    <Alert.Content>
                      <Alert.Title>Incomplete</Alert.Title>
                      <Alert.Description>
                        <div className="flex flex-col gap-0.5">
                          {fingerprint.missing.map((reason) => (
                            <span key={reason} style={{ fontSize: "var(--amp-font-size-sm)" }}>
                              {reason}
                            </span>
                          ))}
                        </div>
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}

                {fingerprint && (
                  <div className="min-w-0 overflow-x-auto">
                    <table className="w-full border-collapse text-sm" style={{ minWidth: 420 }}>
                      <thead>
                        <tr className="border-b border-[var(--amp-color-default-border)]">
                          <th className="p-2 text-left">Out</th>
                          <th className="p-2 text-left">Speaker hash</th>
                          <th className="p-2 text-left">Output name</th>
                          <th className="p-2 text-left">Name hash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fingerprint.channels.map((channel, i) => (
                          <tr
                            key={channel.channelIndex}
                            className="border-b border-[var(--amp-color-default-border)]"
                            style={{
                              background: i % 2 === 1 ? "var(--amp-color-default-hover)" : undefined,
                            }}
                          >
                            <td className="p-2">{channel.label}</td>
                            <td className="p-2">
                              <code className="font-mono">{channel.speakerHash ?? "—"}</code>
                            </td>
                            <td className="p-2">{channel.outputName ?? "—"}</td>
                            <td className="p-2">
                              <EmbeddedHashBadge channel={channel} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {fingerprint && (
                  <pre className="max-h-[50vh] overflow-auto rounded-[var(--amp-radius-sm)] bg-[var(--amp-color-default)] p-2 font-mono text-sm">
                    {json}
                  </pre>
                )}
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
