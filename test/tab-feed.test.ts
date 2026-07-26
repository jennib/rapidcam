/**
 * Field-test regression (2026-07-12): a tab's Z lift/descend is fed at
 * plungeRate, and the modal F used to stay there — so on tabbed passes the
 * whole rest of the lap silently cut at plunge speed (≈4× slower than asked).
 * The generator must re-issue the cutting feed on the first lateral move after
 * every plunge-rate Z move. Also pins the ASCII-comment guarantee.
 */

import { describe, expect, it } from "vitest";
import { generateGCode } from "../src/cam/gcode";
import { DEFAULTS } from "../src/cam/types";
import type { CAMOperation } from "../src/cam/types";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";

function tabbedProfileDoc(): { doc: CADDocument; op: CAMOperation } {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.entities.push(new RectEntity({ x: 50, y: 50 }, { x: 150, y: 130 }, "rect1"));
  const op: CAMOperation = {
    id: "op1",
    name: "Profile",
    type: "profile",
    entityIds: ["rect1"],
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 6,
    feedrate: 900,
    plungeRate: 250,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -10,
    stepdown: 4,
    stepover: DEFAULTS.stepover,
    coolant: "off",
    tabs: { enabled: true, count: 4, width: 6, height: 3 },
  } as CAMOperation;
  doc.operations.push(op);
  return { doc, op };
}

describe("tabbed profile feed restoration", () => {
  it("every lateral cutting move runs at the cutting feed, never the plunge rate", () => {
    const { doc, op } = tabbedProfileDoc();
    const gcode = generateGCode([op], doc);

    let modalF = 0;
    const offenders: string[] = [];
    for (const raw of gcode.split("\n")) {
      const line = raw.split(";")[0].trim();
      if (!/^G[123]\b/.test(line)) continue;
      const fWord = line.match(/F([\d.]+)/);
      if (fWord) modalF = Number(fWord[1]);
      const lateral = /[XY]-?[\d.]+/.test(line);
      if (lateral && modalF !== op.feedrate) offenders.push(`${raw} (modal F${modalF})`);
    }
    expect(offenders).toEqual([]);
    // Sanity: the program really does contain tab lifts at plunge rate.
    expect(gcode).toContain(`F${op.plungeRate}`);
  });

  it("emits ASCII-only G-code (comments included)", () => {
    const { doc, op } = tabbedProfileDoc();
    const gcode = generateGCode([op], doc);
    expect(gcode).toMatch(/^G1 /m); // guard: an empty program is trivially ASCII
    const nonAscii = gcode.match(/[^\x20-\x7E\n\r]/g);
    expect(nonAscii).toBeNull();
  });
});
