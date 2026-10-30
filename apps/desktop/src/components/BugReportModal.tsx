import { useState, type FormEvent } from "react";
import { Button, Input, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { commands } from "../lib/bindings";

/** Title and description, sent with `bug_report_send`. Trying to send is the
 * connectivity check: on any failure the dialog stays open with the text in it. */
export function BugReportModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    const result = await commands.bugReportSend(title, description);
    setSending(false);
    if (result.status === "error") {
      setError(result.error.message);
      return;
    }
    toast.success("Bug report sent");
    setTitle("");
    setDescription("");
    onClose();
  }

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <Modal.Container placement="center">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Report a bug</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            <form onSubmit={handleSend}>
              <div className="flex flex-col gap-3">
                <TextField isRequired autoFocus>
                  <Label>Title</Label>
                  <Input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
                </TextField>
                <TextField isRequired>
                  <Label>Description</Label>
                  <TextArea
                    rows={6}
                    maxLength={8000}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </TextField>
                <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-xs)" }}>
                  Sent to the AmpCore developers with your app version and operating system.
                </span>
                {error && (
                  <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>{error}</span>
                )}
                <Button type="submit" variant="primary" isDisabled={sending}>
                  {sending ? "Sending…" : "Send"}
                </Button>
              </div>
            </form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
