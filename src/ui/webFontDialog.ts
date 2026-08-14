/**
 * "Add a font from the web" — search Google's families, or paste a URL to any
 * font file.
 *
 * The two halves share an ending: whichever route is used, the font's bytes are
 * downloaded, registered like a font loaded off disk, and embedded into the
 * .rcam on save. Nothing here depends on the network once the font is in.
 *
 * The list previews each family in its own face, which is the one place a WOFF2
 * is welcome — the browser renders those rows, not opentype.js, and it will
 * happily do what this app's font parser cannot.
 */

import {
  loadCatalogue,
  searchFamilies,
  variantUrl,
  variantName,
  previewCssUrl,
  addFontFromUrl,
  normalizeFontUrl,
  type CatalogueFamily,
  type FontCatalogue,
} from "../core/webFonts";
import { registerModal } from "./modal";
import { toast } from "./toast";

/**
 * Families appended per batch as the list is scrolled.
 *
 * This used to be the TOTAL the dialog would ever show, which is why browsing
 * alphabetically stopped in the "A"s with 2,022 families in the catalogue: the
 * search box was the only way past it, so you had to already know the name of
 * the font you wanted. Now it is a page size — scrolling loads the next batch.
 *
 * It stays a batch rather than "render everything" because each rendered family
 * is previewed in its own face, and the preview stylesheet names every family in
 * the batch. Rendering all 2,022 at once would ask Google for 2,022 families in
 * one request. Batching keeps the download proportional to what has actually
 * been looked at.
 */
const PAGE = 60;

/** Distance from the bottom of the list, in px, that triggers the next batch. */
const LOAD_AHEAD_PX = 240;

/** Debounce before re-rendering: each render costs a preview stylesheet fetch. */
const SEARCH_DEBOUNCE_MS = 180;

export function openWebFontDialog(onAdded: (fontId: string) => void): void {
  const backdrop = document.createElement("div");
  backdrop.className = "tp-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog";
  dialog.style.width = "520px";
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const h3 = document.createElement("h3");
  h3.textContent = "Add a font from the web";
  const closeBtn = document.createElement("button");
  closeBtn.className = "tp-dialog-close";
  closeBtn.textContent = "✕";
  hdr.append(h3, closeBtn);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  body.style.cssText = "display:flex;flex-direction:column;gap:10px;";

  // --- search -------------------------------------------------------------
  const search = document.createElement("input");
  search.type = "text";
  search.className = "dim";
  search.placeholder = "Search Google Fonts…";
  search.style.width = "100%";
  body.appendChild(search);

  const list = document.createElement("div");
  list.style.cssText =
    "height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;";
  body.appendChild(list);

  const note = document.createElement("div");
  note.style.cssText = "font-size:11px;opacity:0.7;";
  note.textContent =
    "Previews are rendered by Google Fonts. The font you pick is downloaded and saved inside your project, so it still cuts offline.";
  body.appendChild(note);

  // --- any font by URL ----------------------------------------------------
  const urlRow = document.createElement("div");
  urlRow.style.cssText =
    "display:flex;gap:8px;align-items:center;border-top:1px solid var(--border);padding-top:10px;";
  const urlLbl = document.createElement("label");
  urlLbl.textContent = "Or a URL";
  urlLbl.style.cssText = "font-size:12px;white-space:nowrap;";
  const urlInp = document.createElement("input");
  urlInp.type = "text";
  urlInp.className = "dim";
  urlInp.placeholder = "https://…/MyFont.ttf";
  urlInp.style.flex = "1";
  const urlBtn = document.createElement("button");
  urlBtn.className = "btn";
  urlBtn.textContent = "Add";
  urlRow.append(urlLbl, urlInp, urlBtn);
  body.appendChild(urlRow);

  dialog.append(hdr, body);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  // --- preview stylesheets -------------------------------------------------
  // One <link> per BATCH, accumulated as the list is scrolled — an earlier
  // batch's link has to stay, or the rows already on screen lose their preview
  // face the moment the next batch loads. All of them are dropped when the
  // search changes or the dialog closes, so browsing leaves no trail in <head>.
  let previewLinks: HTMLLinkElement[] = [];
  const clearPreviewFonts = () => {
    for (const l of previewLinks) l.remove();
    previewLinks = [];
  };
  const addPreviewFonts = (families: string[]) => {
    if (families.length === 0) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = previewCssUrl(families);
    document.head.appendChild(link);
    previewLinks.push(link);
  };

  let unregister: () => void = () => {};
  const close = () => {
    clearPreviewFonts();
    clearTimeout(searchTimer);
    unregister();
    backdrop.remove();
  };
  closeBtn.addEventListener("click", close);

  // --- adding --------------------------------------------------------------
  let adding = false;
  const add = async (url: string, name: string): Promise<void> => {
    if (adding) return;
    adding = true;
    try {
      const res = await addFontFromUrl(url, name);
      if (!res.embeddable) {
        // Same rule as a font loaded off disk: we must not redistribute it, so
        // say plainly that the design won't carry it.
        toast(
          `"${res.name}" added — but its license forbids embedding, so it won't be saved into the project file.`,
          5000,
        );
      } else {
        toast(`Added "${res.name}".`);
      }
      onAdded(res.id);
      close();
    } catch (e) {
      toast((e as Error).message, 5000);
    } finally {
      adding = false;
    }
  };

  // --- list rendering ------------------------------------------------------
  const message = (text: string) => {
    list.replaceChildren();
    const d = document.createElement("div");
    d.style.cssText = "padding:16px;font-size:12px;opacity:0.7;";
    d.textContent = text;
    list.appendChild(d);
  };

  // --- catalogue -----------------------------------------------------------
  let catalogue: FontCatalogue | null = null;
  let searchTimer: ReturnType<typeof setTimeout>;
  /** Every family matching the current query, ranked. Sliced for display. */
  let matches: CatalogueFamily[] = [];
  /** How many of `matches` are currently in the list. */
  let shown = 0;

  /** Footer line inside the list: how far in you are, or that you're at the end. */
  const tail = document.createElement("div");
  tail.style.cssText = "padding:10px 16px;font-size:11px;opacity:0.65;text-align:center;";

  const appendBatch = () => {
    if (!catalogue || shown >= matches.length) return;
    const batch = matches.slice(shown, shown + PAGE);
    tail.remove(); // keep it last
    for (const fam of batch) list.appendChild(familyRow(catalogue, fam, add));
    shown += batch.length;
    addPreviewFonts(batch.map((f) => f.n));
    tail.textContent =
      shown >= matches.length
        ? `${matches.length} ${matches.length === 1 ? "family" : "families"}`
        : `${shown} of ${matches.length} — scroll for more`;
    list.appendChild(tail);
  };

  const rerender = () => {
    if (!catalogue) return;
    clearPreviewFonts();
    list.replaceChildren();
    shown = 0;
    // Infinity, then slice locally. Re-querying with a growing limit would also
    // be correct — `searchFamilies` returns a stable prefix — but the true total
    // is what lets the footer say "60 of 2022" instead of "60 of at least 60",
    // and one pass over 2,022 entries costs nothing.
    matches = searchFamilies(catalogue, search.value, Number.POSITIVE_INFINITY);
    if (matches.length === 0) {
      message("No families match that search.");
      return;
    }
    appendBatch();
    // A short list may not fill the box, so nothing would ever scroll — keep
    // going until it does, or until everything is shown.
    fillViewport();
  };

  /** Append batches until the list actually overflows, so scrolling can start. */
  const fillViewport = () => {
    let guard = 0;
    while (
      shown < matches.length &&
      list.scrollHeight <= list.clientHeight &&
      guard++ < 40 // never spin: happy-dom and a zero-height box both report 0
    ) {
      appendBatch();
    }
  };

  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_AHEAD_PX) appendBatch();
  });

  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rerender, SEARCH_DEBOUNCE_MS);
  });

  urlBtn.addEventListener("click", () => {
    const url = normalizeFontUrl(urlInp.value);
    if (!url) {
      toast("That doesn't look like a font address — it should start with http:// or https://.");
      return;
    }
    const name = decodeURIComponent(url.split("/").pop() ?? "Web font").replace(/\.[^.]+$/, "");
    void add(url, name);
  });
  urlInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") urlBtn.click();
  });

  message("Loading the font list…");
  loadCatalogue()
    .then((cat) => {
      catalogue = cat;
      rerender();
    })
    .catch(() => {
      // The catalogue ships with the app, so this is a genuinely offline session
      // (or a stale service worker). The URL box below still works if they have
      // a direct link, so say that rather than just failing.
      message("Couldn't load the font list — check your connection. A direct font URL still works.");
    });

  unregister = registerModal(backdrop, close);
  search.focus();
}

