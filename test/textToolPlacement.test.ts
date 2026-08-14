import { beforeAll, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFromFile } from "../src/core/fontManager";
import { CADDocument } from "../src/model/document";
import { TextEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { TextTool } from "../src/tools/textTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";

/**
 * Placing text is a FINISHED gesture.
 *
 * The tool used to stay armed after a stamp, dropping another copy on every
 * subsequent click — not what any other CAD does, and it turned a stray click
 * into a duplicate the user had to notice and delete. It now hands back to
 * Select, which also leaves the new text ready to move or align.
 *
 * `activateTool` must never be called from `cancel()`: ToolManager.activate
 * cancels the outgoing tool first, so that would recurse forever. These pin the
 * call to the paths where it is safe.
 */

let fontId: string;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

function makeCtx(doc: CADDocument) {
  const activateTool = vi.fn();
  const ctx: ToolContext = {
    doc,
    view: { scale: 1 } as ToolContext["view"],
    requestRender() {},
    solve() {},
    pushHistory() {},
    openDimEditor() {},
    currentDof: () => 0,
    openTypeToDraw() {},
    activateTool,
    closeTypeToDraw() {},
    notify() {},
    setHint() {},
    snap: new SnapEngine(),
  };
  return { ctx, activateTool };
}

/** Arm the tool the way the dialog's Apply does, without opening any DOM. */
function arm(tool: TextTool, ctx: ToolContext, text = "PEW"): void {
  (tool as unknown as Record<string, unknown>).pendingText = text;
  (tool as unknown as Record<string, unknown>).pendingFontId = fontId;
  (tool as unknown as Record<string, unknown>).pendingSizeMM = 10;
  (tool as unknown as Record<string, unknown>).pendingAngle = 0;
  tool.onPointerMove(evt({ x: 5, y: 5 }), ctx);
}

function evt(pos: { x: number; y: number }): ToolPointerEvent {
  return {
    world: pos,
    worldRaw: pos,
    screen: pos,
    snap: null,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
  };
}

function texts(doc: CADDocument): TextEntity[] {
  return doc.entities.filter((e): e is TextEntity => e instanceof TextEntity);
}

test("placing text hands back to the Select tool", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();
  arm(tool, ctx);

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);

  expect(texts(doc)).toHaveLength(1);
  expect(activateTool).toHaveBeenCalledWith("select");
});

test("the placed text is left selected, ready to move", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx } = makeCtx(doc);
  const tool = new TextTool();
  arm(tool, ctx);

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);
  expect(doc.selected.map((e) => e.id)).toEqual([texts(doc)[0].id]);
});

test("a click with nothing armed places nothing and switches nothing", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);

  expect(texts(doc)).toHaveLength(0);
  expect(activateTool).not.toHaveBeenCalled();
  // Positive control: the same tool DOES place and switch once armed, so the
  // assertion above is about the missing pending text, not a dead tool.
  arm(tool, ctx);
  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);
  expect(texts(doc)).toHaveLength(1);
  expect(activateTool).toHaveBeenCalledWith("select");
});

test("Escape while armed hands back to Select instead of stranding the tool", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();
  arm(tool, ctx);

  // Node has no KeyboardEvent and this file needs no DOM otherwise — the tool
  // only reads `.key`.
  tool.onKeyDown({ key: "Escape" } as KeyboardEvent, ctx);
  expect(activateTool).toHaveBeenCalledWith("select");
  expect(texts(doc)).toHaveLength(0);
});

test("cancel() never switches tools — that would recurse through activate()", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();
  arm(tool, ctx);

  // ToolManager.activate calls the outgoing tool's cancel BEFORE switching, so a
  // cancel that switched tools would call activate again, forever.
  tool.cancel(ctx);
  expect(activateTool).not.toHaveBeenCalled();
});
