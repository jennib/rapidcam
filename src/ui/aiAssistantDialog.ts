/**
 * File ▸ AI Assistant — the two halves of the copy/paste loop with an LLM chat:
 *
 *   Step 1  copy a self-contained prompt (machine context + format guide) into
 *           any AI chat;
 *   Step 2  paste the AI's .rcam JSON back, where it is schema-validated,
 *           loaded, reference-checked, and solved — importing on success, and
 *           otherwise producing a copyable error report to paste back to the
 *           AI so it can fix its own file.
 *
 * The heavy pieces (the embedded format guide, ajv) are dynamic imports so
 * they cost nothing until the dialog is actually used.
 */

import { track } from "../analytics";
import type { AiCheckResult, SchemaValidator } from "../io/aiCheck";
import type { RcamFile } from "../io/fileio";
import type { CADDocument } from "../model/document";
import { copyToClipboard } from "./clipboard";
import { registerModal } from "./modal";
import { toast } from "./toast";

/** The single URL an autonomous agent needs — /llms.txt links everything else. */
const AGENT_DOCS_URL = "https://rapidcam.app/llms.txt";

export interface AiAssistantCallbacks {
  /**
   * Load a successfully checked file into the editor. Owns the discard-confirm;
   * resolves false when the user cancels it (the dialog then stays open).
   */
  onImport: (file: RcamFile, name: string) => Promise<boolean>;
}

/** The schema lives at a public URL; fetch + compile it once per session. */
let validatorPromise: Promise<SchemaValidator | null> | null = null;
function loadSchemaValidator(): Promise<SchemaValidator | null> {
  validatorPromise ??= (async () => {
    try {
      const [{ default: Ajv2020 }, { formatSchemaIssue }, schema] = await Promise.all([
        import("ajv/dist/2020"),
        import("../io/aiCheck"),
        fetch("/schema/rcam-v2.schema.json").then((r) => {
          if (!r.ok) throw new Error(`schema fetch failed: ${r.status}`);
          return r.json();
        }),
      ]);
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      return (data: unknown) =>
        validate(data) ? [] : (validate.errors ?? []).map(formatSchemaIssue);
    } catch (e) {
      console.warn("[ai] schema validation unavailable:", e);
      return null;
    }
  })();
  return validatorPromise;
}

function flashCopied(btn: HTMLButtonElement, label: string): void {
  const prev = btn.textContent;
  btn.textContent = label;
  btn.style.background = "#2d8a4e";
  btn.style.color = "#fff";
  setTimeout(() => {
    btn.textContent = prev;
    btn.style.background = "";
    btn.style.color = "";
  }, 2000);
}

