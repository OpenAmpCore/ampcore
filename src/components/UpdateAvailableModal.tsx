import { Button, Modal, Spinner } from "@heroui/react";
import type { Update } from "@tauri-apps/plugin-updater";

interface UpdateAvailableModalProps {
  update: Update | null;
  installing: boolean;
  onInstall: () => void;
  onAbort: () => void;
  onDisable: () => void;
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
