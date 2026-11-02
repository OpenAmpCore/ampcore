import { useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { Button, Input, Label, Modal, TextArea, TextField, toast } from "@heroui/react";
import { ImagePlus, X } from "lucide-react";
import { commands } from "../lib/bindings";

const IMAGES_MAX = 3;

/** Title, description and up to three screenshots (picked or pasted), sent with
 * `bug_report_send`. Trying to send is the connectivity check: offline, the
 * backend saves the report and retries on its own. Any other failure keeps the
 * dialog open with the text in it. */
export function BugReportModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** Data URLs: shown as thumbnails, their base64 part is what's sent. */
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(files: File[]) {
    for (const file of files.filter((f) => f.type === "image/png" || f.type === "image/jpeg")) {
      const reader = new FileReader();
      reader.onload = () => setImages((prev) => (prev.length < IMAGES_MAX ? [...prev, reader.result as string] : prev));
      reader.readAsDataURL(file);
    }
  }

  function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData.files);
    if (files.some((f) => f.type.startsWith("image/"))) {
      event.preventDefault();
      addFiles(files);
    }
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    const result = await commands.bugReportSend(title, description, images.map((url) => url.split(",")[1]));
    setSending(false);
    if (result.status === "error") {
      setError(result.error.message);
      return;
    }
    if (result.data === "Saved") {
      toast("Saved. It will be sent automatically when this computer is online.");
    } else {
      toast.success("Bug report sent");
    }
    setTitle("");
    setDescription("");
    setImages([]);
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
            <form onSubmit={handleSend} onPaste={handlePaste}>
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
                <div className="flex flex-wrap items-center gap-2">
                  {images.map((url, i) => (
                    <div key={url} className="relative">
                      <img src={url} alt={`Screenshot ${i + 1}`} className="h-16 w-16 rounded-md border border-border object-cover" />
                      <Button
                        isIconOnly
                        size="sm"
                        variant="secondary"
                        aria-label="Remove picture"
                        className="absolute -right-2 -top-2 h-6 w-6 min-w-6 rounded-full"
                        onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  ))}
                  {images.length < IMAGES_MAX && (
                    <Button size="sm" variant="ghost" onPress={() => fileInput.current?.click()}>
                      <ImagePlus size={16} />
                      Add screenshot
                    </Button>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg"
                    multiple
                    hidden
                    onChange={(e) => {
                      addFiles(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                  />
                </div>
                <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-xs)" }}>
                  Sent to the AmpCore developers with your app version and operating system. You can also paste a
                  screenshot (Ctrl+V).
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
