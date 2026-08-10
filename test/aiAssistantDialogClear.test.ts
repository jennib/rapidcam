// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { showAiAssistantDialog } from "../src/ui/aiAssistantDialog";

/**
 * The Clear control on the AI Assistant's paste box.
 *
 * The box holds a whole .rcam document in a 96px-tall field, so emptying it by
 * hand is a select-all-and-delete; Clear is the affordance for that. What makes
 * it worth a test is not the `value = ""` but everything that has to go WITH
 * it: the result panel and the Copy Report button both describe the text being
 * cleared, and leaving them up over an empty box reads as "still broken" after
 * you've removed the thing that was broken.
 *
 * happy-dom has no layout engine, so nothing here can prove the button is
 * reachable on screen — that's `e2e/unreachable-controls.e2e.ts`'s job. These
 * assertions are about wiring and state.
 */

/** Mount the dialog and hand back the pieces this spec drives. */
function mount(): {
  paste: HTMLTextAreaElement;
  clearBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  copyReportBtn: HTMLButtonElement;
  resultBox: HTMLElement;
} {
  showAiAssistantDialog(new CADDocument({ width: 200, height: 150 }), "untitled", {
    onImport: async () => true,
  });
  const backdrop = document.getElementById("ai-dialog-backdrop")!;
  const buttons = [...backdrop.querySelectorAll("button")] as HTMLButtonElement[];
  const byText = (t: string) => buttons.find((b) => b.textContent === t)!;
  const textareas = [...backdrop.querySelectorAll("textarea")] as HTMLTextAreaElement[];
  return {
    // Step 1's optional request box comes first; step 2's paste box is the last.
    paste: textareas[textareas.length - 1],
    clearBtn: byText("Clear"),
    importBtn: byText("Check & Import"),
    copyReportBtn: byText("Copy Error Report for AI"),
    resultBox: backdrop.querySelector("#ai-result") as HTMLElement,
  };
}

/** Type into the box the way a paste does — value plus the input event. */
function typeInto(el: HTMLTextAreaElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  document.getElementById("ai-dialog-backdrop")?.remove();
  document.body.innerHTML = "";
});

describe("AI Assistant · Clear", () => {
  test("appears only once there is something to clear", () => {
    const { paste, clearBtn } = mount();
    expect(clearBtn.style.display).toBe("none");

    typeInto(paste, '{"version": 3}');
    expect(clearBtn.style.display).not.toBe("none");

    // Emptying it by hand takes the button away again — otherwise it lingers
    // over an empty field, which is the noise it was hidden to avoid.
    typeInto(paste, "");
    expect(clearBtn.style.display).toBe("none");
  });

  test("empties the box, refocuses it, and hides itself", () => {
    const { paste, clearBtn } = mount();
    typeInto(paste, '{"version": 3, "entities": []}');

    clearBtn.click();

    expect(paste.value).toBe("");
    expect(clearBtn.style.display).toBe("none");
    expect(document.activeElement).toBe(paste);
  });

  test("takes the report and Copy Report button down with the text", () => {
    const { paste, clearBtn, copyReportBtn, resultBox } = mount();

    // Stand in for a failed check: the error path reveals both of these.
    resultBox.style.display = "block";
    resultBox.textContent = "✗ 1 error:\n• [schema] entities/0 must have property 'type'";
    copyReportBtn.style.display = "";
    typeInto(paste, "not json at all");

    clearBtn.click();

    expect(resultBox.style.display).toBe("none");
    expect(resultBox.textContent).toBe("");
    expect(copyReportBtn.style.display).toBe("none");
  });

  // Positive control: Clear must not be a general dialog reset. The step-1
  // prompt box is a separate field and keeps whatever was typed in it.
  test("leaves the step-1 request box alone", () => {
    const { paste, clearBtn } = mount();
    const backdrop = document.getElementById("ai-dialog-backdrop")!;
    const request = backdrop.querySelector("textarea") as HTMLTextAreaElement;
    expect(request).not.toBe(paste);

    request.value = "a 100mm bracket with four M5 holes";
    typeInto(paste, '{"version": 3}');
    clearBtn.click();

    expect(paste.value).toBe("");
    expect(request.value).toBe("a 100mm bracket with four M5 holes");
  });
});
