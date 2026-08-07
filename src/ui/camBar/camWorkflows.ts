/**
 * CAM High-Level Workflows.
 * Encapsulates modal dialog workflows that generate or mutate CAM operations and geometry.
 */
import type { CADDocument } from "../../model/document";
import type { StitchPreview, FlipPreview } from "../../view/overlay";
import type { CAMOperation } from "../../cam/types";
import { generateMaterialTest } from "../../cam/materialTest";
import { buildJobFromLayers } from "../../cam/laserJob";
import { openFlipDialog } from "../flipDialog";
import { openStitchDialog } from "../stitchDialog";
import { openMaterialTestDialog } from "../materialTestDialog";
import { confirmDialog } from "../modal";
import { toast } from "../toast";
import { nextId } from "../../model/ids";
import { timeStamp } from "../../cam/exportName";
import { generateGCode, type GCodeOptions } from "../../cam/gcode";

export interface CamWorkflowContext {
  doc: CADDocument;
  pushHistory?: () => void;
  renderOps: () => void;
}

export async function toolpathsFromLayersWorkflow(ctx: CamWorkflowContext): Promise<void> {
  const { doc, pushHistory, renderOps } = ctx;
  const { operations, skipped } = buildJobFromLayers(doc);

  if (operations.length === 0) {
    const why = skipped.length
      ? skipped.map((s: { layer: string; why: string }) => `“${s.layer}” — ${s.why}`).join("; ")
      : "no layer has a job type yet";
    toast(`Nothing to build: ${why}. Set one with ⚡ in the Layers panel.`, 4200);
    return;
  }

  if (doc.operations.length > 0) {
    const ok = await confirmDialog({
      title: "Rebuild toolpaths from layers?",
      message:
        `This replaces the ${doc.operations.length} existing toolpath` +
        `${doc.operations.length > 1 ? "s" : ""} with ${operations.length} built from ` +
        `your layers (${operations.map((o: CAMOperation) => o.name).join(", ")}).\n\n` +
        "Any settings you changed on the existing toolpaths will be lost. Undo restores them.",
      confirmLabel: "Rebuild",
      danger: true,
    });
    if (!ok) return;
  }

  pushHistory?.();
  doc.operations = operations;
  doc.emitChange();
  renderOps();

  const note = skipped.length
    ? ` (skipped ${skipped.map((s: { layer: string; why: string }) => `“${s.layer}”: ${s.why}`).join("; ")})`
    : "";
  toast(
    `Built ${operations.length} toolpath${operations.length > 1 ? "s" : ""} from layers${note}.`,
    skipped.length ? 4200 : 2600,
  );
}

export function runMaterialTestWorkflow(ctx: CamWorkflowContext): void {
  const { doc, pushHistory, renderOps } = ctx;
  openMaterialTestDialog((cfg) => {
    // Place the grid so it (and its left/bottom labels) sit in positive space.
    const ts = Math.max(2, Math.min(cfg.cellSize * 0.4, 6));
    const origin = { x: ts * 3.2 + 5, y: ts + cfg.cellSize * 0.15 + 5 };
    const { entities, operations } = generateMaterialTest({ ...cfg, origin });
    if (entities.length === 0) return;

    pushHistory?.();
    for (const e of entities) {
      e.layerId = doc.activeLayerId;
      doc.entities.push(e);
    }
    doc.groups.push({
      id: nextId("group"),
      name: "Material Test",
      entityIds: entities.map((e) => e.id),
    });
    for (const op of operations) doc.operations.push(op);
    doc.emitChange();
    renderOps();
  });
}

export function openFlipWorkflow(
  ctx: CamWorkflowContext,
  onFlipPreview?: (p: FlipPreview | null) => void,
): void {
  const { doc, pushHistory, renderOps } = ctx;
  if (doc.machineKind !== "mill") {
    toast("Two-sided machining is for flat (non-rotary) milling jobs.");
    return;
  }
  openFlipDialog({
    doc,
    pushHistory,
    onPreview: (p) => onFlipPreview?.(p),
    onDone: () => renderOps(),
  });
}

export function openStitchWorkflow(
  doc: CADDocument,
  gcodeOpts: GCodeOptions,
  projectName: string,
  onStitchPreview?: (p: StitchPreview | null) => void,
): void {
  if (doc.operations.length === 0) {
    toast("No toolpaths to tile — add some first.");
    return;
  }
  if (doc.machineKind !== "mill") {
    toast("Stitch tiling is for flat (non-rotary) milling jobs.");
    return;
  }
  const gcode = generateGCode(doc.operations, doc, gcodeOpts);
  openStitchDialog({
    gcode,
    doc,
    baseName: `${projectName}_tiles_${timeStamp()}`,
    onPreview: (p) => onStitchPreview?.(p),
  });
}
