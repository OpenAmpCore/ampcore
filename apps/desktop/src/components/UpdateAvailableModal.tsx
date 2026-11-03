import { Button, Modal, Spinner } from "@heroui/react";
import type { Update } from "@tauri-apps/plugin-updater";

interface UpdateAvailableModalProps {
  update: Update | null;
  installing: boolean;
  onInstall: () => void;
  onAbort: () => void;
  onDisable: () => void;
}

/** `a` vs `b` as dotted version numbers: negative, 0 or positive. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The CHANGELOG.md sections latest.json's "notes" carries, keeping only
 * versions after `installed` up to `offered`. Notes without `## [x.y.z]`
 * headings are shown whole. */
function ReleaseNotes({ text, installed, offered }: { text: string; installed: string; offered: string }) {
  let keep = !/^## \[/m.test(text);
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-auto" style={{ fontSize: "var(--amp-font-size-sm)" }}>
      {text.split("\n").map((raw, i) => {
        const line = raw.trim();
        const version = /^## \[([^\]]+)\]/.exec(line)?.[1];
        if (version) {
          keep = compareVersions(version, installed) > 0 && compareVersions(version, offered) <= 0;
          return keep ? <strong key={i} className="mt-2">Version {version}</strong> : null;
        }
        if (!line || !keep) return null;
        if (line.startsWith("### ")) return <span key={i} className="mt-1 font-medium">{line.slice(4)}</span>;
        if (line.startsWith("- ")) return <div key={i} className="pl-3">• {line.slice(2)}</div>;
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}

export function UpdateAvailableModal({
  update,
  installing,
  onInstall,
  onAbort,
  onDisable,
}: UpdateAvailableModalProps) {
  return (
    <Modal.Backdrop
      isOpen={update !== null}
      onOpenChange={(open) => !open && onAbort()}
      isDismissable={!installing}
      isKeyboardDismissDisabled={installing}
    >
      <Modal.Container placement="center">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Update Available</Modal.Heading>
            {!installing && <Modal.CloseTrigger />}
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-3">
              <span style={{ fontSize: "var(--amp-font-size-sm)" }}>
                Version {update?.version} is available — you're currently on {update?.currentVersion}.
              </span>
              {update?.body?.trim() && (
                <ReleaseNotes text={update.body} installed={update.currentVersion} offered={update.version} />
              )}
              <div className="flex items-center justify-between">
                <Button variant="ghost" onPress={onDisable} isDisabled={installing}>
                  Disable update checks
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onPress={onAbort} isDisabled={installing}>
                    Not now
                  </Button>
                  <Button variant="primary" onPress={onInstall} isDisabled={installing}>
                    {installing ? <Spinner size="sm" /> : "Install now"}
                  </Button>
                </div>
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
