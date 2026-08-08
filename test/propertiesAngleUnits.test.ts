// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, TextEntity, RasterImageEntity } from "../src/model/entities";
import { PropertiesBar } from "../src/ui/propertiesBar";
import { applyRotate } from "../src/core/transform";

/**
 * Every angle field in the properties bar reads in degrees while the entity
 * stores radians, and the conversion has to happen exactly once.
 *
 * It was happening twice. `bindingRow` takes the value in the STORED unit and
 * divides by `scale` to display it — but the arc's Start/End and the image and
 * text Angle rows all passed a value they had already converted to degrees AND
 * supplied the scale, so the field showed the angle 180/π ≈ 57.3 times too
 * large. An arc from 26.6° to 104.0° read as "Start 1522.1, End 5960.8".
 *
 * Start angles are deliberately non-zero here: a fresh arc starts at 0, and zero
 * survives any number of multiplications, which is exactly why this went
 * unnoticed on the shapes people draw first.
 */

function panel(doc: CADDocument): Record<string, string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  new PropertiesBar(
    host,
    doc,
    () => {},
    () => {},
    () => {},
    () => true,
  );
  const out: Record<string, string> = {};
  for (const row of host.querySelectorAll(".props-row")) {
    const label = row.querySelector("span")?.textContent ?? "";
    const input = row.querySelector("input");
    if (label && input) out[label] = (input as HTMLInputElement).value;
  }
  return out;
}

const DEG = Math.PI / 180;

describe("angle fields convert exactly once", () => {
  test("an arc reads its start and end in degrees", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const arc = doc.add(new ArcEntity({ x: 150, y: 150 }, 28.238, 30 * DEG, 105 * DEG));
    arc.selected = true;
    const p = panel(doc);
    expect(p.Start).toBe("30.0");
    expect(p.End).toBe("105.0");
    // Sweep was always right, and is the control that proves the others wrong
    // rather than the panel simply being broken.
    expect(p.Sweep).toBe("75.0");
  });

  test("an arc's three angle fields agree with each other", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const arc = doc.add(new ArcEntity({ x: 150, y: 150 }, 20, 30 * DEG, 105 * DEG));
    arc.selected = true;
    const p = panel(doc);
    const start = Number.parseFloat(p.Start);
    const end = Number.parseFloat(p.End);
    const sweep = Number.parseFloat(p.Sweep);
    expect(end - start).toBeCloseTo(sweep, 1);
  });

  test("text reads its angle in degrees", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const t = doc.add(new TextEntity("hello", "sans", 12, { x: 50, y: 50 }));
    t.angle = 45 * DEG;
    t.selected = true;
    expect(panel(doc).Angle).toBe("45.0");
  });

  test("an image reads its angle in degrees", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const img = doc.add(
      new RasterImageEntity(
        "data:image/png;base64,iVBORw0KGgo=",
        { x: 50, y: 50 },
        40,
        30,
      ),
    );
    img.angle = 45 * DEG;
    img.selected = true;
    expect(panel(doc).Angle).toBe("45.0");
  });

  test("a full turn does not read as tens of thousands of degrees", () => {
    // The symptom that made this visible: any angle at all looked enormous.
    const doc = new CADDocument({ width: 300, height: 300 });
    const arc = doc.add(new ArcEntity({ x: 150, y: 150 }, 20, 0, 359 * DEG));
    arc.selected = true;
    const p = panel(doc);
    expect(Number.parseFloat(p.End)).toBeLessThan(360.5);
  });
});

describe("rotation does not accumulate angles without bound", () => {
  test("an arc rotated many times still reports an angle in range", () => {
    // `+=` with no normalisation stored 3.3 turns after twenty 60-degree
    // rotations, so the panel read 1200 degrees for an arc sitting at 120.
    const doc = new CADDocument({ width: 300, height: 300 });
    const arc = doc.add(new ArcEntity({ x: 150, y: 150 }, 20, 0, 75 * DEG));
    const spanBefore = arc.endAngle - arc.startAngle;
    for (let i = 0; i < 20; i++) applyRotate([arc], 150, 150, 60 * DEG);
    expect(Math.abs(arc.startAngle)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(Math.abs(arc.endAngle)).toBeLessThanOrEqual(Math.PI + 1e-9);
    // The arc itself is unchanged: the span is what every consumer reads, and
    // normalising each end independently must not disturb it.
    const TAU = Math.PI * 2;
    const spanAfter = (((arc.endAngle - arc.startAngle) % TAU) + TAU) % TAU;
    expect(spanAfter).toBeCloseTo(((spanBefore % TAU) + TAU) % TAU, 9);
  });

  test("text and image angles stay in range too", () => {
    const doc = new CADDocument({ width: 300, height: 300 });
    const t = doc.add(new TextEntity("hi", "sans", 12, { x: 50, y: 50 }));
    const img = doc.add(
      new RasterImageEntity("data:image/png;base64,iVBORw0KGgo=", { x: 50, y: 50 }, 40, 30),
    );
    for (let i = 0; i < 20; i++) applyRotate([t, img], 50, 50, 60 * DEG);
    expect(Math.abs(t.angle)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(Math.abs(img.angle)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});
