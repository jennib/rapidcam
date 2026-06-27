/**
 * Shows a subtle one-line share prompt after G-code export, throttled so it
 * appears only every Nth export (currently every 3rd) rather than nagging on
 * every single download.
 *
 * The prompt is a non-blocking banner at the bottom of the screen — it doesn't
 * interrupt workflow — and includes a share URL, a copy button, and a dismiss
 * button. Once dismissed it won't reappear until the counter ticks past another
 * N exports.
 */

import { StorageKeys } from "../core/storageKeys";
import { copyToClipboard } from "./clipboard";

/** How many exports to wait between showing the prompt. */
const THROTTLE_N = 3;

function getCounter(): number {
    try {
        const raw = localStorage.getItem(StorageKeys.sharePromptCounter);
        return raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    } catch {
        return 0;
    }
}

function setCounter(v: number): void {
    try {
        localStorage.setItem(StorageKeys.sharePromptCounter, String(v));
    } catch {
        /* private mode — silent */
    }
}

/** Call after every G-code export. Shows a prompt every THROTTLE_N exports. */
export function maybeShowSharePrompt(): void {
    const c = getCounter() + 1;
    setCounter(c);

    if (c % THROTTLE_N !== 0) return;

    // Don't stack multiple banners
    if (document.getElementById("rapidcam-share-prompt")) return;

    const shareUrl = "https://rapidcam.app";

    const banner = document.createElement("div");
    banner.id = "rapidcam-share-prompt";
    banner.setAttribute("role", "status");
    banner.style.cssText = [
        "position:fixed", "bottom:16px", "left:50%", "transform:translateX(-50%)",
        "z-index:10000", "background:var(--panel, #26282f)", "color:var(--text, #d7dae0)",
        "border:1px solid var(--border, #3a3d47)", "border-radius:8px", "padding:8px 14px",
        "box-shadow:0 4px 16px rgba(0,0,0,0.4)", "font:13px/1.5 system-ui,sans-serif",
        "display:flex", "gap:10px", "align-items:center", "flex-wrap:wrap",
        "max-width:min(600px, calc(100vw - 32px))",
        "animation:rapidcam-share-fade-in 0.3s ease",
    ].join(";");

    // Inject the keyframe once if not already present
    if (!document.getElementById("rapidcam-share-style")) {
        const style = document.createElement("style");
        style.id = "rapidcam-share-style";
        style.textContent =
            "@keyframes rapidcam-share-fade-in { from { opacity:0; transform:translateX(-50%) translateY(8px); }" +
            " to { opacity:1; transform:translateX(-50%) translateY(0); } }";
        document.head.appendChild(style);
    }

    const text = document.createElement("span");
    text.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    text.textContent = "Enjoying RapidCAM? Share it:";

    const link = document.createElement("span");
    link.style.cssText =
        "color:var(--accent, #4aa3ff);font-family:monospace;font-size:12px;" +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;";
    link.textContent = "rapidcam.app";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy link";
    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "✕";
    dismissBtn.title = "Dismiss";

    for (const b of [copyBtn, dismissBtn]) {
        b.style.cssText = [
            "padding:4px 10px", "border-radius:6px", "border:1px solid var(--border, #3a3d47)",
            "cursor:pointer", "font:inherit", "white-space:nowrap", "font-size:12px",
        ].join(";");
    }
    const accent = "var(--accent, #4aa3ff)";
    copyBtn.style.background = accent;
    copyBtn.style.color = "#fff";
    copyBtn.style.borderColor = accent;
    dismissBtn.style.background = "transparent";
    dismissBtn.style.color = "var(--text-dim, #8b909c)";

    copyBtn.addEventListener("click", () => {
        copyToClipboard(shareUrl);
        copyBtn.textContent = "Copied!";
        copyBtn.style.background = "#2d8a4e";
        copyBtn.style.borderColor = "#2d8a4e";
        setTimeout(() => {
            copyBtn.textContent = "Copy link";
            copyBtn.style.background = accent;
            copyBtn.style.borderColor = accent;
        }, 2000);
    });

    const close = () => {
        banner.style.opacity = "0";
        banner.style.transition = "opacity 0.2s ease";
        setTimeout(() => banner.remove(), 200);
    };
    dismissBtn.addEventListener("click", close);

    // Auto-dismiss after 12 seconds
    const autoTimer = setTimeout(close, 12000);
    banner.addEventListener("mouseenter", () => clearTimeout(autoTimer));
    banner.addEventListener("mouseleave", () => {
        // Re-arm a shorter timer once the user moves away
        const t = setTimeout(close, 6000);
        banner.addEventListener("mouseenter", () => clearTimeout(t), { once: true });
    });

    banner.appendChild(text);
    banner.appendChild(link);
    banner.appendChild(copyBtn);
    banner.appendChild(dismissBtn);
    document.body.appendChild(banner);
}