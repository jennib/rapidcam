import { getGsenderUrl, setGsenderUrl, getNcsenderUrl, setNcsenderUrl, setSenderApp } from "../core/prefs";
import { testGsenderConnection } from "../io/gsender";
import { testNcsenderConnection } from "../io/ncsender";
import { GEDITOR_URL } from "../io/geditor";
import { toast } from "./toast";
import { registerModal } from "./modal";

/**
 * Where a finished program can go. The first two are machine senders reached at a
 * local address; GEditor is the browser editor/simulator at editor.rapidcam.app —
 * offered here because reviewing the program is the other thing you do with it,
 * and this is where the operator already is when they've finished a job.
 */
export type SendTarget = "gSender" | "ncSender" | "GEditor";

export function showSenderDialog(onSend: (app: SendTarget) => void): void {
  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "420px";

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";

  const title = document.createElement("h3");
  title.textContent = "Send G-code";

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "16px";

  let finalApp: SendTarget | null = null;
  let unregister: () => void = () => {};

  const close = () => {
    // Only a machine sender is worth remembering as a default: the pref exists to
    // pick between gSender and ncSender, and GEditor is a review step, not a
    // destination.
    if (finalApp && finalApp !== "GEditor" && remCb.checked) {
      setSenderApp(finalApp);
    }
    unregister();
    backdrop.remove();
  };

  // gSender card
  const gCard = createSenderCard({
    name: "gSender",
    url: {
      initial: getGsenderUrl(),
      placeholder: "http://localhost:8000",
      onTest: async (url) => {
        const res = await testGsenderConnection(url);
        return res.ok ? "Connected to gSender!" : "Connection failed.";
      },
    },
    onSend: (url) => {
      setGsenderUrl(url);
      finalApp = "gSender";
      onSend("gSender");
      close();
    },
  });

  // ncSender card
  const nCard = createSenderCard({
    name: "ncSender",
    url: {
      initial: getNcsenderUrl(),
      placeholder: "http://localhost:8090",
      onTest: async (url) => {
        const res = await testNcsenderConnection(url);
        return res.ok ? "Connected to ncSender!" : "Connection failed.";
      },
    },
    onSend: (url) => {
      setNcsenderUrl(url);
      finalApp = "ncSender";
      onSend("ncSender");
      close();
    },
  });

  // GEditor card — a hosted web app, so there's no address to configure and
  // nothing to test: the button either opens a tab or the browser blocks it.
  const eCard = createSenderCard({
    name: "GEditor",
    blurb: `Read, edit and 3D-simulate the program in your browser first (${GEDITOR_URL.replace(/^https?:\/\/|\/$/g, "")}).`,
    sendLabel: "Open",
    onSend: () => {
      finalApp = "GEditor";
      onSend("GEditor");
      close();
    },
  });

  body.append(gCard, nCard, eCard);

  const remRow = document.createElement("label");
  remRow.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;";
  const remCb = document.createElement("input");
  remCb.type = "checkbox";
  remRow.append(remCb, document.createTextNode("Remember my choice (can be changed in Machine Settings)"));
  body.append(remRow);

  const closeBtn = document.createElement("button");
  closeBtn.className = "tp-dialog-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);

  hdr.append(title, closeBtn);
  dialog.append(hdr, body);
  backdrop.append(dialog);
  document.body.appendChild(backdrop);

  unregister = registerModal(backdrop, close);
}

interface SenderCardOpts {
  name: string;
  /** One line under the title, for a destination that needs explaining. */
  blurb?: string;
  /** Address field + Test button. Omit for a destination with no address (GEditor). */
  url?: {
    initial: string;
    placeholder: string;
    onTest: (url: string) => Promise<string>;
  };
  /** Defaults to "Send". */
  sendLabel?: string;
  /** Receives the (possibly edited) address, or "" for an addressless destination. */
  onSend: (url: string) => void;
}

function createSenderCard({ name, blurb, url, sendLabel, onSend }: SenderCardOpts): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = "border:1px solid var(--border);border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:8px;";

  const title = document.createElement("div");
  title.textContent = name;
  title.style.fontWeight = "bold";
  card.append(title);

  if (blurb) {
    const sub = document.createElement("div");
    sub.textContent = blurb;
    sub.style.cssText = "font-size:12px;opacity:0.75;";
    card.append(sub);
  }

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;";

  let input: HTMLInputElement | null = null;
  if (url) {
    input = document.createElement("input");
    input.type = "text";
    input.value = url.initial;
    input.placeholder = url.placeholder;
    input.className = "unit";
    input.style.flex = "1";

    const testBtn = document.createElement("button");
    testBtn.className = "btn";
    testBtn.textContent = "Test";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "...";
      const res = await url.onTest(input!.value);
      toast(res);
      testBtn.textContent = "Test";
      testBtn.disabled = false;
    });

    row.append(input, testBtn);
  }
  // With no address field alongside it, the button simply fills the card — the
  // one action there is to take.

  const sendBtn = document.createElement("button");
  sendBtn.className = "cam-gen-btn";
  sendBtn.style.padding = "4px 12px";
  sendBtn.style.margin = "0"; // override default margin
  sendBtn.textContent = sendLabel ?? "Send";
  sendBtn.addEventListener("click", () => onSend(input?.value ?? ""));

  row.append(sendBtn);
  card.append(row);
  return card;
}
