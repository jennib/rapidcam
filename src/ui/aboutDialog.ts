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
  version.textContent = "Version 0.1.0  ·  © 2026 RapidCAM";

  const bmc = document.createElement("a");
  bmc.href = "https://www.buymeacoffee.com/jennibm";
  bmc.target = "_blank";
  bmc.rel = "noopener noreferrer";
  bmc.className = "bmc-button";
  bmc.innerHTML = `<img src="https://cdn.buymeacoffee.com/buttons/bmc-new-btn-logo.svg" alt="☕"> Buy me a coffee`;

  container.appendChild(closeBtn);
  container.appendChild(logo);
  container.appendChild(desc);
  container.appendChild(version);
  container.appendChild(bmc);
  backdrop.appendChild(container);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  document.body.appendChild(backdrop);
}
