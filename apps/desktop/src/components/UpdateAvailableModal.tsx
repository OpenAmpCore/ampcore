import { Button, Modal, Spinner } from "@heroui/react";
import type { Update } from "@tauri-apps/plugin-updater";

interface UpdateAvailableModalProps {
  update: Update | null;
  installing: boolean;
  onInstall: () => void;
  onAbort: () => void;
  onDisable: () => void;
}

/** The CHANGELOG.md section the release carries (latest.json's "notes"):
 * `### ` headings, `- ` items, anything else a line of text. */
function ReleaseNotes({ text }: { text: string }) {
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-auto" style={{ fontSize: "var(--amp-font-size-sm)" }}>
      {text.split("\n").map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        if (line.startsWith("### ")) return <strong key={i} className="mt-1">{line.slice(4)}</strong>;
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
              {update?.body?.trim() && <ReleaseNotes text={update.body} />}
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
