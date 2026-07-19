import { getGsenderUrl, setGsenderUrl, getNcsenderUrl, setNcsenderUrl, setSenderApp } from "../core/prefs";
import { testGsenderConnection } from "../io/gsender";
import { testNcsenderConnection } from "../io/ncsender";
import { toast } from "./toast";
import { registerModal } from "./modal";

export function showSenderDialog(onSend: (app: "gSender" | "ncSender") => void): void {
  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";
  
  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "420px";
  
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  
  const title = document.createElement("h3");
  title.textContent = "Send to Machine";
  
  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "16px";
  
  let finalApp: "gSender" | "ncSender" | null = null;
  let unregister: () => void = () => {};
  
  const close = () => {
    if (finalApp && remCb.checked) {
      setSenderApp(finalApp);
    }
    unregister();
    backdrop.remove();
  };
  
  // gSender card
  const gCard = createSenderCard(
    "gSender", 
    getGsenderUrl(), 
    "http://localhost:8000",
    async (url) => {
      const res = await testGsenderConnection(url);
      return res.ok ? "Connected to gSender!" : "Connection failed.";
    },
    (url) => {
      setGsenderUrl(url);
      finalApp = "gSender";
      onSend("gSender");
      close();
    }
  );
  
  // ncSender card
  const nCard = createSenderCard(
    "ncSender",
    getNcsenderUrl(),
    "http://localhost:8090",
    async (url) => {
      const ok = await testNcsenderConnection(url);
      return ok ? "Connected to ncSender!" : "Connection failed.";
    },
    (url) => {
      setNcsenderUrl(url);
      finalApp = "ncSender";
      onSend("ncSender");
      close();
    }
  );
  
  body.append(gCard, nCard);
  
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

function createSenderCard(
  name: string, 
  initialUrl: string, 
  placeholder: string,
  onTest: (url: string) => Promise<string>,
  onSend: (url: string) => void
): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = "border:1px solid var(--border);border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:8px;";
  
  const title = document.createElement("div");
  title.textContent = name;
  title.style.fontWeight = "bold";
  
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;";
  
  const input = document.createElement("input");
  input.type = "text";
  input.value = initialUrl;
  input.placeholder = placeholder;
  input.className = "unit";
  input.style.flex = "1";
  
  const testBtn = document.createElement("button");
  testBtn.className = "btn";
  testBtn.textContent = "Test";
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    testBtn.textContent = "...";
    const res = await onTest(input.value);
    toast(res);
    testBtn.textContent = "Test";
    testBtn.disabled = false;
  });
  
  const sendBtn = document.createElement("button");
  sendBtn.className = "cam-gen-btn";
  sendBtn.style.padding = "4px 12px";
  sendBtn.style.margin = "0"; // override default margin
  sendBtn.textContent = "Send";
  sendBtn.addEventListener("click", () => onSend(input.value));
  
  row.append(input, testBtn, sendBtn);
  card.append(title, row);
  return card;
}
