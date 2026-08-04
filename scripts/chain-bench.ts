/**
 * Coupled-chain solve cost, in Node (no browser) — the case partitioning cannot
 * help, because the chain is one connected component by construction.
 *
 * Run: npx tsx scripts/chain-bench.ts
 */
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve } from "../src/solver/solver";

function chain(n: number): CADDocument {
  const doc = new CADDocument({ width: n * 8 + 40, height: 120 }, "mm");
  const lines: LineEntity[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 8;
    lines.push(
      doc.add(
        new LineEntity({ x, y: 20 + (i % 2) * 6 }, { x: x + 8, y: 20 + ((i + 1) % 2) * 6 }),
      ),
    );
    if (i > 0)
      doc.addConstraint(
        makeConstraint("coincident", {
          points: [
            { entityId: lines[i - 1].id, key: "b" },
            { entityId: lines[i].id, key: "a" },
          ],
        }),
      );
  }
  doc.addConstraint(
    makeConstraint("fixedPoint", { points: [{ entityId: lines[0].id, key: "a" }], params: [0, 20] }),
  );
  return doc;
}

for (const n of [25, 50, 100, 200, 400]) {
  const doc = chain(n);
  const first = doc.entities.find((e) => e instanceof LineEntity) as LineEntity;
  first.a.x += 0.5;
  const t0 = performance.now();
  const res = solve(doc);
  const ms = performance.now() - t0;
  console.log(
    `CHAIN ${String(n).padStart(3)} vars=${String(res.variables).padStart(4)} eqs=${String(res.equations).padStart(4)} ${ms.toFixed(0)}ms converged=${res.converged}`,
  );
}
