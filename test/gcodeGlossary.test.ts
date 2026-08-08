/**
 * Drift guard for cam/gcodeGlossary, plus behaviour tests for the block checks.
 *
 * The guard is the reason this file exists. The glossary is a table of facts
 * about what RapidCAM's generators emit, written by hand beside generators that
 * change — precisely the shape of defect this codebase keeps producing (one fact
 * written twice, nothing making the copies agree). So rather than trusting the
 * `emitted` flags, this posts REAL programs through every post-processor the app
 * offers and compares what actually came out against what the glossary claims.
 *
 * It asserts in BOTH directions, because either alone is satisfiable by doing
 * nothing:
 *   - forward: every code the generators emit has a glossary entry, so adding an
 *     M-code to a post without documenting it fails here;
 *   - reverse: every code flagged `emitted` really is emitted, so a flag left
 *     behind when a generator stops using a code also fails here.
 *
 * And the corpus itself is asserted to be non-trivial first — "every emitted code
 * is documented" passes vacuously over an empty corpus, which is the exact trap
 * recorded in test/… elsewhere in this suite (a negative assertion needs a
 * positive control).
 */

import { describe, test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { ArcEntity, BezierEntity, CircleEntity, RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import { generateLaserGCode } from "../src/cam/lasergcode";
import { defaultRotarySettings, generateRotaryProgram } from "../src/cam/klein";
import type { CAMOperation } from "../src/cam/types";
import {
  annotate,
  blocksFor,
  checkBlock,
  dialectOf,
  EMITTED_BY_GENERATOR,
  GLOSSARY,
  lexLine,
  lookup,
  BLOCK_CATALOGUE,
  DIALECTS,
} from "../src/cam/gcodeGlossary";

// --- corpus ------------------------------------------------------------------

function mkOp(over: Partial<CAMOperation> & { id: string; entityIds: string[] }): CAMOperation {
  return {
    name: over.id,
    type: "profile",
    side: "outside",
    toolType: "end-mill",
    toolNumber: 1,
    diameter: 3,
    feedrate: 600,
    plungeRate: 200,
    spindleSpeed: 12000,
    safeZ: 5,
    depth: -4,
    stepdown: 2,
    stepover: 0.4,
    ...over,
  };
}

interface Program {
  label: string;
  gcode: string;
}

/**
 * Mill programs across both mill posts. The op mix is chosen to reach every
 * motion word the mill generator can produce, not to be a realistic job:
 * a circle profile for arcs (G2), an ArcEntity engrave for the CCW arc (G3 —
 * see gcode.ts engraveArc), a Bezier engrave for the LinuxCNC spline (G5), and
 * mist + flood ops for M7/M8/M9.
 */
function millPrograms(): Program[] {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.stockThickness = 10;
  const circle = doc.add(new CircleEntity({ x: 60, y: 60 }, 15));
  const rect = doc.add(new RectEntity({ x: 100, y: 100 }, { x: 60, y: 40 }));
  const arc = doc.add(new ArcEntity({ x: 60, y: 150 }, 20, 0, Math.PI));
  const bez = doc.add(
    new BezierEntity({ x: 20, y: 20 }, { x: 50, y: 60 }, { x: 90, y: 10 }, { x: 130, y: 45 }),
  );
  const ops = [
    mkOp({ id: "profile", entityIds: [circle.id], coolant: "flood" }),
    mkOp({ id: "pocket", entityIds: [rect.id], type: "pocket", coolant: "mist", toolNumber: 2 }),
    mkOp({ id: "drill", entityIds: [circle.id], type: "drill", toolType: "drill", toolNumber: 3 }),
    mkOp({ id: "arc-engrave", entityIds: [arc.id], type: "engrave", toolNumber: 4 }),
    mkOp({ id: "bezier-engrave", entityIds: [bez.id], type: "engrave", toolNumber: 5 }),
  ];
  return ["grbl", "linuxcnc"].map((postProcessor) => ({
    label: `mill/${postProcessor}`,
    gcode: generateGCode(ops, doc, { postProcessor, coolantSupported: true }),
  }));
}

/** A rotary mill program — the only source of G93/G94 (cam/klein.ts). */
function rotaryProgram(): Program {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.machineKind = "mill-rotary";
  doc.stockThickness = 5;
  doc.rotary = defaultRotarySettings(doc);
  doc.canvas.width = Math.PI * doc.rotary.diameter;
  const circle = doc.add(new CircleEntity({ x: 30, y: 60 }, 10));
  doc.operations = [mkOp({ id: "rotary", entityIds: [circle.id] })];
  return {
    label: "mill-rotary/linuxcnc",
    gcode: generateRotaryProgram(doc, { postProcessor: "linuxcnc" }).program,
  };
}

/** Every laser head in the registry — M3 vs M4 vs inline power all differ. */
function laserPrograms(): Program[] {
  const doc = new CADDocument({ width: 200, height: 200 });
  doc.machineKind = "laser";
  const circle = doc.add(new CircleEntity({ x: 60, y: 60 }, 15));
  const ops = [mkOp({ id: "cut", entityIds: [circle.id], airAssist: true })];
  return ["grbl-dynamic", "grbl-constant", "marlin", "smoothie", "linuxcnc-laser"].map(
    (postProcessor) => ({
      label: `laser/${postProcessor}`,
      gcode: generateLaserGCode(ops, doc, { postProcessor }),
    }),
  );
}

const CORPUS: Program[] = [...millPrograms(), rotaryProgram(), ...laserPrograms()];

/** Every distinct G/M code appearing anywhere in a program. */
function codesIn(gcode: string): Set<string> {
  const found = new Set<string>();
  for (const line of gcode.split("\n")) {
    for (const word of lexLine(line)) if (word.code) found.add(word.code);
  }
  return found;
}

const OBSERVED = new Set<string>();
for (const p of CORPUS) for (const c of codesIn(p.gcode)) OBSERVED.add(c);

// --- the drift guard ---------------------------------------------------------

describe("glossary drift guard", () => {
  // The positive control. Without this, every assertion below is satisfiable by
  // a corpus that generates nothing at all.
  test("the corpus is real: every program posts actual motion", () => {
    expect(CORPUS.length).toBe(8);
    for (const { label, gcode } of CORPUS) {
      expect(gcode.split("\n").length, `${label} is too short to be a real program`).toBeGreaterThan(
        20,
      );
      expect(gcode, `${label} emits no motion`).toMatch(/^G[01]\b/m);
      expect(gcode, `${label} does not end a program`).toContain("M30");
    }
  });

  test("the corpus reaches every motion word the generators can emit", () => {
    // Named explicitly so that losing corpus coverage (e.g. an op type that
    // stops emitting arcs) fails loudly here rather than silently weakening the
    // two set comparisons below.
    for (const code of ["G0", "G1", "G2", "G3", "G5", "G93", "G94", "M3", "M4", "M7"]) {
      expect(OBSERVED.has(code), `corpus no longer covers ${code}`).toBe(true);
    }
  });

  test("forward: every code the generators emit is documented", () => {
    const undocumented = [...OBSERVED].filter((c) => !lookup(c)).sort();
    expect(
      undocumented,
      `these codes are emitted but missing from GLOSSARY in cam/gcodeGlossary.ts`,
    ).toEqual([]);
  });

  test("reverse: every code flagged `emitted` really is emitted", () => {
    const stale = [...EMITTED_BY_GENERATOR].filter((c) => !OBSERVED.has(c)).sort();
    expect(
      stale,
      `these carry emitted:true but no post produces them — drop the flag or extend the corpus`,
    ).toEqual([]);
  });

  test("EMITTED_BY_GENERATOR matches what the posts actually write", () => {
    expect([...EMITTED_BY_GENERATOR].sort()).toEqual([...OBSERVED].sort());
  });

  test("every emitted code is marked emitted (not merely present in the table)", () => {
    const unflagged = [...OBSERVED].filter((c) => lookup(c) && !lookup(c)?.emitted).sort();
    expect(unflagged, "documented but missing `emitted: true`").toEqual([]);
  });
});

// --- table integrity ---------------------------------------------------------

describe("glossary table integrity", () => {
  test("no duplicate codes", () => {
    const codes = GLOSSARY.map((e) => e.code);
    expect(codes.length).toBe(new Set(codes).size);
  });

  test("every entry covers every dialect", () => {
    for (const entry of GLOSSARY) {
      for (const d of DIALECTS) {
        expect(entry.support[d], `${entry.code} has no support level for ${d}`).toBeDefined();
      }
    }
  });

  test("divergence notes name a real dialect and say something", () => {
    const known = new Set<string>(DIALECTS);
    for (const entry of GLOSSARY) {
      for (const [d, note] of Object.entries(entry.divergence ?? {})) {
        expect(known.has(d), `${entry.code} has a divergence note for unknown dialect "${d}"`).toBe(
          true,
        );
        expect((note ?? "").length, `${entry.code}/${d} divergence note is empty`).toBeGreaterThan(
          10,
        );
      }
    }
  });

  test("a caution never singles out ONE controller — that belongs in divergence", () => {
    // Found by looking at the real dialog: G5/G43/G64/G81 carried "GRBL rejects
    // this" as a universal caution, so a LinuxCNC user got a ⚠ on codes their
    // machine runs perfectly. `caution` renders on every controller, so it has to
    // be true on every one.
    //
    // Naming SEVERAL controllers is the opposite case and must stay allowed: G28
    // means different things on GRBL/LinuxCNC than on Marlin/Smoothie, and saying
    // so plainly — in one sentence covering all four — is the entry's whole
    // reason to exist. So the rule is about singling one out, not about mentioning.
    const names = ["GRBL", "LinuxCNC", "Marlin", "Smoothie"];
    for (const entry of GLOSSARY) {
      if (!entry.caution) continue;
      const named = names.filter((n) => entry.caution?.includes(n));
      expect(
        named.length,
        `${entry.code} caution singles out ${named[0]} but renders on every controller — ` +
          `move it to divergence.${named[0]?.toLowerCase()}`,
      ).not.toBe(1);
    }
  });

  test("every `no` claim is one we can source", () => {
    // `"no"` renders as an error, and a false error is the worst output this
    // module has — it teaches people to click through pre-flight. So the set is
    // pinned here rather than left to whoever edits the table next.
    //
    // What earns a "no": GRBL and LinuxCNC publish curated lists of the codes
    // they accept, so an absence is a fact. Marlin and Smoothieware are printer
    // firmwares whose CNC features are build-flag or config gated, so their
    // absences are claims about someone else's binary — those get "optional".
    // The one exception is M98: none of the four have subprograms (LinuxCNC uses
    // O-codes), and that is not a build option anywhere.
    //
    // Sources: Grbl v1.1 command list (gnea/grbl wiki) and smoothieware.org's
    // supported-g-codes page.
    const claims = GLOSSARY.flatMap((e) =>
      DIALECTS.filter((d) => e.support[d] === "no").map((d) => `${e.code}/${d}`),
    ).sort();
    expect(claims).toEqual(
      [
        // Absent from Grbl v1.1's supported set.
        "G43/grbl",
        "G5/grbl",
        "G64/grbl",
        "G81/grbl",
        // No controller of ours has subprograms.
        "M98/grbl",
        "M98/linuxcnc",
        "M98/marlin",
        "M98/smoothie",
      ].sort(),
    );
  });

  test("Marlin and Smoothie are never told a CNC code is unsupported", () => {
    // The positive control for the rule above: their absences are unverifiable,
    // so they must read as "your build may not have this", not as an error.
    for (const entry of GLOSSARY) {
      for (const d of ["marlin", "smoothie"] as const) {
        if (entry.code === "M98") continue;
        expect(entry.support[d], `${entry.code} tells ${d} it is unsupported`).not.toBe("no");
      }
    }
  });

  test("dialect resolution covers every post id the app can store", () => {
    expect(dialectOf("grbl")).toBe("grbl");
    expect(dialectOf("linuxcnc")).toBe("linuxcnc");
    expect(dialectOf("grbl-dynamic")).toBe("grbl");
    expect(dialectOf("grbl-constant")).toBe("grbl");
    expect(dialectOf("linuxcnc-laser")).toBe("linuxcnc");
    expect(dialectOf("marlin")).toBe("marlin");
    expect(dialectOf("smoothie")).toBe("smoothie");
    // Unknown / absent falls back to GRBL, matching laserposts/index.getLaserPost.
    expect(dialectOf(undefined)).toBe("grbl");
    expect(dialectOf("something-else")).toBe("grbl");
  });
});

// --- lexer -------------------------------------------------------------------

describe("lexer", () => {
  test("normalises leading zeros but keeps meaningful decimals", () => {
    expect(lexLine("G01 X10")[0].code).toBe("G1");
    expect(lexLine("M03 S1000")[0].code).toBe("M3");
    expect(lexLine("G38.2 Z-10")[0].code).toBe("G38.2");
    expect(lexLine("G43.1 H1")[0].code).toBe("G43.1");
  });

  test("ignores comments in both syntaxes", () => {
    expect(lexLine("; G20 in a comment")).toEqual([]);
    expect(lexLine("(G20 in parens) G21")[0].code).toBe("G21");
    expect(lexLine("G54 ; work offset").map((w) => w.code)).toEqual(["G54"]);
  });

  test("reads every word on a multi-word line", () => {
    expect(lexLine("G53 G0 X0 Y0").map((w) => w.letter)).toEqual(["G", "G", "X", "Y"]);
  });
});

// --- annotation --------------------------------------------------------------

describe("annotate", () => {
  test("G28 diverges across controllers — the reason this module exists", () => {
    const grbl = annotate("G28", "grbl")[0];
    const marlin = annotate("G28", "marlin")[0];
    expect(grbl.note).toMatch(/does NOT run the homing cycle/i);
    expect(marlin.note).toMatch(/auto-home/i);
    expect(grbl.note).not.toBe(marlin.note);
  });

  test("a tool-table offset is rejected by GRBL but fine on LinuxCNC", () => {
    expect(annotate("G43 H1", "grbl")[0].status).toBe("unsupported");
    expect(annotate("G43 H1", "linuxcnc")[0].status).not.toBe("unsupported");
  });

  test("classifies blank and comment-only lines without inventing meaning", () => {
    const lines = annotate("\n; just a note\nG54", "grbl");
    expect(lines.map((l) => l.status)).toEqual(["blank", "comment", "ok"]);
  });

  test("a bare modal value is explained, not flagged", () => {
    const line = annotate("F1000", "grbl")[0];
    expect(line.status).toBe("ok");
    expect(line.summary).toMatch(/without commanding a move/i);
  });

  test("an unknown code says so rather than guessing", () => {
    const line = annotate("G76 P1", "grbl")[0];
    expect(line.status).toBe("unknown");
    expect(line.note).toMatch(/not in RapidCAM's reference/i);
  });
});

// --- block checks ------------------------------------------------------------

const start = { slot: "start" } as const;

describe("checkBlock", () => {
  test("inches in a custom block is an error, not a warning", () => {
    const findings = checkBlock("G20", { ...start, postId: "grbl" });
    const f = findings.find((x) => x.code === "inches-in-custom-block");
    expect(f?.severity).toBe("error");
    expect(f?.message).toMatch(/25\.4/);
  });

  test("ending the program early is an error", () => {
    expect(checkBlock("M30", { ...start, postId: "grbl" })[0].code).toBe("premature-end");
    expect(checkBlock("M2", { ...start, postId: "grbl" })[0].code).toBe("premature-end");
  });

  test("a code the selected controller rejects is an error", () => {
    expect(checkBlock("G64 P0.01", { ...start, postId: "grbl" }).map((f) => f.code)).toContain(
      "unsupported-code",
    );
    // Positive control: the same line is clean on the controller that has it.
    expect(checkBlock("G64 P0.01", { ...start, postId: "linuxcnc" })).toEqual([]);
  });

  test("run-together words are flagged because pre-flight cannot read them", () => {
    const findings = checkBlock("G0X10Y20", { ...start, postId: "grbl" });
    expect(findings.map((f) => f.code)).toContain("no-space-words");
    // Positive control: properly spaced lines must NOT trip it, or the check is noise.
    expect(checkBlock("G0 X10 Y20", { ...start, postId: "grbl" })).toEqual([]);
    expect(checkBlock("G53 G0 Z-5", { ...start, postId: "grbl" })).toEqual([]);
    expect(checkBlock("G4 P0.5", { ...start, postId: "grbl" })).toEqual([]);
  });

  test("selecting two work offsets warns that only the last one counts", () => {
    const f = checkBlock("G54\nG55", { ...start, postId: "grbl" }).find(
      (x) => x.code === "duplicate-work-offset",
    );
    expect(f?.severity).toBe("warning");
    expect(checkBlock("G54", { ...start, postId: "grbl" })).toEqual([]);
  });

  test("duplicating a header modal warns; motion words do not", () => {
    expect(checkBlock("G21", { ...start, postId: "grbl" })[0].code).toBe("already-emitted");
    // A park block is made of G0 moves — warning on those would flag the
    // catalogue's own suggestions.
    expect(checkBlock("G0 X0 Y0", { slot: "end", postId: "grbl" })).toEqual([]);
  });

  test("driving the spindle from a custom block warns", () => {
    expect(checkBlock("M3 S12000", { ...start, postId: "grbl" })[0].code).toBe(
      "spindle-in-custom-block",
    );
  });

  test("coolant conflict fires only when the post is already driving coolant", () => {
    expect(
      checkBlock("M8", { ...start, postId: "grbl", coolantEnabled: true }).map((f) => f.code),
    ).toEqual(["coolant-conflict"]);
    expect(checkBlock("M8", { ...start, postId: "grbl", coolantEnabled: false })).toEqual([]);
  });


  test("leaving incremental mode active warns", () => {
    expect(checkBlock("G91", { ...start, postId: "grbl" })[0].code).toBe(
      "incremental-left-active",
    );
  });

  test("errors sort before warnings", () => {
    const findings = checkBlock("$H\nG20", { ...start, postId: "grbl" });
    expect(findings[0].severity).toBe("error");
  });
});

// --- catalogue ---------------------------------------------------------------

describe("block catalogue", () => {
  // The bug this caught during development: the duplicate-code check fired on
  // `emitted` codes generally, which includes G0/G1 — so the park block, the
  // catalogue's own suggestion, warned about itself.
  test("no catalogue entry trips its own checks", () => {
    for (const postId of ["grbl", "linuxcnc", "marlin", "smoothie"]) {
      for (const slot of ["start", "end"] as const) {
        for (const machine of ["mill", "laser"] as const) {
          for (const { option, lines } of blocksFor(slot, machine, postId)) {
            const findings = checkBlock(lines.join("\n"), {
              postId,
              slot,
              coolantEnabled: false,
            });
            expect(findings, `${postId}/${slot}/${machine}/${option.id}`).toEqual([]);
          }
        }
      }
    }
  });

  test("homing is offered per controller, and withheld where there is none", () => {
    const homeFor = (postId: string) =>
      blocksFor("start", "mill", postId).find((b) => b.option.id === "home");
    expect(homeFor("grbl")?.lines[0]).toMatch(/^\$H\b/);
    expect(homeFor("marlin")?.lines[0]).toMatch(/^G28\b/);
    expect(homeFor("smoothie")?.lines[0]).toMatch(/^G28\b/);
    // LinuxCNC has no in-program homing form — saying nothing beats emitting a
    // G28 that means something else entirely.
    expect(homeFor("linuxcnc")).toBeUndefined();
  });

  test("blocks the controller cannot express are withheld, not mangled", () => {
    // Marlin has no G53 without a build flag, so no machine-coordinate parking.
    const ids = blocksFor("end", "mill", "marlin").map((b) => b.option.id);
    expect(ids).not.toContain("park-machine");
    expect(blocksFor("end", "mill", "grbl").map((b) => b.option.id)).toContain("park-machine");
  });

  test("mill-only blocks stay out of a laser catalogue", () => {
    expect(blocksFor("start", "laser", "grbl").map((b) => b.option.id)).not.toContain("safe-z");
    expect(blocksFor("start", "mill", "grbl").map((b) => b.option.id)).toContain("safe-z");
  });

  test("the catalogue never offers a code the post already emits once per program", () => {
    // Setup modals and program end are the generator's job; offering them would
    // double-emit. (Motion and accessory outputs are legitimately re-used.)
    const forbidden = new Set(["G17", "G21", "G90", "G93", "G94", "M30", "M2"]);
    for (const option of BLOCK_CATALOGUE) {
      for (const d of DIALECTS) {
        for (const line of option.lines(d) ?? []) {
          for (const w of lexLine(line)) {
            expect(
              w.code && forbidden.has(w.code),
              `${option.id} offers ${w.code}, which the post already emits`,
            ).not.toBe(true);
          }
        }
      }
    }
  });

  test("every catalogue entry is reachable from at least one controller", () => {
    for (const option of BLOCK_CATALOGUE) {
      const reachable = DIALECTS.some((d) => option.lines(d) !== null);
      expect(reachable, `${option.id} is offered to nobody`).toBe(true);
    }
  });
});