export function showAiAssistantDialog(
  doc: CADDocument,
  currentFileName: string,
  cb: AiAssistantCallbacks,
): void {
  const existing = document.getElementById("ai-dialog-backdrop");
  if (existing) {
    existing.remove();
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.id = "ai-dialog-backdrop";
  backdrop.className = "welcome-backdrop";
  // Same layer as tp-backdrop so a discard-confirm (appended later) stacks above.
  backdrop.style.zIndex = "1000";
  let unregister: () => void = () => {};
  const close = () => {
    unregister();
    backdrop.remove();
  };

  const container = document.createElement("div");
  container.className = "about-dialog";
  container.style.maxWidth = "560px";
  container.style.maxHeight = "85vh";
  container.style.overflowY = "auto";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => close());

  const title = document.createElement("h2");
  title.style.cssText = "margin:0 0 6px 0;font-size:18px;";
  title.textContent = "AI Assistant";

  const intro = document.createElement("p");
  intro.style.cssText = "font-size:13px;color:var(--text-dim);margin:0 0 14px 0;";
  intro.textContent =
    "Have any AI chat (Claude, ChatGPT, …) design for this machine: copy a prompt out, paste its .rcam JSON back. RapidCAM checks the result and writes the fix-it report for you.";

  const sectionCss = "font-size:13px;font-weight:600;margin:14px 0 6px 0;";
  const hintCss = "font-size:12px;color:var(--text-dim);margin:0 0 8px 0;";

  // --- Step 1: copy prompt ---
  const s1 = document.createElement("div");
  const s1Title = document.createElement("div");
  s1Title.style.cssText = sectionCss;
  s1Title.textContent = "1 · Copy a prompt for the AI";
  s1.appendChild(s1Title);

  const hasWork = doc.entities.length > 1; // beyond the injected origin point
  const modeRow = document.createElement("div");
  modeRow.style.cssText = "display:flex;gap:14px;margin:0 0 8px 0;font-size:13px;";
  let mode: "new" | "modify" = hasWork ? "modify" : "new";
  for (const [value, label] of [
    ["new", "New design"],
    ["modify", "Modify current design"],
  ] as const) {
    const lab = document.createElement("label");
    lab.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer;";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "ai-mode";
    radio.value = value;
    radio.checked = mode === value;
    if (value === "modify" && !hasWork) radio.disabled = true;
    radio.addEventListener("change", () => {
      if (radio.checked) mode = value;
    });
    lab.appendChild(radio);
    lab.appendChild(document.createTextNode(label));
    modeRow.appendChild(lab);
  }
  s1.appendChild(modeRow);

  const request = document.createElement("textarea");
  request.placeholder =
    "What should the AI make or change? (optional — you can also type it in the chat)";
  request.style.cssText =
    "width:100%;box-sizing:border-box;height:52px;resize:vertical;background:var(--panel);" +
    "border:1px solid var(--border);border-radius:6px;color:var(--text);" +
    "font-size:13px;padding:7px 9px;font-family:inherit;";
  s1.appendChild(request);

  const copyPromptBtn = document.createElement("button");
  copyPromptBtn.className = "btn";
  copyPromptBtn.textContent = "Copy Prompt";
  copyPromptBtn.style.cssText = "margin-top:8px;padding:6px 16px;";
  copyPromptBtn.addEventListener("click", async () => {
    const { buildAiPrompt } = await import("../io/aiPrompt");
    copyToClipboard(buildAiPrompt(doc, currentFileName, mode, request.value));
    flashCopied(copyPromptBtn, "Copied!");
    track("ai_prompt_copied", { mode });
  });
  s1.appendChild(copyPromptBtn);

  const s1Hint = document.createElement("p");
  s1Hint.style.cssText = `${hintCss}margin-top:6px;`;
  s1Hint.textContent =
    "The prompt bundles your machine, stock, tool library, and the full .rcam format guide — paste it into any chat.";
  s1.appendChild(s1Hint);

  // --- Step 2: paste result ---
  const s2 = document.createElement("div");
  const s2Title = document.createElement("div");
  s2Title.style.cssText = sectionCss;
  s2Title.textContent = "2 · Paste the AI's .rcam JSON back";
  s2.appendChild(s2Title);

  const paste = document.createElement("textarea");
  paste.placeholder = 'Paste the AI\'s reply here (the {"version": 2, …} JSON, fences and all)';
  paste.style.cssText = `${request.style.cssText}height:96px;font-family:monospace;font-size:12px;`;
  s2.appendChild(paste);

  const importRow = document.createElement("div");
  importRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:8px;";
  const importBtn = document.createElement("button");
  importBtn.className = "btn";
  importBtn.textContent = "Check & Import";
  importBtn.style.cssText = "padding:6px 16px;";
  importRow.appendChild(importBtn);

  const copyReportBtn = document.createElement("button");
  copyReportBtn.className = "btn";
  copyReportBtn.textContent = "Copy Error Report for AI";
  copyReportBtn.style.cssText = "padding:6px 16px;display:none;";
  importRow.appendChild(copyReportBtn);
  s2.appendChild(importRow);

  const resultBox = document.createElement("div");
  resultBox.style.cssText =
    "display:none;margin-top:10px;padding:10px 12px;border-radius:6px;font-size:12px;" +
    "line-height:1.5;max-height:180px;overflow-y:auto;white-space:pre-wrap;" +
    "background:var(--panel);border:1px solid var(--border);";
  s2.appendChild(resultBox);

  let lastReport = "";
  importBtn.addEventListener("click", async () => {
    if (!paste.value.trim()) {
      toast("Paste the AI's JSON first.");
      return;
    }
    importBtn.disabled = true;
    importBtn.textContent = "Checking…";
    try {
      const [{ checkRcamText, buildErrorReport, extractJson }, validator] = await Promise.all([
        import("../io/aiCheck"),
        loadSchemaValidator(),
      ]);
      const result: AiCheckResult = checkRcamText(extractJson(paste.value), validator ?? undefined);
      track("ai_paste_checked", { ok: result.ok, issues: result.issues.length });
      if (result.ok && result.file) {
        const warnings = result.issues.filter((i) => i.severity === "warning");
        const name = result.file.name || "AI design";
        if (!(await cb.onImport(result.file, name))) return;
        close();
        toast(
          warnings.length
            ? `Imported "${name}" — ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings[0].message}`
            : `Imported "${name}".`,
          warnings.length ? 6000 : undefined,
        );
        return;
      }
      lastReport = buildErrorReport(result, result.file?.name || "pasted file");
      const errs = result.issues.filter((i) => i.severity === "error");
      const warns = result.issues.filter((i) => i.severity === "warning");
      resultBox.style.display = "block";
      resultBox.style.borderColor = "#a33";
      resultBox.textContent =
        `✗ ${errs.length} error${errs.length === 1 ? "" : "s"}` +
        (warns.length ? `, ${warns.length} warning${warns.length === 1 ? "" : "s"}` : "") +
        ":\n" +
        result.issues.map((i) => `• [${i.check}] ${i.message}`).join("\n") +
        (validator ? "" : "\n(schema validation was unavailable — checks were structural only)");
      copyReportBtn.style.display = "";
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = "Check & Import";
    }
  });

  copyReportBtn.addEventListener("click", () => {
    copyToClipboard(lastReport);
    flashCopied(copyReportBtn, "Copied — paste it to the AI");
    track("ai_error_report_copied");
  });

  // Footer: the one-URL path for agents (Claude Code, Cursor, …) that can
  // fetch the web themselves — no copy/paste loop needed.
  const footer = document.createElement("p");
  footer.style.cssText = `${hintCss}margin:14px 0 0 0;padding-top:10px;border-top:1px solid var(--border);`;
  footer.append("Using an AI agent instead? Point it at ");
  const agentUrl = document.createElement("code");
  agentUrl.textContent = AGENT_DOCS_URL;
  agentUrl.style.cssText = "user-select:all;";
  footer.appendChild(agentUrl);
  footer.append(" — it links the schema, format guide, examples, and integration guide. ");
  const copyUrlBtn = document.createElement("button");
  copyUrlBtn.className = "btn";
  copyUrlBtn.textContent = "Copy URL";
  copyUrlBtn.style.cssText = "font-size:11px;padding:1px 8px;margin-left:2px;";
  copyUrlBtn.addEventListener("click", () => {
    copyToClipboard(AGENT_DOCS_URL);
    flashCopied(copyUrlBtn, "Copied");
    track("ai_agent_url_copied");
  });
  footer.appendChild(copyUrlBtn);

  container.appendChild(closeBtn);
  container.appendChild(title);
  container.appendChild(intro);
  container.appendChild(s1);
  container.appendChild(s2);
  container.appendChild(footer);
  backdrop.appendChild(container);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  unregister = registerModal(backdrop, close);
  document.body.appendChild(backdrop);
}
