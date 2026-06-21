export function showAboutDialog(): void {
  const backdrop = document.createElement("div");
  backdrop.className = "welcome-backdrop";
  backdrop.style.zIndex = "9999";

  const container = document.createElement("div");
  container.className = "about-dialog";

  const closeBtn = document.createElement("button");
  closeBtn.className = "about-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => backdrop.remove());

  const logo = document.createElement("img");
  logo.src = "/rapidcam-logo.svg";
  logo.alt = "RapidCAM";
  logo.className = "welcome-logo";

  const desc = document.createElement("p");
  desc.className = "about-desc";
  desc.textContent =
    "RapidCAM is a parametric 2D CAD/CAM editor built for CNC work. " +
    "Draw with fully constrained geometry — dimensions, parallel, perpendicular, and coincident " +
    "constraints keep your design exact as you iterate. When you're ready, generate G-code profiles, " +
    "pockets, and engrave paths directly from your drawing.";

  const version = document.createElement("p");
  version.className = "about-version";
  version.textContent = "Version 1.0.0  ·  © 2026 RapidCAM";

  const bmc = document.createElement("a");
  bmc.href = "https://www.buymeacoffee.com/jennibm";
  bmc.target = "_blank";
  bmc.rel = "noopener noreferrer";
  bmc.className = "bmc-button";
  bmc.innerHTML = `<img src="https://cdn.buymeacoffee.com/buttons/bmc-new-btn-logo.svg" alt="☕"> Buy me a coffee`;

  const gh = document.createElement("a");
  gh.href = "https://github.com/jennib/rapidcam";
  gh.target = "_blank";
  gh.rel = "noopener noreferrer";
  gh.className = "about-gh-link";
  gh.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View on GitHub`;

  container.appendChild(closeBtn);
  container.appendChild(logo);
  container.appendChild(desc);
  container.appendChild(version);
  container.appendChild(gh);
  container.appendChild(bmc);
  backdrop.appendChild(container);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  document.body.appendChild(backdrop);
}
