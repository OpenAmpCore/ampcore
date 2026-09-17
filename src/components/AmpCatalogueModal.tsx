import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Input, Label, Modal, Spinner, TextField } from "@heroui/react";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import {
  commands,
  type AmpModelCatalogEntry,
  type Project,
} from "../lib/bindings";
import { getAmpSpecSheet } from "../lib/ampSpecSheets";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { useIsCompact } from "../lib/breakpoints";
import { SimpleSelect } from "./SimpleSelect";

interface AmpCatalogueModalProps {
  opened: boolean;
  onClose: () => void;
  projectId: string;
  ampModels: AmpModelCatalogEntry[];
  onProjectUpdate: (project: Project) => void;
}

/** Minimal replacement for Mantine's `TreeNodeData` — this file's own tree
 * shape (brand > Regular/Dante > channel count > model), scoped to what
 * `AmpCatalogueModal` actually needs rather than a general-purpose tree
 * widget/library. */
interface CatalogueTreeNode {
  label: string;
  value: string;
  children?: CatalogueTreeNode[];
}

function wattsOf(model: AmpModelCatalogEntry): number {
  return getAmpSpecSheet(model)?.watts8ohm ?? -1;
}

/** Maps every node value to its sibling values (same parent), so expanding
 * one node in a layer can collapse the rest of that layer. */
function buildSiblingMap(
  nodes: CatalogueTreeNode[],
  map = new Map<string, string[]>(),
): Map<string, string[]> {
  const values = nodes.map((n) => n.value);
  for (const node of nodes) {
    map.set(
      node.value,
      values.filter((v) => v !== node.value),
    );
    if (node.children) buildSiblingMap(node.children, map);
  }
  return map;
}

/** Marks every node named in `path` expanded — this file only ever expands
 * one straight-line path (the first brand's Regular/4-Channel default), so
 * this is the one-path case of Mantine's `getTreeExpandedState`. */
function expandedStateForPath(path: string[]): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const value of path) state[value] = true;
  return state;
}

/** Per-level indent, in px. Applied by each row as `depth * LEVEL_OFFSET`. */
const LEVEL_OFFSET = 12;

/** Recursive renderer for `CatalogueTreeNode[]` — replaces Mantine's `Tree`.
 * Expansion is fully controlled by the parent's `expandedState`/`onToggle`,
 * matching how `useTree`'s controlled mode worked here.
 *
 * `depth` is handed to `renderNode` so each row indents itself, rather than
 * being indented by a wrapper around its children: nested wrappers compound,
 * so a flat `depth * LEVEL_OFFSET` became a quadratic 0/14/42/84px. Indenting
 * the row also keeps its hover/selected background spanning the full width. */
