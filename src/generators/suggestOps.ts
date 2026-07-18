/**
 * Turn a sketch's {@link OpSuggestion}s into real CAM operations at insert
 * time — the bridge that carries a generator's CAM intent ("these grooves are
 * pockets at t/2") into the document instead of dropping it on the floor.
 *
 * Mirrors cam/materialTest.ts's programmatic-op precedent: build `CAMOperation`
 * literals from `DEFAULTS` (no tool assigned — inline fields are authoritative,
 * see cam/types.ts `resolveOpTool`), and let the caller commit geometry + ops
 * in one history step. Machine-kind aware: on a laser document, profile kinds
 * become beam profile cuts (no spindle/diameter, laser power/passes) and pocket
 * suggestions are skipped entirely (no laser pocket op exists); "mill-rotary"
 * behaves like "mill" (the rotary wrap is applied at export).
 *
 * Suggested ops are created ONCE, on insert. After that they are the user's:
 * regeneration keeps their entityIds valid (id-stable reconcile) but never
 * re-creates or re-tunes them.
 */

import type { CADDocument } from "../model/document";
import { type CAMOperation, DEFAULTS } from "../cam/types";
import { refsFromSeeds, seedsFromEntityIds } from "../cam/regions";
import { nextId } from "../model/ids";
import type { OpSuggestion, Sketch } from "./sketch";

/** Depth in mm: explicit value, or "through" = the full stock thickness (the
 *  same `-doc.stockThickness` convention as the cam bar's "⊥ stock" button). */
function resolveDepth(doc: CADDocument, depth: number | "through"): number {
  return depth === "through" ? -doc.stockThickness : depth;
}

function baseOp(doc: CADDocument, spec: OpSuggestion): CAMOperation {
  return {
    id: nextId("cam"),
    name: spec.name,
    type: "profile",
    entityIds: spec.targets.map((t) => t.id),
    side: spec.kind === "profile-inside" ? "inside" : "outside",
    toolType: DEFAULTS.toolType,
    toolNumber: DEFAULTS.toolNumber,
    diameter: spec.toolDiameter ?? DEFAULTS.diameter,
    feedrate: DEFAULTS.feedrate,
    plungeRate: DEFAULTS.plungeRate,
    spindleSpeed: DEFAULTS.spindleSpeed,
    safeZ: DEFAULTS.safeZ,
    depth: resolveDepth(doc, spec.depth),
    stepdown: spec.stepdown ?? DEFAULTS.stepdown,
    stepover: DEFAULTS.stepover,
  };
}

/**
 * Build the operations for every suggestion in `sketch`, honouring the
 * document's machine kind. Must run AFTER the sketch's entities are committed
 * to `doc` — pocket regions are seeded against the live document geometry.
 */
export function buildSuggestedOps(doc: CADDocument, sketch: Sketch): CAMOperation[] {
  const isLaser = doc.machineKind === "laser";
  const ops: CAMOperation[] = [];

  for (const spec of sketch.opSuggestions) {
    if (isLaser) {
      // Beam machines: profiles cut with the laser fields set (materialTest
      // precedent — toolType is required but meaningless); pockets have no
      // laser equivalent and are skipped, leaving the geometry for the user.
      if (spec.kind === "pocket") continue;
      ops.push({
        ...baseOp(doc, spec),
        type: spec.kind === "engrave" ? "engrave" : "profile",
        diameter: 0,
        spindleSpeed: 0,
        laserPower: DEFAULTS.laserPower,
        laserPasses: DEFAULTS.laserPasses,
      });
      continue;
    }

    const op = baseOp(doc, spec);
    switch (spec.kind) {
      case "pocket": {
        op.type = "pocket";
        // Seed a parametric region inside each target loop (matches how the
        // cam bar stores pockets); entityIds are kept alongside as the legacy
        // fallback and for highlighting.
        const ids = new Set(op.entityIds);
        op.regions = refsFromSeeds(doc, seedsFromEntityIds(doc, ids, new Set()));
        break;
      }
      case "engrave":
        op.type = "engrave";
        break;
      default:
        op.type = "profile";
    }
    if (spec.cornerStyle && (op.type === "profile" || op.type === "pocket")) {
      op.cornerStyle = spec.cornerStyle;
    }
    ops.push(op);
  }

  return ops;
}
