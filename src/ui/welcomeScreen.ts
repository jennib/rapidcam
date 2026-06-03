import { getRecents, type RecentEntry } from "../io/fileio";

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
  onOpenRecent: (entry: RecentEntry) => void
): void {
  const backdrop = document.createElement("div");
  backdrop.className = "welcome-backdrop";

  const container = document.createElement("div");
  container.className = "welcome-container";

  const title = document.createElement("h1");
  title.className = "welcome-title";
  title.innerHTML = `Rapid<span>CAM</span>`;

  const subtitle = document.createElement("p");
  subtitle.textContent = "Parametric 2D Vector CAD/CAM Editor";
  subtitle.className = "welcome-subtitle";

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

  // Right column (Recent files)
  const rightCol = document.createElement("div");
  rightCol.className = "welcome-section";

  const rightTitle = document.createElement("div");
  rightTitle.className = "welcome-section-title";
  rightTitle.textContent = "Recent Projects";
  rightCol.appendChild(rightTitle);

  const recentsContainer = document.createElement("div");
  recentsContainer.className = "welcome-recents";

  const recents = getRecents();
  if (recents.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "welcome-recents-empty";
    emptyState.textContent = "No recent files. Start by creating a new project!";
    recentsContainer.appendChild(emptyState);
  } else {
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
  }

  rightCol.appendChild(recentsContainer);

  content.appendChild(leftCol);
  content.appendChild(rightCol);

  container.appendChild(title);
  container.appendChild(subtitle);
  container.appendChild(content);
  backdrop.appendChild(container);

  document.body.appendChild(backdrop);
}

