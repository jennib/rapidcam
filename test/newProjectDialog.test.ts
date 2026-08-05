// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { openNewProjectDialog } from "../src/ui/newProjectDialog";
import { closeAllModals } from "../src/ui/modal";

afterEach(() => {
  closeAllModals();
  document.body.innerHTML = "";
});

test("new project dialog is strictly modal: clicking backdrop or pressing Escape does not close it", () => {
  const onConfirm = vi.fn();
  openNewProjectDialog({}, onConfirm);

  const backdrop = document.getElementById("npd-backdrop");
  expect(backdrop).not.toBeNull();

  // Clicking the backdrop outside the dialog should NOT dismiss
  backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(document.getElementById("npd-backdrop")).not.toBeNull();

  // Pressing Escape should NOT dismiss
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.getElementById("npd-backdrop")).not.toBeNull();

  // Clicking Cancel button dismisses without calling onConfirm
  const cancelBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Cancel",
  );
  expect(cancelBtn).toBeDefined();
  cancelBtn?.click();

  expect(document.getElementById("npd-backdrop")).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

test("clicking Create Project closes dialog and invokes onConfirm", () => {
  const onConfirm = vi.fn();
  openNewProjectDialog({ name: "Test Project" }, onConfirm);

  const createBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Create Project",
  );
  expect(createBtn).toBeDefined();
  createBtn?.click();

  expect(document.getElementById("npd-backdrop")).toBeNull();
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0].name).toBe("Test Project");
});
