import { getRecents, type RecentEntry } from "../io/fileio";
import { getExamples, type ExampleEntry } from "../io/examples";
import { renderThumbnailSvg } from "./entityThumbnail";
import { getDraftMeta } from "../io/draftStore";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "Just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function showWelcomeScreen(
  onNew: () => void,
  onOpen: () => void,
  onOpenRecent: (entry: RecentEntry) => void,
  onRestoreDraft: () => void,
  onOpenExample: (entry: ExampleEntry) => void,
  opts: { dismissable?: boolean } = {},
): void {
  // Dedup: never stack two splashes (e.g. re-opened from the File menu).
  document.querySelector(".welcome-backdrop")?.remove();

  const recents = getRecents();
  const examples = getExamples();

  const draft = getDraftMeta();

  // A native <dialog> in the top layer; the inline styles defeat the UA's
  // dialog defaults (auto margins, fit-content sizing) so the element fills
  // the viewport and the CSS class handles layout. Scrolling lives on the
  // dialog itself: the card centres via margin:auto when it fits and stays
  // fully reachable on short laptop viewports when it doesn't.
  const backdrop = document.createElement("dialog");
  backdrop.className = "welcome-backdrop";
  backdrop.style.border = "none";
  backdrop.style.margin = "0";
  backdrop.style.maxWidth = "none";
  backdrop.style.maxHeight = "none";
  backdrop.style.width = "100%";
  backdrop.style.height = "100%";
  backdrop.style.display = "flex";
  backdrop.style.overflowY = "auto";
  backdrop.style.background = "rgba(15, 17, 23, 0.85)";

  const container = document.createElement("div");
  container.className = "welcome-container";


  const logo = document.createElement("img");
  logo.src = "/rapidcam-logo.svg";
  logo.alt = "RapidCAM";
  logo.className = "welcome-logo";

  const welcome = document.createElement("div");
  welcome.className = "welcome-intro";
  welcome.innerHTML = `
    <p class="welcome-intro-heading">Welcome to RapidCAM</p>
    <p class="welcome-intro-body">RapidCAM is a parametric 2D CAD/CAM editor built for CNC and laser.
    Draw with fully constrained geometry and variables to keep your design exact as you iterate. 
    When you're ready, generate G-code for profiles, pockets, V-carving, 3D relief carving, 
    rotary 4th-axis, and laser engraving directly from your drawing.</p>
  `;

  const content = document.createElement("div");
  content.className = "welcome-content";

  // Left column (Actions)
  const leftCol = document.createElement("div");
  leftCol.className = "welcome-section";

  const leftTitle = document.createElement("div");
  leftTitle.className = "welcome-section-title";
  leftTitle.textContent = "Quick Start";
  leftCol.appendChild(leftTitle);

  const cards = document.createElement("div");
  cards.className = "welcome-cards";

  // Restore Draft Card (if it exists)
  if (draft) {
    const restoreCard = document.createElement("div");
    restoreCard.className = "welcome-card welcome-card-restore";
    restoreCard.innerHTML = `
      <div class="welcome-card-icon welcome-card-icon-restore">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6"></path>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
      </div>
      <div class="welcome-card-details">
        <div class="welcome-card-title">Restore Unsaved Draft</div>
        <div class="welcome-card-desc">Recover "${draft.name}" (${formatRelativeTime(draft.savedAt)})</div>
      </div>
    `;
    restoreCard.addEventListener("click", () => {
      backdrop.remove();
      onRestoreDraft();
    });
    cards.appendChild(restoreCard);
  }

  // Resume Last Project Card (if recents exist)
  if (recents.length > 0) {
    const lastProject = recents[0];
    const resumeCard = document.createElement("div");
    resumeCard.className = "welcome-card welcome-card-resume";
    resumeCard.innerHTML = `
      <div class="welcome-card-icon welcome-card-icon-resume">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
      </div>
      <div class="welcome-card-details">
        <div class="welcome-card-title">Resume Last Project</div>
        <div class="welcome-card-desc">Open "${lastProject.name}"</div>
      </div>
    `;
    resumeCard.addEventListener("click", () => {
      backdrop.remove();
      onOpenRecent(lastProject);
    });
    cards.appendChild(resumeCard);
  }

  // New Project Card
  const newCard = document.createElement("div");
  newCard.className = "welcome-card";
  newCard.innerHTML = `
    <div class="welcome-card-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="12" y1="8" x2="12" y2="16"></line>
        <line x1="8" y1="12" x2="16" y2="12"></line>
      </svg>
    </div>
    <div class="welcome-card-details">
      <div class="welcome-card-title">New Project</div>
      <div class="welcome-card-desc">Start a new drawing from scratch</div>
    </div>
  `;
  newCard.addEventListener("click", () => {
    backdrop.remove();
    onNew();
  });

  // Open Project Card
  const openCard = document.createElement("div");
  openCard.className = "welcome-card";
  openCard.innerHTML = `
    <div class="welcome-card-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
    </div>
    <div class="welcome-card-details">
      <div class="welcome-card-title">Open File</div>
      <div class="welcome-card-desc">Load an existing RapidCAM project</div>
    </div>
  `;
  openCard.addEventListener("click", () => {
    backdrop.remove();
    onOpen();
  });

  cards.appendChild(newCard);
  cards.appendChild(openCard);
  leftCol.appendChild(cards);

  // Right column (Recent files + Examples)
  const rightCol = document.createElement("div");
  rightCol.className = "welcome-section";

  // Recent Projects — only shown when there are some.
  if (recents.length > 0) {
    const rightTitle = document.createElement("div");
    rightTitle.className = "welcome-section-title";
    rightTitle.textContent = "Recent Projects";
    rightCol.appendChild(rightTitle);

    const recentsContainer = document.createElement("div");
    recentsContainer.className = "welcome-recents";
    for (const r of recents) {
      const item = document.createElement("div");
      item.className = "welcome-recent-item";

      const header = document.createElement("div");
      header.className = "welcome-recent-header";

      const nameSpan = document.createElement("span");
      nameSpan.className = "welcome-recent-name";
      nameSpan.textContent = r.name;
      nameSpan.title = r.name;

      const timeSpan = document.createElement("span");
      timeSpan.className = "welcome-recent-time";
      timeSpan.textContent = formatRelativeTime(r.savedAt);

      header.appendChild(nameSpan);
      header.appendChild(timeSpan);

      const meta = document.createElement("div");
      meta.className = "welcome-recent-meta";
      const w = r.data.canvas.width;
      const h = r.data.canvas.height;
      const unit = r.data.displayUnit || "mm";
      meta.textContent = `${w} × ${h} ${unit}`;

      item.appendChild(header);
      item.appendChild(meta);

      item.addEventListener("click", () => {
        backdrop.remove();
        onOpenRecent(r);
      });

      recentsContainer.appendChild(item);
    }
    rightCol.appendChild(recentsContainer);
  }

  // Examples — always offered, so a first-time user has a one-click way into a
  // real project instead of a blank canvas.
  if (examples.length > 0) {
    const exTitle = document.createElement("div");
    exTitle.className = "welcome-section-title";
    exTitle.textContent = "Examples";
    rightCol.appendChild(exTitle);

    const exContainer = document.createElement("div");
    exContainer.className = "welcome-example-grid";
    for (const ex of examples) {
      const card = document.createElement("div");
      card.className = "welcome-example-card";

      // Geometry preview — drops a first-time user straight into "I could make that".
      const thumb = document.createElement("div");
      thumb.className = "welcome-example-thumb";
      const svg = renderThumbnailSvg(ex.file);
      if (svg) thumb.innerHTML = svg;
      card.appendChild(thumb);

      const info = document.createElement("div");
      info.className = "welcome-example-info";

      const nameSpan = document.createElement("div");
      nameSpan.className = "welcome-example-name";
      nameSpan.textContent = ex.name;
      nameSpan.title = ex.name;
      info.appendChild(nameSpan);

      const meta = document.createElement("div");
      meta.className = "welcome-example-meta";
      const w = ex.file.canvas.width;
      const h = ex.file.canvas.height;
      const unit = ex.file.displayUnit || "mm";
      const opCount = ex.file.operations?.length ?? 0;
      meta.textContent =
        opCount > 0
          ? `${w} × ${h} ${unit} · ${opCount} toolpath${opCount !== 1 ? "s" : ""}`
          : `${w} × ${h} ${unit}`;
      info.appendChild(meta);
      card.appendChild(info);

      card.addEventListener("click", () => {
        backdrop.remove();
        onOpenExample(ex);
      });

      exContainer.appendChild(card);
    }
    rightCol.appendChild(exContainer);
  }

  // Nothing to show at all (no recents, no bundled examples) — keep a hint.
  if (recents.length === 0 && examples.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "welcome-recents-empty";
    emptyState.textContent = "No recent files. Start by creating a new project!";
    rightCol.appendChild(emptyState);
  }

  content.appendChild(leftCol);
  content.appendChild(rightCol);

  const footer = document.createElement("div");
  footer.className = "welcome-footer";

  // Deliberately visible (not display:none): screenshot-driven agents can only
  // discover what a human can see. Kept dim so humans skim past it.
  const aiHint = document.createElement("a");
  aiHint.className = "welcome-ai-hint";
  aiHint.href = "/llms.txt";
  aiHint.target = "_blank";
  aiHint.rel = "noopener noreferrer";
  aiHint.textContent = "AI agents: docs at rapidcam.app/llms.txt";
  footer.appendChild(aiHint);

  container.appendChild(logo);
  container.appendChild(welcome);
  container.appendChild(content);
  container.appendChild(footer);
  backdrop.appendChild(container);

  if (opts.dismissable) {
    // Reopened mid-session (File → Start Screen): every card on the splash
    // replaces the current document, so the user needs a way to back out and
    // keep working — Escape (the native <dialog> cancel) or a click on the
    // dimmed area outside the card.
    backdrop.addEventListener("cancel", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
  } else {
    // At launch there is nothing behind the splash — strict modal: no Escape,
    // no click-outside. The user must choose an option to proceed.
    backdrop.addEventListener("cancel", (e) => e.preventDefault());
  }

  document.body.appendChild(backdrop);
  backdrop.showModal();
}
