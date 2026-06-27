/**
 * A small dialog that gives people an easy way to share RapidCAM with a friend.
 * Puts the link front-and-centre with a one-click copy button, plus social
 * share links (Twitter/X, Facebook, Reddit, email) that open in a new tab.
 */

import { copyToClipboard } from "./clipboard";

const SHARE_URL = "https://rapidcam.app";
const SHARE_TITLE = "RapidCAM — Free Browser-Based CAD/CAM for Desktop CNC";
const SHARE_TEXT =
    "I'm using RapidCAM to design parts and generate G-code — it's free, open-source, and runs in the browser. No install, no account:";

/** Open a share URL in a popup window (for social platforms that support it). */
function sharePopup(url: string): void {
    window.open(
        url,
        "rapidcam-share",
        "width=600,height=400,noopener,noreferrer",
    );
}

function shareTwitter(): void {
    const u = `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`;
    sharePopup(u);
}

function shareFacebook(): void {
    const u = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}`;
    sharePopup(u);
}

function shareReddit(): void {
    const u = `https://www.reddit.com/submit?url=${encodeURIComponent(SHARE_URL)}&title=${encodeURIComponent(SHARE_TITLE)}`;
    sharePopup(u);
}

function shareEmail(): void {
    const subject = encodeURIComponent(SHARE_TITLE);
    const body = encodeURIComponent(`${SHARE_TEXT}\n\n${SHARE_URL}`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

const PLATFORMS: { name: string; icon: string; action: () => void }[] = [
    {
        name: "Twitter / X",
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
        action: shareTwitter,
    },
    {
        name: "Facebook",
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
        action: shareFacebook,
    },
    {
        name: "Reddit",
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.372 0 0 5.373 0 12s5.372 12 12 12 12-5.373 12-12S18.628 0 12 0zm5.084 12.788c-.532 0-.97.438-.97.97 0 .447.303.813.719.926a3.44 3.44 0 01-1.65 1.646c-.487.262-1.096.5-1.975.56a2.33 2.33 0 01-.024-.12 2.363 2.363 0 00-2.364-2.364 2.363 2.363 0 00-2.364 2.364c0 .04.004.08.006.12-.88-.06-1.489-.298-1.975-.56a3.44 3.44 0 01-1.65-1.646c.416-.113.719-.479.719-.926 0-.531-.438-.97-.97-.97a.968.968 0 00-.97.97c0 .637.613 1.152 1.332 1.152.084 0 .163-.018.243-.026.334 1.47 1.697 2.604 3.633 2.604s3.3-1.133 3.634-2.604c.08.008.158.026.242.026a1.15 1.15 0 001.152-1.152.97.97 0 00-.97-.97zm-10.129.97a.325.325 0 01.324-.324.323.323 0 01.323.324.323.323 0 01-.323.323.323.323 0 01-.324-.323zm5.341 2.034c-.524 0-.95-.426-.95-.95 0-.524.426-.95.95-.95.524 0 .95.426.95.95 0 .524-.426.95-.95.95zm4.455-2.034a.323.323 0 01-.323-.323.323.323 0 01.323-.323.325.325 0 01.324.323.325.325 0 01-.324.323z"/></svg>`,
        action: shareReddit,
    },
    {
        name: "Email",
        icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
        action: shareEmail,
    },
];

export function showShareDialog(): void {
    const existing = document.getElementById("share-dialog-backdrop");
    if (existing) { existing.remove(); return; }

    const backdrop = document.createElement("div");
    backdrop.id = "share-dialog-backdrop";
    backdrop.className = "welcome-backdrop";
    backdrop.style.zIndex = "9999";

    const container = document.createElement("div");
    container.className = "about-dialog";
    container.style.maxWidth = "420px";

    const closeBtn = document.createElement("button");
    closeBtn.className = "about-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => backdrop.remove());

    const title = document.createElement("h2");
    title.style.cssText = "margin:0 0 8px 0;font-size:18px;text-align:center;";
    title.textContent = "Share RapidCAM";

    const desc = document.createElement("p");
    desc.style.cssText = "text-align:center;font-size:13px;color:var(--text-dim);margin:0 0 16px 0;";
    desc.textContent = "Help spread the word — every share makes a difference!";

    // Link + copy row
    const linkRow = document.createElement("div");
    linkRow.style.cssText =
        "display:flex;gap:6px;align-items:center;background:var(--panel);" +
        "border:1px solid var(--border);border-radius:8px;padding:4px 4px 4px 12px;margin-bottom:16px;";

    const linkInput = document.createElement("input");
    linkInput.type = "text";
    linkInput.readOnly = true;
    linkInput.value = SHARE_URL;
    linkInput.style.cssText =
        "flex:1;background:transparent;border:none;color:var(--accent);" +
        "font-family:monospace;font-size:13px;outline:none;min-width:0;";
    linkInput.addEventListener("click", () => linkInput.select());

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.textContent = "Copy";
    copyBtn.style.cssText = "white-space:nowrap;padding:6px 14px;";
    copyBtn.addEventListener("click", () => {
        copyToClipboard(SHARE_URL);
        copyBtn.textContent = "Copied!";
        copyBtn.style.background = "#2d8a4e";
        copyBtn.style.color = "#fff";
        setTimeout(() => {
            copyBtn.textContent = "Copy";
            copyBtn.style.background = "";
            copyBtn.style.color = "";
        }, 2000);
    });

    linkRow.appendChild(linkInput);
    linkRow.appendChild(copyBtn);

    // Social share buttons
    const socialLabel = document.createElement("p");
    socialLabel.style.cssText =
        "text-align:center;font-size:11px;color:var(--text-dim);" +
        "text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px 0;";
    socialLabel.textContent = "Share via";

    const socialRow = document.createElement("div");
    socialRow.style.cssText =
        "display:flex;gap:8px;justify-content:center;flex-wrap:wrap;";

    for (const p of PLATFORMS) {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.title = p.name;
        btn.style.cssText =
            "display:flex;align-items:center;justify-content:center;" +
            "width:44px;height:44px;border-radius:8px;padding:0;";
        btn.innerHTML = p.icon;
        btn.addEventListener("click", p.action);
        socialRow.appendChild(btn);
    }

    // Buy me a coffee link
    const bmc = document.createElement("a");
    bmc.href = "https://www.buymeacoffee.com/jennibm";
    bmc.target = "_blank";
    bmc.rel = "noopener noreferrer";
    bmc.style.cssText =
        "display:block;text-align:center;margin-top:16px;font-size:13px;" +
        "color:var(--accent);text-decoration:none;";
    bmc.textContent = "☕ Or buy me a coffee to support development";

    container.appendChild(closeBtn);
    container.appendChild(title);
    container.appendChild(desc);
    container.appendChild(linkRow);
    container.appendChild(socialLabel);
    container.appendChild(socialRow);
    container.appendChild(bmc);
    backdrop.appendChild(container);

    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);

    // Select the URL on show so it's ready to copy with Ctrl+C
    setTimeout(() => linkInput.select(), 50);
}