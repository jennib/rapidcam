import { applyRotate } from "./src/core/transform";
import { RectEntity } from "./src/model/entities";

const r = new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }, "test1");
const entities = [r];

applyRotate(entities, 5, 5, Math.PI / 4, (oldE, newE) => {
    const idx = entities.findIndex(x => x.id === oldE.id);
    if (idx >= 0) entities[idx] = newE;
});

console.log(entities[0].type);
console.log(JSON.stringify((entities[0] as any).points, null, 2));