function CatalogueTree({
  nodes,
  depth,
  expandedState,
  onToggle,
  renderNode,
}: {
  nodes: CatalogueTreeNode[];
  depth: number;
  expandedState: Record<string, boolean>;
  onToggle: (value: string) => void;
  renderNode: (args: { node: CatalogueTreeNode; hasChildren: boolean; expanded: boolean; depth: number; onToggle: () => void }) => ReactNode;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = Boolean(node.children && node.children.length > 0);
        const expanded = expandedState[node.value] ?? false;
        return (
          <div key={node.value}>
            {renderNode({ node, hasChildren, expanded, depth, onToggle: () => onToggle(node.value) })}
            {hasChildren && expanded && (
              <CatalogueTree
                nodes={node.children!}
                depth={depth + 1}
                expandedState={expandedState}
                onToggle={onToggle}
                renderNode={renderNode}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function ThemeIcon({ size, className, children }: { size: number; className?: string; children: ReactNode }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-default text-muted ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {children}
    </div>
  );
}

export function AmpCatalogueModal({
  opened,
  onClose,
  projectId,
  ampModels,
  onProjectUpdate,
}: AmpCatalogueModalProps) {
  const compact = useIsCompact();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [specsExpanded, setSpecsExpanded] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const active = useMemo(
    () => ampModels.filter((m) => !m.archived),
    [ampModels],
  );
  const modelById = useMemo(() => {
    const map = new Map<string, AmpModelCatalogEntry>();
    for (const m of active) map.set(m.id, m);
    return map;
  }, [active]);

  function buildBrandNode(
    brand: string,
    models: AmpModelCatalogEntry[],
  ): CatalogueTreeNode {
    const regular = models.filter((m) => !m.isDante);
    const dante = models.filter((m) => m.isDante);
    const bucket = (list: AmpModelCatalogEntry[], channelCount: number) =>
      list
        .filter((m) => m.channelCount === channelCount)
        .sort((a, b) => wattsOf(b) - wattsOf(a));

    return {
      label: brand,
      value: brand,
      children: [
        {
          label: "Regular",
          value: `${brand}-regular`,
          children: [
            {
              label: "4-Channel",
              value: `${brand}-regular-4ch`,
              children: bucket(regular, 4).map((m) => ({
                label: m.model,
                value: m.id,
              })),
            },
            {
              label: "2-Channel",
              value: `${brand}-regular-2ch`,
              children: bucket(regular, 2).map((m) => ({
                label: m.model,
                value: m.id,
              })),
            },
          ],
        },
        {
          label: "Dante",
          value: `${brand}-dante`,
          children: [
            {
              label: "4-Channel",
              value: `${brand}-dante-4ch`,
              children: bucket(dante, 4).map((m) => ({
                label: m.model,
                value: m.id,
              })),
            },
            {
              label: "2-Channel",
              value: `${brand}-dante-2ch`,
              children: bucket(dante, 2).map((m) => ({
                label: m.model,
                value: m.id,
              })),
            },
          ],
        },
      ],
    };
  }

  const treeData: CatalogueTreeNode[] = useMemo(() => {
    const byBrand = new Map<string, AmpModelCatalogEntry[]>();
    for (const m of active) {
      const list = byBrand.get(m.brand);
      if (list) list.push(m);
      else byBrand.set(m.brand, [m]);
    }
    return Array.from(byBrand.entries()).map(([brand, models]) =>
      buildBrandNode(brand, models),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const defaultExpandedPath = useMemo(() => {
    const firstBrand = treeData[0]?.value;
    return firstBrand
      ? [firstBrand, `${firstBrand}-regular`, `${firstBrand}-regular-4ch`]
      : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeData]);

  const siblingMap = useMemo(() => buildSiblingMap(treeData), [treeData]);

  const [expandedState, setExpandedState] = useState<Record<string, boolean>>(
    () => expandedStateForPath(defaultExpandedPath),
  );

  function toggleExpanded(value: string) {
    const isExpanding = !(expandedState[value] ?? false);
    const next = { ...expandedState, [value]: isExpanding };
    if (isExpanding) {
      for (const sibling of siblingMap.get(value) ?? []) {
        next[sibling] = false;
      }
    }
    setExpandedState(next);
  }

  useEffect(() => {
    if (opened) {
      setSelectedModelId(null);
      setSpecsExpanded(false);
      setDeviceName("");
      setFirmwareVersion(null);
      setSubmitError(null);
      setExpandedState(expandedStateForPath(defaultExpandedPath));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const selectedModel = selectedModelId
    ? (modelById.get(selectedModelId) ?? null)
    : null;
  const selectedSpec = selectedModel
    ? getAmpSpecSheet(selectedModel)
    : undefined;
  const firmwareOptions = selectedModel
    ? firmwareOptionsFor(selectedModel.protocol)
    : [];

  async function handleAddAssignment() {
    if (!selectedModelId) return;
    setSubmitError(null);
    setSubmitting(true);
    const result = await commands.projectsAddAmpAssignment(
      projectId,
      deviceName.trim() || null,
      selectedModelId,
      firmwareVersion,
    );
    setSubmitting(false);
    if (result.status === "ok") {
      onProjectUpdate(result.data);
      onClose();
    } else {
      setSubmitError(result.error.message);
    }
  }

  function renderNode({
    node,
    hasChildren,
    expanded,
    depth,
    onToggle,
  }: {
    node: CatalogueTreeNode;
    hasChildren: boolean;
    expanded: boolean;
    depth: number;
    onToggle: () => void;
  }) {
    if (!hasChildren) {
      const m = modelById.get(node.value);
      if (!m) return null;
      const spec = getAmpSpecSheet(m);
      const isSelected = m.id === selectedModelId;
      const select = () => {
        setSelectedModelId(m.id);
        setSpecsExpanded(false);
        setSubmitError(null);
        setFirmwareVersion(firmwareOptionsFor(m.protocol)[0] ?? null);
      };
      return (
        <div
          role="treeitem"
          aria-selected={isSelected}
          tabIndex={0}
          onClick={select}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              select();
            }
          }}
          style={{ paddingLeft: depth * LEVEL_OFFSET }}
          className={`cursor-pointer rounded-[var(--amp-radius-xs)] px-[var(--amp-spacing-xs)] py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            isSelected ? "bg-accent-soft opacity-100" : "opacity-50 hover:opacity-80"
          }`}
        >
          <div className="flex flex-nowrap items-center justify-between gap-2">
            <div className="flex flex-nowrap items-center gap-2">
              {m.brand === "CVR" ? (
                <img src="/cvr_dsp_amp.png" alt="CVR amp" className="h-9 w-9 object-contain" />
              ) : (
                <ThemeIcon size={36}>
                  <Server size={18} />
                </ThemeIcon>
              )}
              <div>
                <div style={{ fontSize: "var(--amp-font-size-sm)" }}>{m.model}</div>
                <div style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                  {spec ? `${spec.watts8ohm}W @ 8Ω` : null}
                </div>
              </div>
            </div>
            {m.isDante && (
              <img
                src="/dante_logo.png"
                alt="Dante"
                className="h-7 object-contain dark:brightness-0 dark:invert"
              />
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{ paddingLeft: depth * LEVEL_OFFSET }}
        className="flex cursor-pointer flex-nowrap items-center gap-1 rounded-[var(--amp-radius-xs)] py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight
          size={14}
          className={`transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
        />
        <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 600 }}>{node.label}</span>
      </div>
    );
  }

  return (
    <Modal.Backdrop isOpen={opened} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container placement="center" size={compact ? "full" : "lg"}>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>Add Amp</Modal.Heading>
            <Modal.CloseTrigger />
          </Modal.Header>
          <Modal.Body>
            {/* Model tree beside the detail pane on a roomy window; on a small one
             * the modal goes full-screen and the two stack, since a 260px tree
             * plus a spec sheet can't share a narrow dialog. */}
            <div
              className={`flex items-stretch gap-4 ${compact ? "min-h-0 flex-wrap" : "min-h-[420px] flex-nowrap"}`}
            >
              <div
                role="tree"
                style={{ width: compact ? "100%" : 260 }}
                className={compact ? "max-h-[40vh] overflow-y-auto" : "min-h-0 overflow-y-auto"}
              >
                <CatalogueTree
                  nodes={treeData}
                  depth={0}
                  expandedState={expandedState}
                  onToggle={toggleExpanded}
                  renderNode={renderNode}
                />
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                {selectedModel ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3">
                    {selectedModel.brand === "CVR" && (
                      <img src="/cvr_dsp_amp.png" alt="CVR amp" className="h-20 w-full object-contain" />
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {selectedModel.brand !== "CVR" && (
                          <ThemeIcon size={48}>
                            <Server size={28} />
                          </ThemeIcon>
                        )}
                        <div>
                          <div style={{ fontWeight: 600 }}>
                            {selectedModel.brand} {selectedModel.model}
                          </div>
                          <div style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                            {selectedModel.channelCount}-Channel
                          </div>
                        </div>
                      </div>
                      {selectedModel.isDante && (
                        <img
                          src="/dante_logo.png"
                          alt="Dante"
                          className="h-7 object-contain dark:brightness-0 dark:invert"
                        />
                      )}
                    </div>

                    {selectedSpec ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span style={{ fontSize: "var(--amp-font-size-sm)" }}>Wattage @ 8Ω / channel</span>
                          <span style={{ fontSize: "var(--amp-font-size-sm)", fontWeight: 600 }}>
                            {selectedSpec.watts8ohm}W
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => setSpecsExpanded((v) => !v)}
                          className="inline-flex w-fit cursor-pointer appearance-none items-center gap-1 rounded-[var(--amp-radius-xs)] border-0 bg-transparent p-0 font-[inherit] text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                            {specsExpanded ? "Hide more specs" : "Show more specs"}
                          </span>
                          <ChevronDown
                            size={12}
                            className={`transition-transform duration-100 ${specsExpanded ? "rotate-180" : ""}`}
                          />
                        </button>

                        {specsExpanded && (
                          <div className="overflow-x-auto" style={{ minWidth: 240 }}>
                            <table className="mt-1 w-full border-collapse text-sm">
                              <tbody>
                                <tr>
                                  <td className="p-1">4Ω / channel</td>
                                  <td className="p-1">{selectedSpec.watts4ohm}W</td>
                                </tr>
                                <tr>
                                  <td className="p-1">2Ω / channel</td>
                                  <td className="p-1">{selectedSpec.watts2ohm}W</td>
                                </tr>
                                <tr>
                                  <td className="p-1">8Ω Bridge</td>
                                  <td className="p-1">{selectedSpec.wattsBridge8ohm}W</td>
                                </tr>
                                <tr>
                                  <td className="p-1">Default Gain</td>
                                  <td className="p-1">{selectedSpec.defaultGainDb}dB</td>
                                </tr>
                                <tr>
                                  <td className="p-1">Gain Range</td>
                                  <td className="p-1">
                                    {selectedSpec.gainRangeDb[0]}–
                                    {selectedSpec.gainRangeDb[1]}dB
                                  </td>
                                </tr>
                                <tr>
                                  <td className="p-1">Size (W×H×D)</td>
                                  <td className="p-1">{selectedSpec.sizeWxHxDmm}</td>
                                </tr>
                                <tr>
                                  <td className="p-1">Weight</td>
                                  <td className="p-1">{selectedSpec.weightKg}kg</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: "var(--amp-color-dimmed)", fontSize: "var(--amp-font-size-sm)" }}>
                        No spec sheet available for this model.
                      </span>
                    )}

                    <div className="mt-auto flex flex-col gap-2">
                      <TextField>
                        <Label>Device Name</Label>
                        <Input placeholder="Optional" maxLength={32} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
                      </TextField>
                      {firmwareOptions.length > 0 && (
                        <SimpleSelect
                          label="Firmware Version"
                          description="Which parameter ranges/units to plan around — not detected, since there's no live device yet."
                          data={firmwareOptions.map((v) => ({ value: v, label: v }))}
                          value={firmwareVersion}
                          onChange={setFirmwareVersion}
                        />
                      )}
                      <span style={{ fontSize: "var(--amp-font-size-xs)", color: "var(--amp-color-dimmed)" }}>
                        This slot isn't linked to a physical unit yet — that happens
                        later via network discovery, not manual entry.
                      </span>
                      {submitError && (
                        <span style={{ color: "var(--amp-color-red-6)", fontSize: "var(--amp-font-size-sm)" }}>
                          {submitError}
                        </span>
                      )}
                      <div className="flex justify-end">
                        <Button variant="primary" isDisabled={submitting} onPress={handleAddAssignment}>
                          {submitting ? <Spinner size="sm" /> : "Add"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <span style={{ color: "var(--amp-color-dimmed)" }}>Select an amp model from the list</span>
                  </div>
                )}
              </div>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
