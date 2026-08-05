/**
 * Interactive in-app Help Viewer and User Documentation modal.
 */

import { HELP_TOPICS, type HelpTopic } from "../docs/helpContent";
import { registerModal } from "./modal";

let open = false;

/** Show the interactive Help Viewer modal. */
export function showHelpDialog(initialTopicId?: string): void {
  if (open) return;
  open = true;

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "820px";
  dialog.style.maxWidth = "90vw";
  dialog.style.height = "640px";
  dialog.style.maxHeight = "85vh";
  dialog.style.display = "flex";
  dialog.style.flexDirection = "column";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // Header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  hdr.style.display = "flex";
  hdr.style.justifyContent = "space-between";
  hdr.style.alignItems = "center";
  
  const h3 = document.createElement("h3");
  h3.textContent = "RapidCAM Documentation & User Guide";
  hdr.appendChild(h3);

  const closeIcon = document.createElement("button");
  closeIcon.className = "btn";
  closeIcon.style.padding = "2px 8px";
  closeIcon.style.fontSize = "14px";
  closeIcon.textContent = "✕";
  closeIcon.addEventListener("click", close);
  hdr.appendChild(closeIcon);

  dialog.appendChild(hdr);

  // Main container (Sidebar + Content Viewport)
  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  body.style.cssText = "display:flex;flex:1;overflow:hidden;padding:0;gap:0;";
  dialog.appendChild(body);

  // Sidebar
  const sidebar = document.createElement("div");
  sidebar.style.cssText =
    "width:250px;border-right:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;background:rgba(0,0,0,0.15);";
  
  const searchWrap = document.createElement("div");
  searchWrap.style.padding = "10px";
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search documentation…";
  searchInput.className = "tp-input";
  searchInput.style.width = "100%";
  searchInput.style.boxSizing = "border-box";
  searchWrap.appendChild(searchInput);
  sidebar.appendChild(searchWrap);

  const navList = document.createElement("div");
  navList.style.cssText = "flex:1;overflow-y:auto;padding:0 6px 10px 6px;";
  sidebar.appendChild(navList);
  body.appendChild(sidebar);

  // Content Area
  const contentArea = document.createElement("div");
  contentArea.style.cssText = "flex:1;overflow-y:auto;padding:20px 24px;line-height:1.6;";
  body.appendChild(contentArea);

  // Footer
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer";
  ftr.style.display = "flex";
  ftr.style.justifyContent = "space-between";
  ftr.style.alignItems = "center";

  const tipText = document.createElement("span");
  tipText.style.cssText = "font-size:12px;opacity:0.6;";
  tipText.textContent = "Tip: Press F1 anytime to open this guide, or ? for key bindings.";
  ftr.appendChild(tipText);

  const okBtn = document.createElement("button");
  okBtn.className = "btn tp-apply-btn";
  okBtn.textContent = "Close";
  okBtn.addEventListener("click", close);
  ftr.appendChild(okBtn);

  dialog.appendChild(ftr);

  let activeTopic: HelpTopic =
    HELP_TOPICS.find((t) => t.id === initialTopicId) ?? HELP_TOPICS[0];

  function renderSidebar(filter = ""): void {
    navList.innerHTML = "";
    const term = filter.toLowerCase().trim();

    const filtered = HELP_TOPICS.filter(
      (t) =>
        t.title.toLowerCase().includes(term) ||
        t.summary.toLowerCase().includes(term) ||
        t.keywords.some((k) => k.toLowerCase().includes(term)) ||
        t.sections.some((s) => s.heading.toLowerCase().includes(term) || s.body.toLowerCase().includes(term))
    );

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:12px;font-size:12px;opacity:0.5;text-align:center;";
      empty.textContent = "No topics found";
      navList.appendChild(empty);
      return;
    }

    for (const topic of filtered) {
      const item = document.createElement("div");
      const isActive = topic.id === activeTopic.id;
      item.style.cssText = `
        padding: 8px 10px;
        margin-bottom: 2px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        background: ${isActive ? "rgba(255,255,255,0.12)" : "transparent"};
        font-weight: ${isActive ? "600" : "normal"};
        color: ${isActive ? "var(--accent, #3b82f6)" : "inherit"};
        display: flex;
        flex-direction: column;
        gap: 2px;
      `;

      const titleSpan = document.createElement("span");
      titleSpan.textContent = topic.title;
      item.appendChild(titleSpan);

      const catSpan = document.createElement("span");
      catSpan.style.cssText = "font-size:10px;opacity:0.5;";
      catSpan.textContent = topic.category;
      item.appendChild(catSpan);

      item.addEventListener("click", () => {
        activeTopic = topic;
        renderSidebar(searchInput.value);
        renderContent();
      });

      navList.appendChild(item);
    }
  }

  function renderContent(): void {
    contentArea.innerHTML = "";

    const title = document.createElement("h2");
    title.style.cssText = "margin-top:0;margin-bottom:6px;font-size:20px;";
    title.textContent = activeTopic.title;
    contentArea.appendChild(title);

    const summary = document.createElement("p");
    summary.style.cssText = "font-size:13px;opacity:0.75;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.1);";
    summary.textContent = activeTopic.summary;
    contentArea.appendChild(summary);

    for (const sec of activeTopic.sections) {
      const h4 = document.createElement("h4");
      h4.style.cssText = "margin-top:16px;margin-bottom:6px;font-size:15px;color:var(--text, #eee);";
      h4.textContent = sec.heading;
      contentArea.appendChild(h4);

      const p = document.createElement("p");
      p.style.cssText = "font-size:13px;margin-bottom:10px;opacity:0.9;";
      p.textContent = sec.body;
      contentArea.appendChild(p);

      if (sec.tips && sec.tips.length > 0) {
        const ul = document.createElement("ul");
        ul.style.cssText = "margin:0 0 16px 0;padding-left:20px;font-size:13px;";
        for (const tip of sec.tips) {
          const li = document.createElement("li");
          li.style.margin = "4px 0";
          li.textContent = tip;
          ul.appendChild(li);
        }
        contentArea.appendChild(ul);
      }
    }
  }

  searchInput.addEventListener("input", (e) => {
    renderSidebar((e.target as HTMLInputElement).value);
  });

  renderSidebar();
  renderContent();

  const dispose = registerModal(backdrop, close);
  function close(): void {
    dispose();
    backdrop.remove();
    open = false;
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  document.body.appendChild(backdrop);
  searchInput.focus();
}
