// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HELP_TOPICS } from "../src/docs/helpContent";
import { showHelpDialog } from "../src/ui/helpDialog";
import { isModalOpen, closeAllModals } from "../src/ui/modal";

describe("Help Content & Dialog", () => {
  it("contains all expected help topics", () => {
    expect(HELP_TOPICS.length).toBe(10);
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(ids).toContain("getting-started");
    expect(ids).toContain("2d-drafting");
    expect(ids).toContain("cad-modifications");
    expect(ids).toContain("constraints");
    expect(ids).toContain("cam-toolpaths");
    expect(ids).toContain("laser-machining");
    expect(ids).toContain("tool-library");
    expect(ids).toContain("post-processors-gcode");
    expect(ids).toContain("simulation-cnc");
    expect(ids).toContain("shortcuts-reference");
  });

  it("every topic has valid required fields and non-empty sections", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.id).toBeTruthy();
      expect(topic.title).toBeTruthy();
      expect(topic.summary).toBeTruthy();
      expect(topic.keywords.length).toBeGreaterThan(0);
      expect(topic.sections.length).toBeGreaterThan(0);
      for (const section of topic.sections) {
        expect(section.heading).toBeTruthy();
        expect(section.body).toBeTruthy();
      }
    }
  });

  it("opens the help dialog and registers modal", () => {
    closeAllModals();
    expect(isModalOpen()).toBe(false);

    showHelpDialog();
    expect(isModalOpen()).toBe(true);

    const dialogHeader = document.querySelector(".tp-dialog-header h3");
    expect(dialogHeader?.textContent).toContain("RapidCAM Documentation");

    closeAllModals();
    expect(isModalOpen()).toBe(false);
  });
});
