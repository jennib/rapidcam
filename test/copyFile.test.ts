// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { ProjectManager } from "../src/io/projectManager";
import { FileMenu } from "../src/ui/fileMenu";

describe("Copy File to Clipboard feature", () => {
  let doc: CADDocument;
  let pm: ProjectManager;
  let host: HTMLElement;

  beforeEach(() => {
    doc = new CADDocument({ width: 400, height: 300 });
    pm = new ProjectManager(doc, {
      onDocumentChange: () => {},
      onSolve: () => {},
      onFitView: () => {},
      onCloseEditors: () => {},
      onDiagnostics: () => {},
    });
    host = document.createElement("div");
  });

  it("serializes current document and copies JSON to clipboard", () => {
    const l1 = new LineEntity({ x: 10, y: 10 }, { x: 80, y: 80 }, "line1");
    doc.add(l1);
    pm.currentFileName = "TestProject";

    let writtenText = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (t: string) => {
          writtenText = t;
        },
      },
      writable: true,
      configurable: true,
    });

    pm.copyFileToClipboard();

    expect(writtenText).not.toBe("");
    const parsed = JSON.parse(writtenText);
    expect(parsed.name).toBe("TestProject");
    expect(parsed.version).toBe(3);
    expect(parsed.entities.length).toBeGreaterThan(0);
  });

  it("triggers onCopyFile callback from FileMenu item", () => {
    let called = false;
    new FileMenu(host, {
      onNew: () => {},
      onStartScreen: () => {},
      onOpen: () => {},
      onSave: () => {},
      onCopyFile: () => {
        called = true;
      },
      onShareLink: () => {},
      onOpenRecent: () => {},
      onOpenExample: () => {},
      onAiAssistant: () => {},
      onImportSvg: () => {},
      onImportDxf: () => {},
      onImportImage: () => {},
    onImportStl: () => {},
      onExportSvg: () => {},
      onExportDxf: () => {},
    });

    const btn = host.querySelector("button") as HTMLButtonElement;
    btn.click(); // Open menu

    const items = document.querySelectorAll(".fmenu-item");
    const copyItem = Array.from(items).find(
      (item) => item.textContent?.includes("Copy File to Clipboard"),
    ) as HTMLElement;

    expect(copyItem).not.toBeUndefined();
    copyItem.click();

    expect(called).toBe(true);
  });
});
