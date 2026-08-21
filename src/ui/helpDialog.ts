/**
 * Interactive in-app Help Viewer and User Documentation modal.
 */

import {
  HELP_TOPICS,
  type HelpTopic,
  type HelpCallout,
  type HelpTable,
  type HelpCodeSnippet,
} from "../docs/helpContent";
import { registerModal } from "./modal";

/**
 * Inline SVG icons for the Help viewer, drawn in the same 24x24 currentColor
 * stroke style as tools/icons.ts and ui/stateIcons.ts. They replace the emoji
 * this surface used to show (lightbulb / info / warning / star / search /
 * copy), which rendered differently on every platform; a stroked icon inherits
 * the surrounding colour instead and can never clash with the theme. See
 * stateIcons.ts for the same migration on the eye/lock toggles.
 */
const helpIcon = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const HELP_ICONS = {
  search: helpIcon(`<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>`),
  copy: helpIcon(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`),
  check: helpIcon(`<path d="M20 6 9 17l-5-5"/>`),
  // Callout icons, one per HelpCallout type (tip / note / warning / best-practice).
  tip: helpIcon(`<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>`),
  note: helpIcon(`<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/>`),
  warning: helpIcon(`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`),
  star: helpIcon(`<path d="M12 3.5 14.6 8.8l5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9z"/>`),
} as const;

const CALLOUT_ICONS: Record<string, string> = {
  tip: HELP_ICONS.tip,
  note: HELP_ICONS.note,
  warning: HELP_ICONS.warning,
  "best-practice": HELP_ICONS.star,
};

let open = false;

/** Show the interactive Help Viewer modal. */
export function showHelpDialog(initialTopicId?: string): void {
  if (open) return;
  open = true;

  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog help-dialog";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // Header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header help-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "help-header-title-group";

  const h3 = document.createElement("h3");
  h3.textContent = "RapidCAM Documentation & User Guide";
  titleGroup.appendChild(h3);

  const badge = document.createElement("span");
  badge.className = "help-header-badge";
  badge.textContent = `${HELP_TOPICS.length} Topics`;
  titleGroup.appendChild(badge);

  hdr.appendChild(titleGroup);

  const closeIcon = document.createElement("button");
  closeIcon.className = "tp-dialog-close";
  closeIcon.setAttribute("aria-label", "Close");
  closeIcon.textContent = "✕";
  closeIcon.addEventListener("click", close);
  hdr.appendChild(closeIcon);

  dialog.appendChild(hdr);

  // Main container (Sidebar + Content Viewport)
  const body = document.createElement("div");
  body.className = "tp-dialog-body help-dialog-body";
  dialog.appendChild(body);

  // Sidebar
  const sidebar = document.createElement("div");
  sidebar.className = "help-sidebar";

  // Search Box
  const searchWrap = document.createElement("div");
  searchWrap.className = "help-search-container";

  const searchField = document.createElement("div");
  searchField.className = "help-search-field";
  searchField.innerHTML = `<span class="help-search-icon">${HELP_ICONS.search}</span>`;

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search topics, G-code, hotkeys...";
  searchInput.className = "help-search-input";
  searchInput.setAttribute("aria-label", "Search topics, G-code, hotkeys");
  searchField.appendChild(searchInput);
  searchWrap.appendChild(searchField);

  // Category Filter Pills
  const categories = [
    "All",
    "Getting Started",
    "2D Drafting",
    "Constraints",
    "CAM & Toolpaths",
    "Laser Machining",
    "Tool Library & Speeds",
    "Post-Processors & G-Code",
    "Simulation & CNC",
    "Shortcuts",
  ];
  let activeCategory = "All";

  const categoryBar = document.createElement("div");
  categoryBar.className = "help-category-filter";

  for (const cat of categories) {
    const pill = document.createElement("button");
    pill.className = `help-category-pill ${cat === activeCategory ? "active" : ""}`;
    pill.textContent = cat === "Post-Processors & G-Code" ? "G-Code" : cat;
    pill.title = cat;
    pill.addEventListener("click", () => {
      activeCategory = cat;
      categoryBar.querySelectorAll(".help-category-pill").forEach((p) => {
        p.classList.toggle("active", p.textContent === (cat === "Post-Processors & G-Code" ? "G-Code" : cat));
      });
      renderSidebar(searchInput.value);
    });
    categoryBar.appendChild(pill);
  }
  searchWrap.appendChild(categoryBar);
  sidebar.appendChild(searchWrap);

  const navList = document.createElement("div");
  navList.className = "help-nav-list";
  sidebar.appendChild(navList);
  body.appendChild(sidebar);

  // Content Viewport
  const contentArea = document.createElement("div");
  contentArea.className = "help-content-viewport";
  body.appendChild(contentArea);

  // Footer
  const ftr = document.createElement("div");
  ftr.className = "tp-dialog-footer help-footer";

  const tipText = document.createElement("span");
  tipText.className = "help-footer-tip";
  tipText.innerHTML = `<span>Press <kbd class="help-kbd">F1</kbd> for this Guide · <kbd class="help-kbd">?</kbd> for Shortcuts Overlay</span>`;
  ftr.appendChild(tipText);

  const okBtn = document.createElement("button");
  okBtn.className = "btn tp-apply-btn";
  okBtn.textContent = "Close Guide";
  okBtn.addEventListener("click", close);
  ftr.appendChild(okBtn);

  dialog.appendChild(ftr);

  let activeTopic: HelpTopic =
    HELP_TOPICS.find((t) => t.id === initialTopicId) ?? HELP_TOPICS[0];

  function getFilteredTopics(term: string): HelpTopic[] {
    const cleanTerm = term.toLowerCase().trim();
    return HELP_TOPICS.filter((t) => {
      const matchesCategory =
        activeCategory === "All" || t.category === activeCategory;
      if (!matchesCategory) return false;
      if (!cleanTerm) return true;

      return (
        t.title.toLowerCase().includes(cleanTerm) ||
        t.summary.toLowerCase().includes(cleanTerm) ||
        t.keywords.some((k) => k.toLowerCase().includes(cleanTerm)) ||
        t.sections.some(
          (s) =>
            s.heading.toLowerCase().includes(cleanTerm) ||
            s.body.toLowerCase().includes(cleanTerm) ||
            s.tips?.some((tip) => tip.toLowerCase().includes(cleanTerm)) ||
            s.callout?.text.toLowerCase().includes(cleanTerm) ||
            s.callout?.title?.toLowerCase().includes(cleanTerm) ||
            s.table?.headers.some((h) => h.toLowerCase().includes(cleanTerm)) ||
            s.table?.rows.some((row) =>
              row.some((cell) => cell.toLowerCase().includes(cleanTerm))
            )
        )
      );
    });
  }

  function renderSidebar(filter = ""): void {
    navList.innerHTML = "";
    const filtered = getFilteredTopics(filter);

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "help-empty-results";
      empty.innerHTML = `<div style="font-size:20px;margin-bottom:6px;">🔍</div><div>No matching topics found</div><div style="font-size:11px;opacity:0.7;margin-top:4px;">Try searching for "pocket", "laser", "arc", or "G0"</div>`;
      navList.appendChild(empty);
      return;
    }

    for (const topic of filtered) {
      const item = document.createElement("div");
      const isActive = topic.id === activeTopic.id;
      item.className = `help-nav-item ${isActive ? "active" : ""}`;

      const titleSpan = document.createElement("span");
      titleSpan.className = "help-nav-title";
      titleSpan.textContent = topic.title;
      item.appendChild(titleSpan);

      const catSpan = document.createElement("span");
      catSpan.className = "help-nav-category";
      catSpan.textContent = topic.category;
      item.appendChild(catSpan);

      item.addEventListener("click", () => {
        activeTopic = topic;
        renderSidebar(searchInput.value);
        renderContent();
        contentArea.scrollTop = 0;
      });

      navList.appendChild(item);
    }
  }

  function renderContent(): void {
    contentArea.innerHTML = "";

    const currentIndex = HELP_TOPICS.findIndex((t) => t.id === activeTopic.id);

    // Topic Header Block
    const topicHeader = document.createElement("div");
    topicHeader.className = "help-topic-header";

    const metaRow = document.createElement("div");
    metaRow.className = "help-topic-meta";

    const catBadge = document.createElement("span");
    catBadge.className = "help-topic-category-badge";
    catBadge.textContent = activeTopic.category;
    metaRow.appendChild(catBadge);

    const stepCounter = document.createElement("span");
    stepCounter.className = "help-topic-counter";
    stepCounter.textContent = `Topic ${currentIndex + 1} of ${HELP_TOPICS.length}`;
    metaRow.appendChild(stepCounter);

    topicHeader.appendChild(metaRow);

    const title = document.createElement("h2");
    title.className = "help-topic-title";
    title.textContent = activeTopic.title;
    topicHeader.appendChild(title);

    const summary = document.createElement("p");
    summary.className = "help-topic-summary";
    summary.textContent = activeTopic.summary;
    topicHeader.appendChild(summary);

    contentArea.appendChild(topicHeader);

    // Section Cards
    for (const sec of activeTopic.sections) {
      const card = document.createElement("div");
      card.className = "help-section-card";

      const h4 = document.createElement("h4");
      h4.className = "help-section-heading";
      h4.textContent = sec.heading;
      card.appendChild(h4);

      if (sec.body) {
        const p = document.createElement("p");
        p.className = "help-section-body";
        p.textContent = sec.body;
        card.appendChild(p);
      }

      // Callout Box
      if (sec.callout) {
        card.appendChild(createCalloutElement(sec.callout));
      }

      // Code Snippet Block
      if (sec.codeSnippet) {
        card.appendChild(createCodeSnippetElement(sec.codeSnippet));
      }

      // Structured Table
      if (sec.table) {
        card.appendChild(createTableElement(sec.table));
      }

      // Bullet Tips
      if (sec.tips && sec.tips.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "help-tips-list";
        for (const tip of sec.tips) {
          const li = document.createElement("li");
          li.className = "help-tip-item";
          li.innerHTML = formatTipText(tip);
          ul.appendChild(li);
        }
        card.appendChild(ul);
      }

      contentArea.appendChild(card);
    }

    // Navigation Footer (Previous / Next Topic buttons)
    const navFooter = document.createElement("div");
    navFooter.className = "help-topic-nav-footer";

    if (currentIndex > 0) {
      const prevTopic = HELP_TOPICS[currentIndex - 1];
      const prevBtn = document.createElement("button");
      prevBtn.className = "help-nav-btn prev";
      prevBtn.innerHTML = `← Previous: <strong>${prevTopic.title}</strong>`;
      prevBtn.addEventListener("click", () => {
        activeTopic = prevTopic;
        renderSidebar(searchInput.value);
        renderContent();
        contentArea.scrollTop = 0;
      });
      navFooter.appendChild(prevBtn);
    } else {
      const placeholder = document.createElement("div");
      navFooter.appendChild(placeholder);
    }

    if (currentIndex < HELP_TOPICS.length - 1) {
      const nextTopic = HELP_TOPICS[currentIndex + 1];
      const nextBtn = document.createElement("button");
      nextBtn.className = "help-nav-btn next";
      nextBtn.innerHTML = `Next: <strong>${nextTopic.title}</strong> →`;
      nextBtn.addEventListener("click", () => {
        activeTopic = nextTopic;
        renderSidebar(searchInput.value);
        renderContent();
        contentArea.scrollTop = 0;
      });
      navFooter.appendChild(nextBtn);
    }

    contentArea.appendChild(navFooter);
  }

  function createCalloutElement(callout: HelpCallout): HTMLElement {
    const box = document.createElement("div");
    box.className = `help-callout help-callout-${callout.type}`;

    const header = document.createElement("div");
    header.className = "help-callout-header";
    header.innerHTML = `<span class="help-callout-icon">${CALLOUT_ICONS[callout.type] ?? HELP_ICONS.tip}</span><strong class="help-callout-title">${callout.title ?? callout.type.toUpperCase()}</strong>`;
    box.appendChild(header);

    const body = document.createElement("div");
    body.className = "help-callout-body";
    body.innerHTML = formatTipText(callout.text);
    box.appendChild(body);

    return box;
  }

  function createCodeSnippetElement(snippet: HelpCodeSnippet): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "help-code-wrap";

    if (snippet.title) {
      const bar = document.createElement("div");
      bar.className = "help-code-header";
      bar.textContent = snippet.title;

      const copyBtn = document.createElement("button");
      copyBtn.className = "help-code-copy-btn";
      copyBtn.innerHTML = `${HELP_ICONS.copy}<span>Copy</span>`;
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(snippet.code).then(() => {
          copyBtn.classList.add("copied");
          copyBtn.innerHTML = `${HELP_ICONS.check}<span>Copied!</span>`;
          setTimeout(() => {
            copyBtn.classList.remove("copied");
            copyBtn.innerHTML = `${HELP_ICONS.copy}<span>Copy</span>`;
          }, 1800);
        });
      });
      bar.appendChild(copyBtn);
      wrap.appendChild(bar);
    }

    const pre = document.createElement("pre");
    pre.className = "help-code-block";
    const code = document.createElement("code");
    code.textContent = snippet.code;
    pre.appendChild(code);
    wrap.appendChild(pre);

    return wrap;
  }

  function createTableElement(table: HelpTable): HTMLElement {
    const container = document.createElement("div");
    container.className = "help-table-container";

    const tbl = document.createElement("table");
    tbl.className = "help-data-table";

    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const h of table.headers) {
      const th = document.createElement("th");
      th.textContent = h;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    tbl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of table.rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.innerHTML = formatTipText(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);
    return container;
  }

  function formatTipText(text: string): string {
    // Format glyph badges [glyph] and shortcut keys (key)
    return text
      .replace(/\[([^\]]+)\]/g, (_match, p1) => `<span class="help-glyph">${p1}</span>`)
      .replace(/\(([^)]+)\)/g, (_match, p1) => `<kbd class="help-kbd">${p1}</kbd>`);
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
