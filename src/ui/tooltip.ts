/**
 * One shared tooltip for `[data-tip]` elements (the tool palette and the
 * design-tree toggle). Replaces the CSS-only `.tool-btn::after` tooltip, which
 * appeared instantly, had no arrow, and sat at a fixed `left: 48px` that could
 * clip near the viewport edge.
 *
 * A single fixed element, event-delegated so it also covers buttons added
 * later, with a short delay so it does not flicker as the pointer sweeps a
 * column of buttons. It appears to the right of the trigger (the palette sits
 * on the left), flips to the left near the right edge, and clamps vertically.
 */

const DELAY = 300;

let tipEl: HTMLElement | null = null;
let timer: number | null = null;
let current: HTMLElement | null = null;

function getTip(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "ui-tooltip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.style.display = "none";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hide(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  current = null;
  if (tipEl) tipEl.style.display = "none";
}

function show(target: HTMLElement): void {
  const text = target.dataset.tip ?? target.getAttribute("aria-label") ?? "";
  if (!text) {
    hide();
    return;
  }

  const el = getTip();
  el.textContent = text;
  el.style.display = "block";

  const r = target.getBoundingClientRect();
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const gap = 8;

  // Prefer the right of the trigger; flip left near the right edge, and clamp
  // vertically to the viewport.
  let left = r.right + gap;
  if (left + tw > window.innerWidth - 4) left = r.left - tw - gap;
  left = Math.max(4, left);

  let top = r.top + r.height / 2 - th / 2;
  top = Math.max(4, Math.min(top, window.innerHeight - th - 4));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function schedule(target: HTMLElement, immediate = false): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  current = target;
  const run = () => {
    if (current === target) show(target);
  };
  if (immediate) run();
  else timer = window.setTimeout(run, DELAY);
}

/** Install the delegated tooltip. Idempotent. */
export function initTooltips(): void {
  if (tipEl) return;
  getTip();

  document.addEventListener("mouseover", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]");
    if (t instanceof HTMLElement) schedule(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]");
    if (t instanceof HTMLElement && t === current) hide();
  });
  document.addEventListener("focusin", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]");
    if (t instanceof HTMLElement) schedule(t, true);
  });
  document.addEventListener("focusout", () => hide());
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}