import { Card } from "@heroui/react";
import { FolderCog, Radio } from "lucide-react";

interface AppModeSelectorProps {
  onSelectLiveControl: () => void;
  onSelectProjectDesign: () => void;
}

function ModeCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Card onClick={onClick} className="cursor-pointer p-[var(--amp-spacing-lg)]" style={{ flex: "1 1 200px" }}>
      <div className="flex flex-col items-center gap-2 text-center">
        <div
          className="flex items-center justify-center rounded-full"
          style={{
            width: 48,
            height: 48,
            background: "var(--amp-color-gray-light)",
            color: "var(--amp-color-gray-6)",
          }}
        >
          {icon}
        </div>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: "var(--amp-font-size-sm)", color: "var(--amp-color-dimmed)" }}>
          {description}
        </span>
      </div>
    </Card>
  );
}

export function AppModeSelector({ onSelectLiveControl, onSelectProjectDesign }: AppModeSelectorProps) {
  return (
    /* Centered while it fits, scrollable once a short window makes it
     * taller than the viewport — a plain `Center` would clip both ends. */
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center p-4">
        <div className="flex w-full flex-col gap-6" style={{ maxWidth: 520 }}>
          <div className="flex flex-col gap-1">
            <h2 className="text-center text-2xl font-semibold m-0">Welcome to AmpCore</h2>
            <span style={{ color: "var(--amp-color-dimmed)", textAlign: "center" }}>
              Choose how you'd like to start
            </span>
          </div>

          {/* Two cards side by side while there's room; below ~420px they
           * stack rather than squeezing to two illegible columns. */}
          <div className="flex flex-wrap items-stretch gap-3">
            <ModeCard
              icon={<Radio size={24} />}
              title="Live Control"
              description="Connect to and control amps on the network in real time."
              onClick={onSelectLiveControl}
            />
            <ModeCard
              icon={<FolderCog size={24} />}
              title="Project Design"
              description="Plan projects, amp assignments, and speaker configurations offline."
              onClick={onSelectProjectDesign}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
