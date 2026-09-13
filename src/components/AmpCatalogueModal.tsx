import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Center,
  Collapse,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Tree,
  UnstyledButton,
  getTreeExpandedState,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
} from "@mantine/core";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import {
  commands,
  type AmpModelCatalogEntry,
  type Project,
} from "../lib/bindings";
import { getAmpSpecSheet } from "../lib/ampSpecSheets";
import { firmwareOptionsFor } from "../lib/firmwareOptions";
import { useIsCompact } from "../lib/breakpoints";

interface AmpCatalogueModalProps {
  opened: boolean;
  onClose: () => void;
  projectId: string;
  ampModels: AmpModelCatalogEntry[];
  onProjectUpdate: (project: Project) => void;
}

function wattsOf(model: AmpModelCatalogEntry): number {
  return getAmpSpecSheet(model)?.watts8ohm ?? -1;
}

/** Maps every node value to its sibling values (same parent), so expanding
 * one node in a layer can collapse the rest of that layer. */
function buildSiblingMap(
  nodes: TreeNodeData[],
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
  const [label, setLabel] = useState("");
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
  ): TreeNodeData {
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

  const treeData: TreeNodeData[] = useMemo(() => {
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
    () => getTreeExpandedState(treeData, defaultExpandedPath),
  );

  function handleExpandedStateChange(newState: Record<string, boolean>) {
    const next = { ...newState };
    for (const value of Object.keys(newState)) {
      if (newState[value] && !expandedState[value]) {
        for (const sibling of siblingMap.get(value) ?? []) {
          next[sibling] = false;
        }
      }
    }
    setExpandedState(next);
  }

  const tree = useTree({
    expandedState,
    onExpandedStateChange: handleExpandedStateChange,
  });

  useEffect(() => {
    if (opened) {
      setSelectedModelId(null);
      setSpecsExpanded(false);
      setLabel("");
      setFirmwareVersion(null);
      setSubmitError(null);
      setExpandedState(getTreeExpandedState(treeData, defaultExpandedPath));
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
      label.trim() || null,
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
    elementProps,
  }: RenderTreeNodePayload) {
    if (!hasChildren) {
      const m = modelById.get(node.value);
      if (!m) return null;
      const spec = getAmpSpecSheet(m);
      const isSelected = m.id === selectedModelId;
      return (
        <div
          {...elementProps}
          onClick={(e) => {
            elementProps.onClick(e);
            setSelectedModelId(m.id);
            setSpecsExpanded(false);
            setSubmitError(null);
            setFirmwareVersion(firmwareOptionsFor(m.protocol)[0] ?? null);
          }}
          style={elementProps.style}
          className={`${elementProps.className} cursor-pointer rounded-[var(--mantine-radius-xs)] px-[var(--mantine-spacing-xs)] py-1 ${
            isSelected ? "bg-[var(--mantine-color-amber-light)] opacity-100" : "opacity-50"
          }`}
        >
          <Group gap="xs" wrap="nowrap" justify="space-between">
            <Group gap="xs" wrap="nowrap">
              {m.brand === "CVR" ? (
                <img src="/cvr_dsp_amp.png" alt="CVR amp" className="h-8 w-8 object-contain" />
              ) : (
                <ThemeIcon variant="light" color="gray" size="lg">
                  <Server size={18} />
                </ThemeIcon>
              )}
              <div>
                <Text size="sm">{m.model}</Text>
                <Text size="xs" c="dimmed">
                  {spec ? `${spec.watts8ohm}W @ 8Ω` : null}
                </Text>
              </div>
            </Group>
            {m.isDante && (
              <img
                src="/dante_logo.png"
                alt="Dante"
                className="h-7 object-contain dark:brightness-0 dark:invert"
              />
            )}
          </Group>
        </div>
      );
    }

    return (
      <Group
        {...elementProps}
        gap={4}
        wrap="nowrap"
        style={elementProps.style}
        className={`${elementProps.className} cursor-pointer py-1`}
      >
        <ChevronRight
          size={14}
          className={`transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
        />
        <Text size="sm" fw={600}>
          {node.label}
        </Text>
      </Group>
    );
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Add Amp" size="xl" centered fullScreen={compact}>
      {/* Model tree beside the detail pane on a roomy window; on a small one
       * the modal goes full-screen and the two stack, since a 260px tree
       * plus a spec sheet can't share a narrow dialog. */}
      <Group
        align="stretch"
        wrap={compact ? "wrap" : "nowrap"}
        gap="md"
        className={compact ? "min-h-0" : "min-h-[420px]"}
      >
        <Box w={compact ? "100%" : 260} className={compact ? "max-h-[40vh] overflow-y-auto" : undefined}>
          <Tree
            data={treeData}
            tree={tree}
            renderNode={renderNode}
            levelOffset="md"
          />
        </Box>

        <Box className="flex min-w-0 flex-1 flex-col">
          {selectedModel ? (
            <Stack className="min-h-0 flex-1">
              {selectedModel.brand === "CVR" && (
                <img src="/cvr_dsp_amp.png" alt="CVR amp" className="h-20 w-full object-contain" />
              )}
              <Group gap="xs" justify="space-between">
                <Group gap="xs">
                  {selectedModel.brand !== "CVR" && (
                    <ThemeIcon variant="light" color="gray" size="xl">
                      <Server size={28} />
                    </ThemeIcon>
                  )}
                  <div>
                    <Text fw={600}>
                      {selectedModel.brand} {selectedModel.model}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {selectedModel.channelCount}-Channel
                    </Text>
                  </div>
                </Group>
                {selectedModel.isDante && (
                  <img
                    src="/dante_logo.png"
                    alt="Dante"
                    className="h-7 object-contain dark:brightness-0 dark:invert"
                  />
                )}
              </Group>

              {selectedSpec ? (
                <Stack gap={4}>
                  <Group justify="space-between">
                    <Text size="sm">Wattage @ 8Ω / channel</Text>
                    <Text size="sm" fw={600}>
                      {selectedSpec.watts8ohm}W
                    </Text>
                  </Group>

                  <UnstyledButton
                    onClick={() => setSpecsExpanded((v) => !v)}
                    className="inline-flex w-fit items-center gap-1"
                  >
                    <Text size="xs" c="dimmed">
                      {specsExpanded ? "Hide more specs" : "Show more specs"}
                    </Text>
                    <ChevronDown
                      size={12}
                      className={`transition-transform duration-100 ${specsExpanded ? "rotate-180" : ""}`}
                    />
                  </UnstyledButton>

                  <Collapse expanded={specsExpanded}>
                    <Table.ScrollContainer minWidth={240}>
                    <Table mt={4}>
                      <Table.Tbody>
                        <Table.Tr>
                          <Table.Td>4Ω / channel</Table.Td>
                          <Table.Td>{selectedSpec.watts4ohm}W</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>2Ω / channel</Table.Td>
                          <Table.Td>{selectedSpec.watts2ohm}W</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>8Ω Bridge</Table.Td>
                          <Table.Td>{selectedSpec.wattsBridge8ohm}W</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>Default Gain</Table.Td>
                          <Table.Td>{selectedSpec.defaultGainDb}dB</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>Gain Range</Table.Td>
                          <Table.Td>
                            {selectedSpec.gainRangeDb[0]}–
                            {selectedSpec.gainRangeDb[1]}dB
                          </Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>Size (W×H×D)</Table.Td>
                          <Table.Td>{selectedSpec.sizeWxHxDmm}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>Weight</Table.Td>
                          <Table.Td>{selectedSpec.weightKg}kg</Table.Td>
                        </Table.Tr>
                      </Table.Tbody>
                    </Table>
                    </Table.ScrollContainer>
                  </Collapse>
                </Stack>
              ) : (
                <Text c="dimmed" size="sm">
                  No spec sheet available for this model.
                </Text>
              )}

              <Stack gap="xs" mt="auto">
                <TextInput
                  label="Label"
                  placeholder="Optional"
                  value={label}
                  onChange={(e) => setLabel(e.currentTarget.value)}
                />
                {firmwareOptions.length > 0 && (
                  <Select
                    label="Firmware Version"
                    description="Which parameter ranges/units to plan around — not detected, since there's no live device yet."
                    data={firmwareOptions}
                    value={firmwareVersion}
                    onChange={setFirmwareVersion}
                    allowDeselect={false}
                  />
                )}
                <Text size="xs" c="dimmed">
                  This slot isn't linked to a physical unit yet — that happens
                  later via network discovery, not manual entry.
                </Text>
                {submitError && (
                  <Text c="red" size="sm">
                    {submitError}
                  </Text>
                )}
                <Group justify="flex-end">
                  <Button loading={submitting} onClick={handleAddAssignment}>
                    Add
                  </Button>
                </Group>
              </Stack>
            </Stack>
          ) : (
            <Center className="flex-1">
              <Text c="dimmed">Select an amp model from the list</Text>
            </Center>
          )}
        </Box>
      </Group>
    </Modal>
  );
}