/** One family: its name previewed in its own face, plus a style picker. */
function familyRow(
  cat: FontCatalogue,
  fam: CatalogueFamily,
  add: (url: string, name: string) => Promise<void>,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "webfont-row";
  row.style.cssText =
    "display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border);";
  row.addEventListener("mouseenter", () => {
    row.style.background = "var(--hover, rgba(127,127,127,0.12))";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "";
  });

  const label = document.createElement("div");
  label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;";
  // Quoted family name plus a generic fallback, so the row is readable as plain
  // text while the preview stylesheet is still in flight (or never arrives).
  label.style.fontFamily = `"${fam.n}", ${cssFallback(fam.c)}`;
  label.textContent = fam.n;

  const cat_ = document.createElement("div");
  cat_.style.cssText = "font-size:11px;opacity:0.6;white-space:nowrap;";
  cat_.textContent = fam.c;

  row.append(label, cat_);

  // A style picker only where there's a choice to make. A variable font is one
  // file, so its family offers a single entry and the picker would be noise.
  let variantIndex = 0;
  if (fam.v.length > 1) {
    const sel = document.createElement("select");
    sel.className = "dim";
    sel.style.cssText = "font-size:11px;max-width:130px;";
    fam.v.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = v.s;
      sel.appendChild(opt);
    });
    // The select lives inside a clickable row; without this, opening it adds
    // the font.
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", () => {
      variantIndex = Number(sel.value);
    });
    row.appendChild(sel);
  }

  row.addEventListener("click", () => {
    const variant = fam.v[variantIndex];
    void add(variantUrl(cat, variant), variantName(fam, variant));
  });
  return row;
}

/** A generic CSS family to stand in until the preview face loads. */
function cssFallback(category: string): string {
  if (category === "serif") return "serif";
  if (category === "monospace") return "monospace";
  if (category === "handwriting" || category === "display") return "cursive";
  return "sans-serif";
}
