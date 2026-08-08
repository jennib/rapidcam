/**
 * The custom program start/end G-code field, with the two things a bare textarea
 * could never give you: an explanation of what is already in it, and a short list
 * of correct blocks to add.
 *
 * Both halves are resolved against the controller selected a few fields up in the
 * same dialog, which is the whole point — "what does this mean" and "will my
 * machine accept it" are different questions, and only the second one prevents a
 * crash. `$H` homes a GRBL; `G28` on the same machine rapids to a stored position
 * that may never have been taught. See cam/gcodeGlossary for the knowledge; this
 * file only renders it.
 *
 * The textarea stays the source of truth. Picking a block INSERTS text (comments
 * and all — gcode.ts customLines passes lines through verbatim), so a pasted
 * block, a hand-typed one and a picked one are all the same kind of thing and all
 * get explained the same way. Storing picks as structured data would buy conflict
 * detection across blocks, but needs a prefs migration and still needs a
 * free-text escape hatch, so it waits until the catalogue earns it.
 */

import {
  annotate,
  blocksFor,
  checkBlock,
  DIALECT_LABEL,
  dialectOf,
  type AnnotatedLine,
  type LineStatus,
  type Slot,
} from "../cam/gcodeGlossary";

/** What the block is being judged against — all live values from the dialog. */
export interface BlockContext {
  postId: string;
  machine: "mill" | "laser";
  /** Machine Settings' coolant checkbox: when on, the post drives M7/M8/M9 itself. */
  coolantEnabled: boolean;
}

export interface GcodeBlockEditor {
  field: HTMLElement;
  readonly value: string;
  /** Re-resolve against a changed controller / machine kind and re-render. */
  refresh(ctx: BlockContext): void;
  /** Cancel the pending re-render. Call from the dialog's close funnel. */
  dispose(): void;
}

/** Leading glyph and CSS modifier per line status. `ok` stays unmarked — a tidy
 *  block should read as quiet, not as a wall of ticks. */
const STATUS_MARK: Record<LineStatus, { mark: string; cls: string }> = {
  blank: { mark: "", cls: "" },
  comment: { mark: "", cls: "" },
  ok: { mark: "", cls: "gbe-ok" },
  caution: { mark: "⚠", cls: "gbe-caution" },
  optional: { mark: "◐", cls: "gbe-caution" },
  unsupported: { mark: "⛔", cls: "gbe-bad" },
  unknown: { mark: "?", cls: "gbe-unknown" },
};

/** Re-render delay. Matches the generator dialog's live-preview debounce. */
const RENDER_DEBOUNCE_MS = 150;

export function createGcodeBlockEditor(opts: {
  label: string;
  slot: Slot;
  value: string;
  placeholder: string;
  ctx: BlockContext;
}): GcodeBlockEditor {
  let ctx = opts.ctx;

  const field = document.createElement("div");
  field.className = "post-settings-field gbe";

  // --- header: label + the picker toggle ---
  const head = document.createElement("div");
  head.className = "gbe-head";
  const lab = document.createElement("label");
  lab.textContent = opts.label;
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn gbe-add";
  addBtn.textContent = "+ Add block…";
  head.append(lab, addBtn);

  // --- picker (collapsed until asked for) ---
  const picker = document.createElement("div");
  picker.className = "gbe-picker";
  picker.hidden = true;

  const ta = document.createElement("textarea");
  ta.className = "post-settings-textarea";
  ta.spellcheck = false;
  ta.rows = 4;
  ta.value = opts.value;
  ta.placeholder = opts.placeholder;

  const findingsEl = document.createElement("div");
  findingsEl.className = "gbe-findings";

  const notesEl = document.createElement("div");
  notesEl.className = "gbe-notes";

  field.append(head, picker, ta, findingsEl, notesEl);

  // --- insertion ---
  const insert = (lines: readonly string[]): void => {
    const existing = ta.value.replace(/\s+$/, "");
    ta.value = (existing ? `${existing}\n` : "") + lines.join("\n");
    picker.hidden = true;
    addBtn.setAttribute("aria-expanded", "false");
    render();
    ta.focus();
    // Caret to the end, so the next thing typed continues the block rather than
    // landing wherever the caret happened to be before the button was clicked.
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  const renderPicker = (): void => {
    picker.replaceChildren();
    const available = blocksFor(opts.slot, ctx.machine, ctx.postId);
    if (available.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gbe-empty";
      empty.textContent = `No standard blocks apply to ${DIALECT_LABEL[dialectOf(ctx.postId)]} here.`;
      picker.append(empty);
      return;
    }
    for (const { option, lines } of available) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gbe-option";
      const title = document.createElement("div");
      title.className = "gbe-option-label";
      title.textContent = option.label;
      const blurb = document.createElement("div");
      blurb.className = "gbe-option-blurb";
      blurb.textContent = option.blurb;
      const code = document.createElement("code");
      code.className = "gbe-option-code";
      code.textContent = lines.join("\n");
      row.append(title, blurb, code);
      if (option.caution) {
        const caution = document.createElement("div");
        caution.className = "gbe-option-caution";
        caution.textContent = `⚠ ${option.caution}`;
        row.append(caution);
      }
      row.addEventListener("click", () => insert(lines));
      picker.append(row);
    }
  };

  // --- explanation + findings ---
  const renderNote = (line: AnnotatedLine): HTMLElement => {
    const { mark, cls } = STATUS_MARK[line.status];
    const row = document.createElement("div");
    row.className = `gbe-note ${cls}`;
    const num = document.createElement("span");
    num.className = "gbe-note-line";
    num.textContent = `${line.n}`;
    const body = document.createElement("span");
    body.className = "gbe-note-body";
    // Title first because it is the answer to "what is this"; the summary
    // explains it, and the note carries the controller-specific sting.
    const head = [mark, line.code, line.title].filter(Boolean).join(" ");
    const strong = document.createElement("strong");
    strong.textContent = head || mark || "";
    body.append(strong);
    const rest = [line.summary, line.note].filter(Boolean).join(" ");
    if (rest) body.append(document.createTextNode(` ${rest}`));
    row.append(num, body);
    return row;
  };

  const render = (): void => {
    const text = ta.value;

    const findings = checkBlock(text, {
      postId: ctx.postId,
      slot: opts.slot,
      coolantEnabled: ctx.coolantEnabled,
    });
    findingsEl.replaceChildren();
    for (const f of findings) {
      const row = document.createElement("div");
      row.className = `gbe-finding ${f.severity === "error" ? "gbe-bad" : "gbe-caution"}`;
      row.textContent = `${f.severity === "error" ? "⛔" : "⚠"} ${f.message}`;
      findingsEl.append(row);
    }

    notesEl.replaceChildren();
    const lines = annotate(text, ctx.postId).filter(
      (l) => l.status !== "blank" && l.status !== "comment",
    );
    for (const line of lines) notesEl.append(renderNote(line));
    // Nothing to explain and nothing wrong: stay silent rather than render an
    // empty bordered box under every field.
    notesEl.hidden = lines.length === 0;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRender = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      render();
    }, RENDER_DEBOUNCE_MS);
  };

  addBtn.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    addBtn.setAttribute("aria-expanded", picker.hidden ? "false" : "true");
    if (!picker.hidden) renderPicker();
  });
  ta.addEventListener("input", scheduleRender);

  renderPicker();
  render();

  return {
    field,
    get value() {
      return ta.value;
    },
    refresh(next: BlockContext) {
      ctx = next;
      renderPicker();
      render();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
