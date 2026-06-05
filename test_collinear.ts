import { CADDocument } from "./src/model/document";
import { LineEntity } from "./src/model/entities";
import { solve } from "./src/solver/solver";
import { makeConstraint } from "./src/model/constraints";

const doc = new CADDocument({width: 100, height: 100});
const l1 = new LineEntity({x: 0, y: 0}, {x: 10, y: 0}, "l1");
const l2 = new LineEntity({x: 20, y: 0}, {x: 30, y: 0}, "l2");
doc.entities.push(l1, l2);
doc.addConstraint(makeConstraint("collinear", {entities: [l1.id, l2.id]}));

console.log("Before drag:");
console.log("l1:", l1.a, l1.b);
console.log("l2:", l2.a, l2.b);

// Drag l1 up by 5 units
l1.translate({x: 0, y: 5});

console.log("\nAfter translating l1 (before solve):");
console.log("l1:", l1.a, l1.b);
console.log("l2:", l2.a, l2.b);

doc.selected.push(l1);

// pinsForSelected
const pins = new Map<string, {x: number, y: number}>();
pins.set(`${l1.id}:a`, l1.a);
pins.set(`${l1.id}:b`, l1.b);

const result = solve(doc, pins);
console.log("\nSolve result:", result);
console.log("l1:", l1.a, l1.b);
console.log("l2:", l2.a, l2.b);
