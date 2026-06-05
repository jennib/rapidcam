import { CADDocument } from "./src/model/document";
import { RectEntity } from "./src/model/entities";
import { DimensionTool } from "./src/tools/dimensionTool";

const doc = new CADDocument({width: 500, height: 500});
const r1 = new RectEntity({x: 0, y: 0}, {x: 100, y: 100}, "r1");
const r2 = new RectEntity({x: 150, y: 0}, {x: 250, y: 100}, "r2");
doc.add(r1);
doc.add(r2);

const tool = new DimensionTool();

const ctx = {
  doc,
  view: { scale: 1, toWorldLen: (px) => px, worldToScreen: (p) => p },
  pushHistory: () => {},
  requestRender: () => {},
  solve: () => {},
  openDimEditor: () => {},
  currentDof: () => 1
} as any;

// Click right edge of left rectangle (x=100, y=50)
tool.onPointerDown({ button: 0, worldRaw: {x: 100, y: 50}, world: {x: 100, y: 50}, screen: {x: 100, y: 50} } as any, ctx);

console.log("Phase after click 1:", tool["phase"]);
console.log("p1:", tool["p1"]);
console.log("p2:", tool["p2"]);

// Click left edge of right rectangle (x=150, y=50)
tool.onPointerDown({ button: 0, worldRaw: {x: 150, y: 50}, world: {x: 150, y: 50}, screen: {x: 150, y: 50} } as any, ctx);

console.log("Phase after click 2:", tool["phase"]);
console.log("p1:", tool["p1"]);
console.log("p2:", tool["p2"]);

