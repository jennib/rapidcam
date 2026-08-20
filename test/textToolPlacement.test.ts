// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFromFile } from "../src/core/fontManager";
import { CADDocument } from "../src/model/document";
import { TextEntity } from "../src/model/entities";
import { SnapEngine } from "../src/input/snapping";
import { TextTool } from "../src/tools/textTool";
import type { ToolContext, ToolPointerEvent } from "../src/tools/tool";

// Opening the dialog kicks off the bundled-font load (a real fetch that never
// resolves under happy-dom). Nothing under test depends on it — the font the
// dialog shows is the one loaded in beforeAll below — so neutralise it.
vi.mock("../src/core/fontManager", async (importActual) => ({
  ...(await importActual<typeof import("../src/core/fontManager")>()),
  initBundledFonts: vi.fn(async () => {}),
}));

/**
 * The Text tool places first, then edits (Fusion / SolidWorks / LightBurn).
 *
 * The tool used to open a dialog on activation and then "stamp" the prepared
 * text onto the canvas on the next click. Now the first canvas click sets the
 * baseline-left anchor and opens the Place Text dialog; the glyphs preview live
 * at that anchor; a further canvas click moves it; Place commits and hands back
 * to Select; Cancel/Escape drops it.
 *
 * `activateTool` must never be called from `cancel()`: ToolManager.activate
 * cancels the outgoing tool first, so that would recurse forever.
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

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
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

/** The dialog's text field is the first `<input>` it builds. */
function textField(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".tp-dialog input")!;
}

function clickButton(label: string): void {
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".tp-dialog button")].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no dialog button "${label}"`);
  btn.click();
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

test("the first click opens the Place Text dialog and places nothing yet", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);

  expect(texts(doc)).toHaveLength(0);
  expect(activateTool).not.toHaveBeenCalled();
  expect(document.querySelector(".tp-dialog h3")?.textContent).toBe("Place Text");
});

test("Place commits a TextEntity at the anchor and returns to Select", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);
  textField().value = "PEW";
  clickButton("Place");

  expect(texts(doc)).toHaveLength(1);
  expect(texts(doc)[0].text).toBe("PEW");
  expect(texts(doc)[0].position).toEqual({ x: 5, y: 5 });
  expect(activateTool).toHaveBeenCalledWith("select");
});

test("a canvas click while the dialog is open moves the anchor", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx); // open + anchor (5, 5)
  tool.onPointerDown(evt({ x: 20, y: 30 }), ctx); // reposition
  textField().value = "HI";
  clickButton("Place");

  expect(texts(doc)[0].position).toEqual({ x: 20, y: 30 });
});

test("Cancel hands back to Select with nothing placed", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);
  clickButton("Cancel");

  expect(texts(doc)).toHaveLength(0);
  expect(activateTool).toHaveBeenCalledWith("select");
});

test("the live preview shows glyph outlines at the anchor as the text changes", () => {
  vi.useFakeTimers();
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx } = makeCtx(doc);
  const tool = new TextTool();

  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);
  // The font the dialog would show is the one loaded in beforeAll.
  const fontSel = document.querySelector<HTMLSelectElement>(".tp-dialog select")!;
  fontSel.value = fontId;
  const inp = textField();
  inp.value = "PEW";
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(150); // flush the debounced onChange

  const previews = tool.getOverlay().previews;
  expect(previews.some((p) => p.kind === "point")).toBe(true);
  // Real glyph outlines (post overlap-union), not just a bounding box.
  expect(previews.filter((p) => p.kind === "polyline").length).toBeGreaterThan(0);
});

test("cancel() never switches tools — that would recurse through activate()", () => {
  const doc = new CADDocument({ width: 200, height: 200 }, "mm");
  const { ctx, activateTool } = makeCtx(doc);
  const tool = new TextTool();
  tool.onPointerDown(evt({ x: 5, y: 5 }), ctx);

  // ToolManager.activate calls the outgoing tool's cancel BEFORE switching, so a
  // cancel that switched tools would call activate again, forever.
  tool.cancel(ctx);
  expect(activateTool).not.toHaveBeenCalled();
});
