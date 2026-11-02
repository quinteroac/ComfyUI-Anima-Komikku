import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el, button, section, field, corners, drawPanels, installUndoGuard, parseLayout, installCss, PAGE_ICON } from "./page_layout_editor.js";
import { assistPanel, generateText } from "./text_assist.js";

const NODE_CLASS = "AnimaKomikkuPageCompose";
const HISTORY_LIMIT = 60;
const UPLOAD_FOLDER = "komikku";

const FONTS = [
    ["Comic", "'Comic Neue', 'Comic Sans MS', 'Chalkboard SE', 'Noto Sans', 'DejaVu Sans', sans-serif"],
    ["Sans", "Inter, 'Helvetica Neue', Arial, 'Liberation Sans', 'Noto Sans', sans-serif"],
    ["Serif", "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif"],
    ["Handwritten", "'Segoe Print', 'Bradley Hand', 'Patrick Hand', 'Comic Sans MS', sans-serif"],
    ["Impact", "Impact, Anton, 'Arial Black', 'Liberation Sans Narrow', 'Nimbus Sans Narrow', sans-serif"],
    ["Japanese", "'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic', 'Hiragino Sans', IPAGothic, sans-serif"],
    ["Mono", "ui-monospace, Menlo, monospace"],
];

// Lettering types. Sizes are font pixels per 1000 px of page width, so the text scales with page_width.
export const TEXT_TYPES = {
    speech: { name: "Speech", tail: true, shape: true, defaults: { size: 34, font: "Comic" } },
    thought: { name: "Thought", tail: true, shape: true, defaults: { size: 32, font: "Comic", italic: true } },
    shout: { name: "Shout", tail: true, shape: true, defaults: { size: 40, font: "Impact", bold: true, border: 4 } },
    whisper: { name: "Whisper", tail: true, shape: true, defaults: { size: 28, font: "Comic", border: 2.5 } },
    rounded: { name: "Box", tail: true, shape: true, defaults: { size: 30, font: "Sans" } },
    caption: { name: "Caption", tail: false, shape: true, defaults: { size: 26, font: "Serif", fill: "#fff8dc", border: 2.5 } },
    sfx: { name: "SFX", tail: false, shape: false, defaults: { size: 90, font: "Impact", bold: true, color: "#111111", outline: 7, outlineColor: "#ffffff", rotation: -8 } },
    text: { name: "Text", tail: false, shape: false, defaults: { size: 30, font: "Sans" } },
};

const TYPE_ICONS = {
    speech: `<path d="M12 4c5 0 9 3 9 7s-4 7-9 7c-1 0-2 0-3-.3L4 20l1.5-4C4 14.8 3 13 3 11c0-4 4-7 9-7Z"/>`,
    thought: `<path d="M7 15a4 4 0 0 1-.6-7.9A5 5 0 0 1 16 6a4 4 0 0 1 1.5 8.4A3.5 3.5 0 0 1 12 15.5 4 4 0 0 1 7 15Z"/><circle cx="6" cy="19" r="1.4"/><circle cx="3.5" cy="21.5" r=".8"/>`,
    shout: `<path d="m12 2 2 4 4-2-1 4.5 4.5 1-3.5 3 3 3.5-4.5.5.5 4.5-4-2.5-2 4-1.5-4.2-4.3 1.7 1.3-4.3L2 13.5l3.6-2.4L3 7.5l4.5.3L8 3.5l3 2.6Z"/>`,
    whisper: `<ellipse cx="12" cy="11" rx="9" ry="7" stroke-dasharray="3 2.5"/>`,
    rounded: `<rect x="3" y="4" width="18" height="13" rx="4"/><path d="m8 17-2 4 5-4"/>`,
    caption: `<rect x="3" y="6" width="18" height="12"/><path d="M7 10h10M7 14h7"/>`,
    sfx: `<path d="M4 17 7 6l3 8 2-5 2 6 3-9 3 11"/>`,
    text: `<path d="M5 6h14M12 6v13M9 19h6"/>`,
};

const CSS = `
.akpc .akpe-num { display: none; }
.akpc .akpe-panel { cursor: grab; }
.akpc .akpe-panel.empty, .akpc .akpe-panel { background: #fff; }
.akpc .akpe-panel span { color: #b3ad9f; font-style: italic; }
.akpc .akpe-lines polygon { stroke-width: var(--bw, 2.2px); }
.akpc .akpe-page { cursor: default; }
.akpc-shot { position: absolute; max-width: none; pointer-events: none; user-select: none; }
.akpc-ov { position: absolute; max-width: none; user-select: none; cursor: move; }
.akpc-letter { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; }
.akpc-sel { position: absolute; border: 1.5px dashed var(--pe-accent); pointer-events: none; z-index: 6; }
.akpc-h { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #fff; border: 2px solid var(--pe-accent); border-radius: 3px; pointer-events: auto; }
.akpc-rot { position: absolute; left: 50%; top: -30px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: var(--pe-accent); pointer-events: auto; cursor: grab; }
.akpc-rot::after { content: ""; position: absolute; left: 6px; top: 14px; width: 1.5px; height: 16px; background: var(--pe-accent); }
.akpc-tail { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: var(--pe-blue); border: 2px solid #fff; z-index: 7; cursor: move; }
.akpc-banner { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); padding: 7px 14px; border-radius: 8px; background: rgba(14,16,22,.92); border: 1px solid var(--pe-line); color: var(--pe-muted); z-index: 8; white-space: nowrap; }
.akpc-types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.akpc-types .akpe-tpl svg { width: 26px; height: 26px; fill: none; stroke: var(--pe-fg); stroke-width: 1.5; }
.akpc-layers { display: flex; flex-direction: column; gap: 3px; }
.akpc-layers .akpe-shot i { font-size: 10px; }
.akpc-props { padding: 14px; display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.akpc-props textarea { min-height: 90px; flex: 0 0 auto; }
.akpc-range { display: flex; align-items: center; gap: 8px; }
.akpc-range input[type=range] { flex: 1; accent-color: var(--pe-accent); }
.akpc-range span { min-width: 42px; text-align: right; color: var(--pe-muted); font-size: 11.5px; }
.akpc-colors { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.akpc-colors label { display: flex; flex-direction: column; gap: 4px; color: var(--pe-muted); font-size: 11px; }
.akpc-colors input[type=color] { width: 100%; height: 30px; padding: 2px; background: var(--pe-card); border: 1px solid var(--pe-line); border-radius: 6px; }
.akpc-toggles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.akpc-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.akpc-row2 .akpe-btn, .akpc-toggles .akpe-btn { height: 32px; }
.akpc .akpe-left .akpe-hint, .akpc-props .akpe-hint { flex: none; font: 11px/1.4 Inter, system-ui, sans-serif; }
.akpc-thumbs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.akpc-thumb { position: relative; aspect-ratio: 1; border-radius: 7px; border: 1px solid var(--pe-line); cursor: pointer; overflow: hidden;
  background: repeating-conic-gradient(#2a3044 0 25%, #1b2030 0 50%) 0 0 / 12px 12px; transition: border-color .12s; }
.akpc-thumb:hover { border-color: var(--pe-blue); }
.akpc-thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.akpc-thumb button { position: absolute; top: 3px; width: 22px; height: 22px; padding: 0; border: none; border-radius: 11px; background: rgba(14,16,22,.75);
  color: #fff; cursor: pointer; font-size: 13px; line-height: 22px; opacity: .85; }
.akpc-thumb button:hover { opacity: 1; background: rgba(14,16,22,.95); }
.akpc-thumb .fav { right: 3px; }
.akpc-thumb .fav.on { color: #ffc93c; }
.akpc-thumb .drop { left: 3px; }
.akpc-thumbs-empty { grid-column: 1 / -1; color: var(--pe-muted); font-size: 11px; padding: 4px 0; }
.akpc-preview-img { max-width: 100%; max-height: 100%; box-shadow: 0 6px 18px rgba(0,0,0,.45); background: #fff; }
`;

function installComposeCss() {
    installCss();
    if (document.getElementById("akpc-style")) return;
    const style = document.createElement("style");
    style.id = "akpc-style";
    style.textContent = CSS;
    document.head.appendChild(style);
}

// `imported` only feeds the editor's thumbnails of the images imported into this page; the backend ignores it.
export function parseComposition(value) {
    const empty = { panels: [], overlays: [], texts: [], imported: [], lettering: null };
    try { return { ...empty, ...JSON.parse(value) }; } catch { return empty; }
}

// Favorite images are copied to the ComfyUI user folder (user/<user>/komikku_library) and reused across workflows.
const LIBRARY_DIR = "komikku_library";

function libraryUrl(path) {
    return api.apiURL(`/userdata/${encodeURIComponent(`${LIBRARY_DIR}/${path}`)}`);
}

async function listLibrary() {
    const files = await api.listUserDataFullInfo(LIBRARY_DIR).catch(() => []);
    return files.map((f) => f.path).filter((path) => /\.(png|jpe?g|webp)$/i.test(path)).sort();
}

function safeFileName(name) {
    return name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "") || "image.png";
}

function loadImage(url) {
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("not an image")); i.src = url; });
}

function viewUrl(ref) {
    return api.apiURL(`/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? "")}&type=${ref.type}`);
}

// Overlay and lettering files live in input/komikku and are stored as "komikku/<file>".
function inputUrl(name) {
    const i = name.lastIndexOf("/");
    return viewUrl({ filename: name.slice(i + 1), subfolder: name.slice(0, Math.max(0, i)), type: "input" });
}

async function uploadImage(blob, filename) {
    const body = new FormData();
    body.append("image", blob, filename);
    body.append("subfolder", UPLOAD_FOLDER);
    body.append("type", "input");
    body.append("overwrite", "true");
    const res = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const data = await res.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

function uid() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }

export function newText(type, x, y) {
    const t = {
        id: uid(), type, text: "", x, y, w: 0.3, h: 0.12, rotation: 0, font: "Comic", size: 34, bold: false, italic: false, vertical: false,
        color: "#111111", fill: "#ffffff", fillOpacity: 1, stroke: "#111111", border: 3, outline: 0, outlineColor: "#ffffff", tail: null,
        ...TEXT_TYPES[type].defaults,
    };
    if (type === "sfx" || type === "text") { t.w = 0.32; t.h = 0.1; }
    if (TEXT_TYPES[type].tail) t.tail = { x: x + t.w * 0.3, y: y + t.h * 1.6 };
    return t;
}

// Fonts the user installs live in the ComfyUI user folder (user/<user>/komikku_fonts) and are loaded into the page with FontFace.
// The family name is the file name without its extension.
const FONT_DIR = "komikku_fonts";
const FONT_TYPES = ["ttf", "otf", "woff", "woff2"];
let installedFonts = [];
let fontsLoaded = null;

function fontFamilyName(file) {
    return file.replace(/\.[^.]+$/, "").replace(/["'\\]/g, "").trim();
}

async function registerFont(family, data) {
    const face = new FontFace(family, data);
    await face.load();
    document.fonts.add(face);
}

export function loadInstalledFonts() {
    fontsLoaded ??= (async () => {
        const files = await api.listUserDataFullInfo(FONT_DIR).catch(() => []);
        for (const { path } of files) {
            if (!FONT_TYPES.includes(path.split(".").pop().toLowerCase())) continue;
            const family = fontFamilyName(path.split("/").pop());
            try {
                const res = await api.getUserData(`${FONT_DIR}/${path}`);
                await registerFont(family, await res.arrayBuffer());
                installedFonts.push({ family, path });
            } catch (err) {
                console.warn(`[Komikku] font ${path} could not be loaded:`, err);
            }
        }
    })();
    return fontsLoaded;
}

export function fontString(t, px) {
    const stack = FONTS.find((f) => f[0] === t.font)?.[1] ?? `'${t.font}', sans-serif`;
    return `${t.italic ? "italic " : ""}${t.bold ? "bold " : ""}${px}px ${stack}`;
}

function wrapLines(ctx, text, width) {
    const lines = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (!line || ctx.measureText(`${line} ${word}`).width <= width) { line = line ? `${line} ${word}` : word; continue; }
            lines.push(line);
            line = word;
        }
        lines.push(line);
    }
    return lines;
}

// Vertical (tategaki) text: one character per row, columns read right to left.
function verticalColumns(text, perColumn) {
    const cols = [];
    for (const paragraph of text.split("\n")) {
        const chars = [...paragraph.replace(/\s+/g, "")];
        if (!chars.length) { cols.push([]); continue; }
        for (let i = 0; i < chars.length; i += perColumn) cols.push(chars.slice(i, i + perColumn));
    }
    return cols;
}

function bubblePath(ctx, t, rx, ry, tail, k) {
    const angle = tail ? Math.atan2(tail[1] / ry, tail[0] / rx) : 0;
    const gap = 0.22;
    ctx.beginPath();
    if (t.type === "caption") ctx.rect(-rx, -ry, 2 * rx, 2 * ry);
    else if (t.type === "rounded") {
        ctx.roundRect(-rx, -ry, 2 * rx, 2 * ry, Math.min(rx, ry) * 0.45);
        if (tail) {
            // Tail drawn as a separate wedge from the box edge toward the tip.
            const bx = Math.max(-rx * 0.6, Math.min(rx * 0.6, tail[0] * 0.4)), by = Math.sign(tail[1] || 1) * ry;
            ctx.moveTo(bx - rx * 0.12, by * 0.92);
            ctx.lineTo(tail[0], tail[1]);
            ctx.lineTo(bx + rx * 0.12, by * 0.92);
        }
    } else if (t.type === "shout") {
        const n = 26;
        for (let i = 0; i <= 2 * n; i++) {
            const a = (tail ? angle + gap : 0) + (2 * Math.PI - (tail ? 2 * gap : 0)) * i / (2 * n);
            const r = i % 2 ? 0.8 + 0.06 * Math.sin(i * 1.7) : 1.05;
            i ? ctx.lineTo(rx * r * Math.cos(a), ry * r * Math.sin(a)) : ctx.moveTo(rx * r * Math.cos(a), ry * r * Math.sin(a));
        }
        if (tail) ctx.lineTo(tail[0], tail[1]);
        ctx.closePath();
    } else if (t.type === "thought") {
        for (let i = 0; i <= 160; i++) {
            const a = i * Math.PI / 80, r = 0.93 + 0.08 * Math.abs(Math.sin(a * 5));
            i ? ctx.lineTo(rx * r * Math.cos(a), ry * r * Math.sin(a)) : ctx.moveTo(rx * r * Math.cos(a), ry * r * Math.sin(a));
        }
        ctx.closePath();
    } else {
        ctx.ellipse(0, 0, rx, ry, 0, tail ? angle + gap : 0, tail ? angle + 2 * Math.PI - gap : 2 * Math.PI);
        if (tail) ctx.lineTo(tail[0], tail[1]);
        ctx.closePath();
    }
    if (t.type === "whisper") ctx.setLineDash([6 * k, 5 * k]);
}

// Draws one lettering item on a canvas of W x H pixels (editor view and the exported layer use the same code).
function drawText(ctx, t, W, H) {
    const k = W / 1000;
    const w = t.w * W, h = t.h * H, cx = t.x * W + w / 2, cy = t.y * H + h / 2;
    const rot = (t.rotation || 0) * Math.PI / 180;
    const spec = TEXT_TYPES[t.type];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    let tail = null;
    if (spec.tail && t.tail) {
        const dx = t.tail.x * W - cx, dy = t.tail.y * H - cy;
        const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot), ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
        if (Math.hypot(lx / (w / 2), ly / (h / 2)) > 1.05) tail = [lx, ly];
    }
    if (spec.shape) {
        // fillOpacity fades the box (background, border and tail); the text is drawn solid.
        ctx.globalAlpha = t.fillOpacity ?? 1;
        bubblePath(ctx, t, w / 2, h / 2, t.type === "thought" ? null : tail, k);
        ctx.fillStyle = t.fill;
        ctx.fill();
        if (t.border > 0) {
            ctx.lineWidth = t.border * k;
            ctx.strokeStyle = t.stroke;
            ctx.lineJoin = "round";
            ctx.stroke();
        }
        ctx.setLineDash([]);
        if (t.type === "thought" && tail) {
            const a = Math.atan2(tail[1] / (h / 2), tail[0] / (w / 2));
            const ax = (w / 2) * Math.cos(a), ay = (h / 2) * Math.sin(a);
            for (const [f, r] of [[0.3, 0.09], [0.62, 0.06], [0.92, 0.035]]) {
                ctx.beginPath();
                ctx.arc(ax + (tail[0] - ax) * f, ay + (tail[1] - ay) * f, Math.min(w, h) * r, 0, 2 * Math.PI);
                ctx.fillStyle = t.fill;
                ctx.fill();
                if (t.border > 0) ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }
    const boxy = ["caption", "rounded"].includes(t.type);
    const tw = w * (spec.shape ? (boxy ? 0.86 : 0.7) : 0.98), th = h * (spec.shape ? (boxy ? 0.8 : 0.66) : 0.98);
    let fs = Math.max(1, t.size * k);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let lines, cols;
    for (;;) {
        ctx.font = fontString(t, fs);
        if (t.vertical) {
            cols = verticalColumns(t.text, Math.max(1, Math.floor(th / (fs * 1.08))));
            if (cols.length * fs * 1.2 <= tw || fs <= 4) break;
        } else {
            lines = wrapLines(ctx, t.text, tw);
            if ((lines.length * fs * 1.18 <= th && lines.every((l) => ctx.measureText(l).width <= tw)) || fs <= 4) break;
        }
        fs *= 0.92;
    }
    const glyphs = t.vertical
        ? cols.flatMap((col, c) => col.map((ch, r) => [ch, ((cols.length - 1) / 2 - c) * fs * 1.2, (r - (col.length - 1) / 2) * fs * 1.08]))
        : lines.map((line, i) => [line, 0, (i - (lines.length - 1) / 2) * fs * 1.18]);
    if (t.outline > 0) {
        ctx.lineWidth = t.outline * k;
        ctx.strokeStyle = t.outlineColor;
        ctx.lineJoin = "round";
        for (const [s, x, y] of glyphs) ctx.strokeText(s, x, y);
    }
    ctx.fillStyle = t.color;
    for (const [s, x, y] of glyphs) ctx.fillText(s, x, y);
    ctx.restore();
}

// Browser-side approximation of the composed page from the last run's panels, W pixels wide: the node preview
// until the next run renders the real page, and the page an agent looks at through window.animaKomikku.
export async function drawPage(layout, comp, previews, pageWidth, border, W = 900) {
    const H = Math.round(W * layout.page.height / layout.page.width);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const load = (url) => loadImage(url).catch(() => null);
    const shots = await Promise.all(layout.panels.map((_, i) => previews[i] ? load(viewUrl(previews[i])) : null));
    const overlays = await Promise.all(comp.overlays.map((ov) => load(inputUrl(ov.image))));
    const borderPx = border * W / pageWidth;
    layout.panels.forEach((p, i) => {
        ctx.save();
        ctx.beginPath();
        corners(p).forEach(([x, y], k) => (k ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
        ctx.closePath();
        ctx.clip();
        const img = shots[i];
        if (img) {
            const f = comp.panels[i] ?? { zoom: 1, dx: 0, dy: 0 };
            const bw = p.w * W, bh = p.h * H;
            const s = Math.max(bw / img.naturalWidth, bh / img.naturalHeight) * f.zoom;
            ctx.drawImage(img, p.x * W + (bw - img.naturalWidth * s) / 2 + f.dx * bw, p.y * H + (bh - img.naturalHeight * s) / 2 + f.dy * bh, img.naturalWidth * s, img.naturalHeight * s);
        }
        comp.overlays.forEach((ov, k) => {
            if (ov.panel !== i || !overlays[k]) return;
            ctx.globalAlpha = ov.opacity ?? 1;
            ctx.drawImage(overlays[k], ov.x * W, ov.y * H, ov.w * W, ov.h * H);
            ctx.globalAlpha = 1;
        });
        // Stroked inside the clip, so twice the width leaves the border inside the panel like the backend does.
        if (borderPx > 0) {
            ctx.lineWidth = 2 * borderPx;
            ctx.strokeStyle = "#000";
            ctx.stroke();
        }
        ctx.restore();
    });
    await loadInstalledFonts();
    await document.fonts.ready;
    for (const t of comp.texts) drawText(ctx, t, W, H);
    return canvas;
}

// Renders the lettering layer at the page size the backend composes and uploads it to input/komikku.
export async function exportLettering(comp, layout, pageWidth, nodeId) {
    await loadInstalledFonts();
    await document.fonts.ready;
    const H = Math.round(pageWidth * layout.page.height / layout.page.width);
    const canvas = document.createElement("canvas");
    canvas.width = pageWidth;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    for (const t of comp.texts) drawText(ctx, t, pageWidth, H);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return uploadImage(blob, `lettering_${nodeId}_${uid()}.png`);
}

function rangeInput(min, max, step, onInput, format = (v) => v) {
    const wrap = el("div", "akpc-range");
    const input = el("input");
    Object.assign(input, { type: "range", min, max, step });
    const label = el("span");
    input.addEventListener("input", () => { label.textContent = format(Number(input.value)); onInput(Number(input.value)); });
    wrap.append(input, label);
    wrap.set = (v) => { input.value = v; label.textContent = format(Number(v)); };
    return wrap;
}

class ComposeEditor {
    constructor(node, layout, value, previews, onSave) {
        this.node = node;
        this.layout = layout;
        this.comp = parseComposition(value);
        this.previews = previews;
        this.onSave = onSave;
        this.sel = null; // { kind: "panel" | "overlay" | "text", index }
        this.zoom = 1;
        this.undoStack = [];
        this.redoStack = [];
        this.drag = null;
        this.library = [];
        this.root = el("div", "akpe akpc");
        this.root.tabIndex = 0;
        this.build();
        document.body.appendChild(this.root);
        this.guardOff = installUndoGuard(() => this.root.isConnected);
        this.render();
        this.root.focus({ preventScroll: true });
        loadInstalledFonts().then(() => { if (this.root.isConnected) this.render(); });
        this.refreshLibrary();
    }

    widgetValue(name) { return this.node.widgets?.find((w) => w.name === name)?.value; }

    framing(i) {
        while (this.comp.panels.length <= i) this.comp.panels.push({ zoom: 1, dx: 0, dy: 0 });
        return this.comp.panels[i];
    }

    snapshot() {
        this.undoStack.push(JSON.stringify(this.comp));
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack = [];
    }

    restore(from, to) {
        if (!from.length) return;
        to.push(JSON.stringify(this.comp));
        this.comp = JSON.parse(from.pop());
        if (this.sel && !this.selected()) this.sel = null;
        this.render();
    }

    selected() {
        if (!this.sel) return null;
        if (this.sel.kind === "panel") return this.layout.panels[this.sel.index];
        return (this.sel.kind === "overlay" ? this.comp.overlays : this.comp.texts)[this.sel.index] ?? null;
    }

    async close(save) {
        if (save) {
            this.saveBtn.disabled = true;
            this.saveBtn.textContent = "Saving…";
            try {
                this.comp.lettering = this.comp.texts.length ? await this.exportLettering() : null;
            } catch (err) {
                this.saveBtn.disabled = false;
                this.saveBtn.textContent = "💾 Save";
                this.banner.textContent = `Could not save the lettering: ${err.message}`;
                this.banner.style.display = "";
                return;
            }
            this.onSave(JSON.stringify(this.comp), await this.renderPreview().catch(() => null));
        }
        this.resizeObserver.disconnect();
        this.root.remove();
        this.guardOff();
    }

    pageWidth() { return Number(this.widgetValue("page_width")) || 2480; }

    renderPreview() {
        return drawPage(this.layout, this.comp, this.previews, this.pageWidth(), Number(this.widgetValue("border")) || 0).then((c) => c.toDataURL("image/jpeg", 0.9));
    }

    exportLettering() { return exportLettering(this.comp, this.layout, this.pageWidth(), this.node.id); }

    build() {
        const head = el("div", "akpe-head");
        const logo = el("div", "akpe-logo");
        logo.innerHTML = `${PAGE_ICON} Page Compose <span>Anima Komikku</span>`;
        const zoomSeg = el("div", "akpe-seg");
        this.zoomLabel = el("div", "akpe-zoom");
        zoomSeg.append(button("−", "Zoom out", () => this.setZoom(this.zoom / 1.2), "icon"),
            button("Fit", "Fit the page to the window", () => this.setZoom(1), "on"),
            this.zoomLabel,
            button("+", "Zoom in (Ctrl + wheel)", () => this.setZoom(this.zoom * 1.2), "icon"));
        this.undoBtn = button("↶ Undo", "Undo (Ctrl+Z)", () => this.restore(this.undoStack, this.redoStack), "outline");
        this.redoBtn = button("↷ Redo", "Redo (Ctrl+Shift+Z)", () => this.restore(this.redoStack, this.undoStack), "outline");
        head.append(logo, el("div", "akpe-spacer"), zoomSeg, this.undoBtn, this.redoBtn,
            button("✕", "Close without saving", () => this.close(false), "icon outline"));

        // Left: lettering types, image import, layers.
        const left = el("div", "akpe-left");
        const types = el("div", "akpc-types");
        for (const [type, spec] of Object.entries(TEXT_TYPES)) {
            const item = el("div", "akpe-tpl");
            item.title = `Add ${spec.name.toLowerCase()}`;
            item.innerHTML = `<svg viewBox="0 0 24 24">${TYPE_ICONS[type]}</svg>`;
            item.appendChild(el("span", null, spec.name));
            item.addEventListener("click", (e) => { e.stopPropagation(); this.addText(type); });
            types.appendChild(item);
        }
        left.appendChild(section("Add text", types));

        this.fileInput = el("input");
        Object.assign(this.fileInput, { type: "file", accept: "image/png,image/jpeg,image/webp" });
        this.fileInput.style.display = "none";
        this.fileInput.addEventListener("change", () => { const f = this.fileInput.files?.[0]; this.fileInput.value = ""; if (f) this.importImage(f); });
        this.importBtn = button("🖼 Import image (RGB / RGBA)", "Place a PNG, JPEG or WebP over the selected panel; transparency is kept", () => this.fileInput.click(), "outline");
        this.importHint = el("div", "akpe-hint", "Select a panel first: imported images sit over that panel and are clipped to it.");
        this.importedGrid = el("div", "akpc-thumbs");
        this.libraryGrid = el("div", "akpc-thumbs");
        left.appendChild(section("Images", this.importBtn, this.importHint, this.fileInput));
        left.appendChild(section("Imported", el("div", "akpe-hint", "Images imported into this page. Click one to place it again over the selected panel; ☆ saves it to the library."), this.importedGrid));
        left.appendChild(section("Library", el("div", "akpe-hint", "Your favorite images, available in every workflow. Click one to place it over the selected panel."), this.libraryGrid));

        this.fontInput = el("input");
        Object.assign(this.fontInput, { type: "file", accept: FONT_TYPES.map((e) => `.${e}`).join(","), multiple: true });
        this.fontInput.style.display = "none";
        this.fontInput.addEventListener("change", () => { const files = [...(this.fontInput.files ?? [])]; this.fontInput.value = ""; this.installFonts(files); });
        this.fontList = el("div", "akpc-layers");
        this.fontStatus = el("div", "akpe-hint", "TTF, OTF, WOFF or WOFF2 from your computer. Saved in your ComfyUI user folder and available in every workflow.");
        left.appendChild(section("Fonts", button("🔤 Install font…", "Add lettering fonts from your computer", () => this.fontInput.click(), "outline"), this.fontStatus, this.fontList, this.fontInput));

        this.layers = el("div", "akpc-layers");
        left.appendChild(section("Layers", this.layers));

        // Stage.
        const stage = el("div", "akpe-stage");
        this.canvas = el("div", "akpe-canvas");
        this.page = el("div", "akpe-page");
        this.letter = el("canvas", "akpc-letter");
        this.canvas.appendChild(this.page);
        this.banner = el("div", "akpc-banner", "Run the workflow once to load the panel images. Text and bubbles can be placed now.");
        stage.style.position = "relative";
        const foot = el("div", "akpe-foot");
        foot.append(el("div", "akpe-hint", "Drag a panel = move its image · wheel over the selected panel = zoom it · drag text/images to move · handles resize · top knob rotates · cyan dot = tail · Ctrl+D duplicates · Del removes"));
        stage.append(this.canvas, this.banner, foot);

        // Right: properties + save.
        const right = el("div", "akpe-right");
        this.props = el("div", "akpc-props");
        const actions = el("div", "akpe-actions");
        this.saveBtn = button("💾 Save", "Save the composition to the node", () => this.close(true), "primary");
        actions.append(button("Cancel", "Close without saving", () => this.close(false), "outline"), this.saveBtn);
        right.append(this.props, actions);

        this.root.append(head, left, stage, right);

        this.page.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.page.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.page.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.page.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.page.addEventListener("dblclick", () => this.textArea?.focus());
        this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
        this.root.addEventListener("keydown", (e) => this.onKey(e));
        for (const type of ["keyup", "keypress", "paste", "copy", "cut"]) this.root.addEventListener(type, (e) => e.stopPropagation());
        this.resizeObserver = new ResizeObserver(() => { this.fitPage(); this.renderPage(); });
        this.resizeObserver.observe(this.canvas);
    }

    setZoom(z) {
        this.zoom = Math.min(6, Math.max(0.3, z));
        this.fitPage();
        this.renderPage();
    }

    fitPage() {
        const aw = this.canvas.clientWidth - 56, ah = this.canvas.clientHeight - 56;
        if (aw <= 0 || ah <= 0) return;
        const ratio = this.layout.page.width / this.layout.page.height;
        const w = Math.min(aw, ah * ratio) * this.zoom;
        this.page.style.width = `${w}px`;
        this.page.style.height = `${w / ratio}px`;
        this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    // Center of the selected panel, or of the page, for new items; next to the selected text when one is selected.
    anchor() {
        const t = this.sel?.kind === "text" ? this.comp.texts[this.sel.index] : null;
        if (t) return [t.x + t.w / 2 + 0.05, t.y + t.h / 2 + 0.06];
        const i = this.sel?.kind === "panel" ? this.sel.index : this.sel?.kind === "overlay" ? this.comp.overlays[this.sel.index].panel : -1;
        const p = this.layout.panels[i];
        return p ? [p.x + p.w / 2, p.y + p.h / 2] : [0.5, 0.5];
    }

    addText(type) {
        this.snapshot();
        const [cx, cy] = this.anchor();
        const t = newText(type, 0, 0);
        t.x = Math.min(1 - t.w, Math.max(0, cx - t.w / 2));
        t.y = Math.min(1 - t.h, Math.max(0, cy - t.h / 2));
        if (t.tail) t.tail = { x: t.x + t.w * 0.3, y: Math.min(0.99, t.y + t.h * 1.6) };
        t.text = { speech: "Hey!", thought: "Hmm...", shout: "STOP!", whisper: "psst...", rounded: "...", caption: "Meanwhile...", sfx: "BOOM", text: "Text" }[type];
        this.comp.texts.push(t);
        this.sel = { kind: "text", index: this.comp.texts.length - 1 };
        this.render();
        this.textArea?.select();
    }

    targetPanel() {
        return this.sel?.kind === "panel" ? this.sel.index : this.sel?.kind === "overlay" ? this.comp.overlays[this.sel.index].panel : -1;
    }

    showError(message) {
        this.banner.textContent = message;
        this.banner.style.display = "";
    }

    // Places an input-folder image over the target panel, fitted inside 60% of the panel box with its aspect ratio kept.
    async placeImage(image) {
        const panel = this.targetPanel();
        const p = this.layout.panels[panel];
        if (!p) return this.showError("Select a panel first: images are placed over the selected panel.");
        const img = await loadImage(inputUrl(image));
        const W = this.layout.page.width, H = this.layout.page.height;
        const s = Math.min(p.w * W * 0.6 / img.naturalWidth, p.h * H * 0.6 / img.naturalHeight);
        const w = img.naturalWidth * s / W, h = img.naturalHeight * s / H;
        this.snapshot();
        this.comp.overlays.push({ id: uid(), panel, image, x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h, opacity: 1 });
        this.sel = { kind: "overlay", index: this.comp.overlays.length - 1 };
        this.render();
    }

    remember(image, name, library = null) {
        const entry = this.comp.imported.find((e) => e.image === image);
        if (entry) { if (library) entry.library = library; return; }
        this.comp.imported.push({ image, name, library });
    }

    async importImage(file) {
        if (!this.layout.panels[this.targetPanel()]) return;
        this.importBtn.disabled = true;
        try {
            const url = URL.createObjectURL(file);
            await loadImage(url).finally(() => URL.revokeObjectURL(url));
            const image = await uploadImage(file, `overlay_${uid()}.${(file.name.split(".").pop() || "png").toLowerCase()}`);
            this.remember(image, file.name);
            await this.placeImage(image);
        } catch (err) {
            this.showError(`Could not import the image: ${err.message}`);
        } finally {
            this.importBtn.disabled = false;
        }
    }

    async refreshLibrary() {
        this.library = await listLibrary();
        // Favorites removed from the library elsewhere lose their star here too.
        for (const e of this.comp.imported) if (e.library && !this.library.includes(e.library)) e.library = null;
        if (this.root.isConnected) this.renderThumbs();
    }

    // Copies an imported image into the library; nothing is added to the library unless the user stars it.
    async favorite(entry) {
        try {
            const blob = await (await fetch(inputUrl(entry.image))).blob();
            const base = safeFileName(entry.name);
            let path = base;
            for (let n = 2; this.library.includes(path); n++) path = base.replace(/(\.[^.]+)?$/, `_${n}$1`);
            await api.storeUserData(`${LIBRARY_DIR}/${path}`, blob, { overwrite: false, stringify: false, throwOnError: true });
            entry.library = path;
            await this.refreshLibrary();
        } catch (err) {
            this.showError(`Could not add the image to the library: ${err.message}`);
        }
    }

    async unfavorite(path) {
        await api.deleteUserData(`${LIBRARY_DIR}/${path}`);
        await this.refreshLibrary();
    }

    // Library files are copied into input/komikku (same name, so placing one twice reuses the copy) for the backend to load.
    async placeFromLibrary(path) {
        if (!this.layout.panels[this.targetPanel()]) return this.showError("Select a panel first: images are placed over the selected panel.");
        try {
            const blob = await (await api.getUserData(`${LIBRARY_DIR}/${path}`)).blob();
            const image = await uploadImage(blob, `library_${safeFileName(path)}`);
            this.remember(image, path, path);
            await this.placeImage(image);
        } catch (err) {
            this.showError(`Could not place the image: ${err.message}`);
        }
    }

    renderThumbs() {
        const thumb = (src, title, onClick, fav, drop) => {
            const t = el("div", "akpc-thumb");
            t.title = title;
            const img = el("img");
            img.src = src;
            img.draggable = false;
            t.appendChild(img);
            t.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
            for (const [cls, label, tip, fn] of [fav, drop].filter(Boolean)) {
                const b = el("button", cls, label);
                b.title = tip;
                b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                t.appendChild(b);
            }
            return t;
        };
        this.importedGrid.replaceChildren(...this.comp.imported.map((entry) => thumb(inputUrl(entry.image), entry.name, () => this.placeImage(entry.image).catch((err) => this.showError(err.message)),
            entry.library ? ["fav on", "★", "In the library · click to remove it from the library", () => this.unfavorite(entry.library)]
                : ["fav", "☆", "Add to the library", () => this.favorite(entry)],
            ["drop", "✕", "Remove from this list (the image stays where it is placed)", () => { this.comp.imported = this.comp.imported.filter((e) => e !== entry); this.renderThumbs(); }])));
        if (!this.comp.imported.length) this.importedGrid.appendChild(el("div", "akpc-thumbs-empty", "No images imported yet."));
        this.libraryGrid.replaceChildren(...this.library.map((path) => thumb(libraryUrl(path), path, () => this.placeFromLibrary(path),
            ["fav on", "★", "Remove from the library", () => this.unfavorite(path)])));
        if (!this.library.length) this.libraryGrid.appendChild(el("div", "akpc-thumbs-empty", "Star an imported image to keep it here."));
    }

    async installFonts(files) {
        let last = null;
        for (const file of files) {
            const ext = file.name.split(".").pop().toLowerCase();
            const family = fontFamilyName(file.name);
            if (!FONT_TYPES.includes(ext) || !family) { this.fontStatus.textContent = `${file.name} is not a TTF, OTF, WOFF or WOFF2 font.`; continue; }
            try {
                // Loading it first rejects files the browser cannot use as a font.
                await registerFont(family, await file.arrayBuffer());
                await api.storeUserData(`${FONT_DIR}/${file.name}`, file, { overwrite: true, stringify: false, throwOnError: true });
                installedFonts = [...installedFonts.filter((f) => f.family !== family), { family, path: file.name }];
                this.fontStatus.textContent = `Installed ${family}.`;
                last = family;
            } catch (err) {
                this.fontStatus.textContent = `Could not install ${file.name}: ${err.message ?? err}`;
            }
        }
        const t = this.sel?.kind === "text" ? this.comp.texts[this.sel.index] : null;
        if (t && last) { this.snapshot(); t.font = last; }
        this.render();
    }

    async uninstallFont(font) {
        await api.deleteUserData(`${FONT_DIR}/${font.path}`);
        installedFonts = installedFonts.filter((f) => f !== font);
        this.fontStatus.textContent = `Removed ${font.family}. Texts using it fall back to a sans font.`;
        this.render();
    }

    removeSelected() {
        if (!this.sel || this.sel.kind === "panel") return;
        this.snapshot();
        (this.sel.kind === "overlay" ? this.comp.overlays : this.comp.texts).splice(this.sel.index, 1);
        this.sel = null;
        this.render();
    }

    duplicateSelected() {
        if (!this.sel || this.sel.kind === "panel") return;
        this.snapshot();
        const list = this.sel.kind === "overlay" ? this.comp.overlays : this.comp.texts;
        const copy = JSON.parse(JSON.stringify(list[this.sel.index]));
        copy.id = uid();
        copy.x += 0.02;
        copy.y += 0.02;
        if (copy.tail) { copy.tail.x += 0.02; copy.tail.y += 0.02; }
        list.push(copy);
        this.sel = { kind: this.sel.kind, index: list.length - 1 };
        this.render();
    }

    reorder(delta) {
        if (!this.sel || this.sel.kind === "panel") return;
        const list = this.sel.kind === "overlay" ? this.comp.overlays : this.comp.texts;
        const j = this.sel.index + delta;
        if (j < 0 || j >= list.length) return;
        this.snapshot();
        [list[this.sel.index], list[j]] = [list[j], list[this.sel.index]];
        this.sel.index = j;
        this.render();
    }

    pointerPos(e) {
        const r = this.page.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }

    // Topmost text under the pointer, tested in each text's rotated frame.
    hitText(pos) {
        const W = this.layout.page.width, H = this.layout.page.height;
        for (let i = this.comp.texts.length - 1; i >= 0; i--) {
            const t = this.comp.texts[i];
            const cx = (t.x + t.w / 2) * W, cy = (t.y + t.h / 2) * H;
            const rot = -(t.rotation || 0) * Math.PI / 180;
            const dx = pos.x * W - cx, dy = pos.y * H - cy;
            const lx = dx * Math.cos(rot) - dy * Math.sin(rot), ly = dx * Math.sin(rot) + dy * Math.cos(rot);
            if (Math.abs(lx) <= t.w * W / 2 && Math.abs(ly) <= t.h * H / 2) return i;
        }
        return -1;
    }

    onPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        const pos = this.pointerPos(e);
        const ds = e.target.dataset ?? {};
        const item = this.selected();
        if (ds.tail != null) this.drag = { mode: "tail", start: pos, orig: JSON.parse(JSON.stringify(item)) };
        else if (ds.rot != null) this.drag = { mode: "rotate", start: pos, orig: { ...item } };
        else if (ds.handle) this.drag = { mode: "resize", handle: ds.handle, start: pos, orig: JSON.parse(JSON.stringify(item)) };
        else {
            const ti = this.hitText(pos);
            if (ti >= 0) this.sel = { kind: "text", index: ti };
            else if (ds.overlay != null) this.sel = { kind: "overlay", index: Number(ds.overlay) };
            else {
                const panelEl = e.target.closest(".akpe-panel");
                this.sel = panelEl ? { kind: "panel", index: Number(panelEl.dataset.index) } : null;
            }
            if (!this.sel) { this.render(); return; }
            const target = this.sel.kind === "panel" ? this.framing(this.sel.index) : this.selected();
            this.drag = { mode: "move", start: pos, orig: JSON.parse(JSON.stringify(target)) };
            this.render();
        }
        this.drag.moved = false;
        this.page.setPointerCapture(e.pointerId);
    }

    onPointerMove(e) {
        const d = this.drag;
        if (!d) return;
        const pos = this.pointerPos(e);
        const dx = pos.x - d.start.x, dy = pos.y - d.start.y;
        if (!d.moved) {
            if (Math.hypot(dx, dy) < 0.004) return;
            d.moved = true;
            this.snapshot();
        }
        const W = this.layout.page.width, H = this.layout.page.height;
        const o = d.orig;
        if (this.sel.kind === "panel") {
            const p = this.layout.panels[this.sel.index], f = this.framing(this.sel.index);
            f.dx = o.dx + dx / p.w;
            f.dy = o.dy + dy / p.h;
        } else if (d.mode === "move") {
            const it = this.selected();
            it.x = o.x + dx;
            it.y = o.y + dy;
            if (o.tail) it.tail = { x: o.tail.x + dx, y: o.tail.y + dy };
        } else if (d.mode === "tail") {
            this.selected().tail = { x: pos.x, y: pos.y };
        } else if (d.mode === "rotate") {
            const cx = (o.x + o.w / 2) * W, cy = (o.y + o.h / 2) * H;
            let deg = Math.atan2(pos.y * H - cy, pos.x * W - cx) * 180 / Math.PI + 90;
            if (e.shiftKey) deg = Math.round(deg / 15) * 15;
            this.selected().rotation = Math.round(((deg + 540) % 360) - 180);
        } else {
            this.resize(d, pos, e.shiftKey);
        }
        this.renderPage();
        this.renderProps(true);
    }

    // Resizes in the item's own (rotated) frame, keeping the opposite side fixed. Images keep their aspect unless Shift is held.
    resize(d, pos, free) {
        const W = this.layout.page.width, H = this.layout.page.height;
        const o = d.orig, it = this.selected();
        const rot = (o.rotation || 0) * Math.PI / 180;
        const ddx = (pos.x - d.start.x) * W, ddy = (pos.y - d.start.y) * H;
        const lx = ddx * Math.cos(-rot) - ddy * Math.sin(-rot), ly = ddx * Math.sin(-rot) + ddy * Math.cos(-rot);
        const sx = d.handle.includes("e") ? 1 : d.handle.includes("w") ? -1 : 0, sy = d.handle.includes("s") ? 1 : d.handle.includes("n") ? -1 : 0;
        let w = Math.max(12, o.w * W + sx * lx), h = Math.max(12, o.h * H + sy * ly);
        if (this.sel.kind === "overlay" && !free) {
            const ratio = o.w * W / (o.h * H);
            if (sx && sy) h = w / ratio;
            else if (sx) h = w / ratio;
            else w = h * ratio;
        }
        const shiftX = sx * (w - o.w * W) / 2, shiftY = sy * (h - o.h * H) / 2;
        const cx = (o.x + o.w / 2) * W + shiftX * Math.cos(rot) - shiftY * Math.sin(rot);
        const cy = (o.y + o.h / 2) * H + shiftX * Math.sin(rot) + shiftY * Math.cos(rot);
        Object.assign(it, { w: w / W, h: h / H, x: (cx - w / 2) / W, y: (cy - h / 2) / H });
    }

    onPointerUp(e) {
        const d = this.drag;
        this.drag = null;
        if (this.page.hasPointerCapture?.(e.pointerId)) this.page.releasePointerCapture(e.pointerId);
        if (d?.moved) this.render();
    }

    onWheel(e) {
        if (!e.ctrlKey && this.sel?.kind !== "panel") return;
        e.preventDefault();
        if (e.ctrlKey) return this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const f = this.framing(this.sel.index);
        if (!this.wheelTimer) this.snapshot();
        clearTimeout(this.wheelTimer);
        this.wheelTimer = setTimeout(() => { this.wheelTimer = null; }, 400);
        f.zoom = Math.min(4, Math.max(0.5, f.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
        this.renderPage();
        this.renderProps(true);
    }

    onKey(e) {
        e.stopPropagation();
        if (e.target.closest("textarea, input, select")) {
            if (e.key === "Escape") this.root.focus({ preventScroll: true });
            return;
        }
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        let handled = true;
        if (e.key === "Delete" || e.key === "Backspace") this.removeSelected();
        else if (mod && key === "z" && !e.shiftKey) this.restore(this.undoStack, this.redoStack);
        else if (mod && (key === "y" || (key === "z" && e.shiftKey))) this.restore(this.redoStack, this.undoStack);
        else if (mod && key === "d") this.duplicateSelected();
        else if (mod && key === "s") this.close(true);
        else if (e.key === "Escape") { this.sel = null; this.render(); }
        else handled = false;
        if (handled) e.preventDefault();
    }

    render() {
        this.undoBtn.disabled = !this.undoStack.length;
        this.redoBtn.disabled = !this.redoStack.length;
        const panelSel = this.sel?.kind === "panel" || this.sel?.kind === "overlay";
        this.importBtn.disabled = !panelSel;
        this.importHint.style.display = panelSel ? "none" : "";
        this.banner.style.display = this.previews.length ? "none" : "";
        this.fitPage();
        this.renderPage();
        this.renderLayers();
        this.renderFonts();
        this.renderThumbs();
        this.renderProps();
    }

    renderFonts() {
        this.fontList.replaceChildren(...installedFonts.map((font) => {
            const r = el("div", "akpe-shot");
            const sample = el("b", null, "Aa");
            sample.style.fontFamily = `'${font.family}'`;
            sample.style.background = "transparent";
            const del = button("✕", "Remove this font", () => this.uninstallFont(font), "icon danger");
            del.style.height = "24px";
            r.append(sample, el("span", null, font.family), del);
            r.title = "Click to use it on the selected text";
            r.addEventListener("click", (e) => {
                e.stopPropagation();
                const t = this.sel?.kind === "text" ? this.comp.texts[this.sel.index] : null;
                if (!t) return;
                this.snapshot();
                t.font = font.family;
                this.render();
            });
            return r;
        }));
    }

    renderPage() {
        const L = this.layout;
        const pw = this.page.clientWidth, ph = this.page.clientHeight;
        if (!pw || !ph) return;
        this.page.querySelectorAll(".akpc-sel, .akpc-tail").forEach((n) => n.remove());
        drawPanels(this.page, L, "akpe", this.sel?.kind === "panel" ? this.sel.index : -1);
        this.page.querySelector(".akpe-lines").style.setProperty("--bw", `${2 * (Number(this.widgetValue("border")) || 0) * pw / this.pageWidth()}px`);
        const panelEls = this.page.querySelectorAll(".akpe-panel");
        L.panels.forEach((p, i) => {
            const host = panelEls[i];
            const ref = this.previews[i];
            if (ref) {
                const img = el("img", "akpc-shot");
                img.src = viewUrl(ref);
                img.draggable = false;
                const place = () => {
                    // Same placement as the backend: cover scale times zoom, centered, shifted by dx/dy.
                    const f = this.comp.panels[i] ?? { zoom: 1, dx: 0, dy: 0 };
                    const bw = p.w * pw, bh = p.h * ph, iw = img.naturalWidth, ih = img.naturalHeight;
                    if (!iw) return;
                    const s = Math.max(bw / iw, bh / ih) * f.zoom;
                    Object.assign(img.style, { width: `${iw * s}px`, height: `${ih * s}px`, left: `${(bw - iw * s) / 2 + f.dx * bw}px`, top: `${(bh - ih * s) / 2 + f.dy * bh}px` });
                };
                img.addEventListener("load", place);
                host.prepend(img);
                if (img.complete) place();
            }
            this.comp.overlays.forEach((ov, k) => {
                if (ov.panel !== i) return;
                const im = el("img", "akpc-ov");
                im.src = inputUrl(ov.image);
                im.draggable = false;
                im.dataset.overlay = k;
                Object.assign(im.style, { left: `${(ov.x - p.x) / p.w * 100}%`, top: `${(ov.y - p.y) / p.h * 100}%`, width: `${ov.w / p.w * 100}%`, height: `${ov.h / p.h * 100}%`, opacity: ov.opacity ?? 1 });
                host.appendChild(im);
            });
        });

        // Lettering is drawn on a canvas with the same code that exports it.
        const dpr = window.devicePixelRatio || 1;
        this.letter.width = Math.round(pw * dpr);
        this.letter.height = Math.round(ph * dpr);
        const ctx = this.letter.getContext("2d");
        ctx.clearRect(0, 0, this.letter.width, this.letter.height);
        for (const t of this.comp.texts) drawText(ctx, t, this.letter.width, this.letter.height);
        this.page.appendChild(this.letter);

        const it = this.selected();
        if (!it || this.sel.kind === "panel") return;
        const box = el("div", "akpc-sel");
        Object.assign(box.style, { left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%`, transform: `rotate(${it.rotation || 0}deg)` });
        const handles = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
        for (const [name, [x, y]] of Object.entries(handles)) {
            if (this.sel.kind === "overlay" && name.length === 1) continue;
            const h = el("div", "akpc-h");
            h.dataset.handle = name;
            Object.assign(h.style, { left: `${x}%`, top: `${y}%`, cursor: "pointer" });
            box.appendChild(h);
        }
        if (this.sel.kind === "text") {
            const r = el("div", "akpc-rot");
            r.dataset.rot = "1";
            r.title = "Drag to rotate (Shift = 15° steps)";
            box.appendChild(r);
        }
        this.page.appendChild(box);
        if (this.sel.kind === "text" && it.tail && TEXT_TYPES[it.type].tail) {
            const tail = el("div", "akpc-tail");
            tail.dataset.tail = "1";
            tail.title = "Drag to point the tail";
            Object.assign(tail.style, { left: `${it.tail.x * 100}%`, top: `${it.tail.y * 100}%` });
            this.page.appendChild(tail);
        }
    }

    renderLayers() {
        const rows = [];
        const row = (sel, badge, label, meta) => {
            const r = el("div", `akpe-shot${this.sel && this.sel.kind === sel.kind && this.sel.index === sel.index ? " sel" : ""}`);
            r.append(el("b", null, badge), el("span", null, label), el("i", null, meta));
            r.addEventListener("click", (e) => { e.stopPropagation(); this.sel = sel; this.render(); });
            return r;
        };
        for (let i = this.comp.texts.length - 1; i >= 0; i--) {
            const t = this.comp.texts[i];
            rows.push(row({ kind: "text", index: i }, "T", t.text.trim() || "(empty)", TEXT_TYPES[t.type].name));
        }
        for (let i = this.comp.overlays.length - 1; i >= 0; i--) {
            rows.push(row({ kind: "overlay", index: i }, "🖼", this.comp.overlays[i].image.split("/").pop(), `panel ${this.comp.overlays[i].panel + 1}`));
        }
        this.layout.panels.forEach((p, i) => rows.push(row({ kind: "panel", index: i }, String(i + 1), p.prompt.trim() || "Panel", `${(this.comp.panels[i]?.zoom ?? 1).toFixed(2)}×`)));
        this.layers.replaceChildren(...rows);
    }

    // The panel under a lettering item: the one containing its center, else the one its tail points into.
    panelUnder(t) {
        const inside = (x, y) => this.layout.panels.findIndex((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
        const i = inside(t.x + t.w / 2, t.y + t.h / 2);
        return i >= 0 || !t.tail ? i : inside(t.tail.x, t.tail.y);
    }

    writeLine(loader, t, suggest) {
        const kind = {
            speech: "a speech bubble (spoken dialogue)", thought: "a thought bubble (inner monologue)", shout: "a shout bubble (yelled, very short)",
            whisper: "a whisper bubble (quiet, intimate)", rounded: "a dialogue box", caption: "a narration caption box",
            sfx: "a sound effect (onomatopoeia, one or two words, uppercase)", text: "free text on the page",
        }[t.type];
        const i = this.panelUnder(t);
        const others = this.comp.texts.filter((x) => x !== t && x.text.trim()).map((x) => `- (${TEXT_TYPES[x.type].name}) ${x.text.trim()}`);
        const system = "You are a manga and comic dialogue writer and letterer. Write text that fits " + kind + ". "
            + "Keep it short enough for a comic bubble, natural and expressive; no quotes, no speaker names, no stage directions. "
            + (suggest ? "Write in the same language as the other text on the page, or English if there is none. "
                       : t.type === "sfx" ? "Keep the same sound; only improve how it is written. "
                       : "Keep the language, meaning and voice of the original line. ")
            + "Output only the text.";
        const lines = [
            i >= 0 ? `Panel ${i + 1} shows: ${this.layout.panels[i].prompt.trim() || "(no description)"}` : "The text is not over a specific panel.",
            others.length ? `Other text on the page:\n${others.join("\n")}` : "There is no other text on the page yet.",
            suggest ? (t.text.trim() ? `Current line (write a different one): ${t.text.trim()}` : "Write a line that fits this moment.")
                    : `Line to improve: ${t.text.trim() || "(empty: write one that fits)"}`,
        ];
        return generateText(loader, system, lines.join("\n"), suggest);
    }

    // live = true only refreshes the values, so inputs keep focus while dragging.
    renderProps(live = false) {
        const it = this.selected();
        if (live && this.propSync) return this.propSync();
        this.propSync = null;
        this.textArea = null;
        const P = this.props;
        P.replaceChildren();
        if (!it) {
            P.append(el("div", "akpe-sec-title", "Page"),
                el("div", "akpe-hint", "Click a panel to move or zoom its image, or a text / image to edit it. Use the left bar to add bubbles, text and images."),
                el("div", "akpe-meta", `${this.layout.panels.length} panels · ${this.comp.texts.length} texts · ${this.comp.overlays.length} images`));
            return;
        }
        const snap = (fn) => (v) => { if (!this.editing) { this.snapshot(); this.editing = true; setTimeout(() => { this.editing = false; }, 600); } fn(v); this.renderPage(); this.renderLayers(); };
        if (this.sel.kind === "panel") {
            const f = this.framing(this.sel.index);
            const zoom = rangeInput(0.5, 4, 0.01, snap((v) => { f.zoom = v; }), (v) => `${v.toFixed(2)}×`);
            zoom.set(f.zoom);
            this.propSync = () => zoom.set(this.framing(this.sel.index).zoom);
            P.append(el("div", "akpe-sec-title", `Panel ${this.sel.index + 1}`),
                el("div", "akpe-hint", "Drag on the panel to move its image; the wheel or the slider zooms it."),
                field("Zoom", zoom),
                button("Reset framing", "Center the image again at cover size", () => { this.snapshot(); Object.assign(f, { zoom: 1, dx: 0, dy: 0 }); this.render(); }, "outline"),
                button("🖼 Import image here", "Place a PNG, JPEG or WebP over this panel", () => this.fileInput.click(), "outline"));
            return;
        }
        const order = el("div", "akpc-row2");
        order.append(button("▲ Forward", "Bring forward", () => this.reorder(1), "outline"), button("▼ Back", "Send backward", () => this.reorder(-1), "outline"));
        const edit = el("div", "akpc-row2");
        edit.append(button("⧉ Duplicate", "Duplicate (Ctrl+D)", () => this.duplicateSelected(), "outline"), button("✕ Delete", "Delete (Del)", () => this.removeSelected(), "outline danger"));
        if (this.sel.kind === "overlay") {
            const opacity = rangeInput(0.05, 1, 0.01, snap((v) => { it.opacity = v; }), (v) => `${Math.round(v * 100)}%`);
            opacity.set(it.opacity ?? 1);
            P.append(el("div", "akpe-sec-title", `Image over panel ${it.panel + 1}`),
                el("div", "akpe-hint", "Corner handles keep the aspect ratio (Shift = free). The image is clipped to its panel."),
                field("Opacity", opacity), order, edit);
            return;
        }
        const spec = TEXT_TYPES[it.type];
        const typeSel = el("select");
        for (const [k, s] of Object.entries(TEXT_TYPES)) typeSel.appendChild(new Option(s.name, k));
        typeSel.value = it.type;
        typeSel.addEventListener("change", () => {
            this.snapshot();
            it.type = typeSel.value;
            if (TEXT_TYPES[it.type].tail && !it.tail) it.tail = { x: it.x + it.w * 0.3, y: it.y + it.h * 1.6 };
            this.render();
        });
        const text = el("textarea");
        text.value = it.text;
        text.placeholder = "Dialogue, thought, narration or sound effect…";
        text.addEventListener("focus", () => { this.typing = false; });
        text.addEventListener("input", () => { if (!this.typing) { this.snapshot(); this.typing = true; } it.text = text.value; this.renderPage(); this.renderLayers(); });
        this.textArea = text;
        const font = el("select");
        for (const [name] of FONTS) font.appendChild(new Option(name, name));
        if (installedFonts.length) {
            const group = el("optgroup");
            group.label = "Installed";
            for (const f of installedFonts) group.appendChild(new Option(f.family, f.family));
            font.appendChild(group);
        }
        if (![...font.options].some((o) => o.value === it.font)) font.appendChild(new Option(`${it.font} (missing)`, it.font));
        font.value = it.font;
        font.addEventListener("change", snap(() => { it.font = font.value; }));
        const size = rangeInput(8, 200, 1, snap((v) => { it.size = v; }), (v) => `${v}`);
        size.set(it.size);
        const toggles = el("div", "akpc-toggles");
        for (const [key, label, title] of [["bold", "B", "Bold"], ["italic", "I", "Italic"], ["vertical", "縦", "Vertical text (columns right to left)"]]) {
            const b = button(label, title, () => { this.snapshot(); it[key] = !it[key]; this.render(); }, `outline${it[key] ? " on" : ""}`);
            toggles.appendChild(b);
        }
        if (spec.tail) toggles.appendChild(button("Tail", "Show or hide the tail", () => {
            this.snapshot();
            it.tail = it.tail ? null : { x: it.x + it.w * 0.3, y: it.y + it.h * 1.6 };
            this.render();
        }, `outline${it.tail ? " on" : ""}`));
        const color = (key, label) => {
            const l = el("label", null, label);
            const c = el("input");
            c.type = "color";
            c.value = it[key];
            c.addEventListener("input", snap(() => { it[key] = c.value; }));
            l.appendChild(c);
            return l;
        };
        const colors = el("div", "akpc-colors");
        colors.append(color("color", "Text"), ...(spec.shape ? [color("fill", "Fill"), color("stroke", "Border")] : []), color("outlineColor", "Outline"));
        const rotation = rangeInput(-180, 180, 1, snap((v) => { it.rotation = v; }), (v) => `${v}°`);
        rotation.set(it.rotation || 0);
        const outline = rangeInput(0, 20, 0.5, snap((v) => { it.outline = v; }), (v) => `${v}`);
        outline.set(it.outline || 0);
        const assist = assistPanel(this.node, el, button, [
            { label: "✨ Improve", title: "Rewrite this line for its bubble type, keeping its language and meaning", run: (loader) => this.writeLine(loader, it, false) },
            { label: "💡 Suggest", title: "Write a new line from the panel's prompt and the rest of the page", run: (loader) => this.writeLine(loader, it, true) },
        ], (v) => { this.snapshot(); it.text = v; this.render(); });
        const rows = [el("div", "akpe-sec-title", spec.name), field("Type", typeSel), text, assist, field("Font", font), field("Size", size), toggles, colors];
        if (spec.shape) {
            const box = rangeInput(0, 1, 0.01, snap((v) => { it.fillOpacity = v; }), (v) => `${Math.round(v * 100)}%`);
            box.set(it.fillOpacity ?? 1);
            box.title = "Transparency of the box (background, border and tail); the text stays solid";
            const border = rangeInput(0, 14, 0.5, snap((v) => { it.border = v; }), (v) => `${v}`);
            border.set(it.border);
            rows.push(field("Box opacity", box), field("Border", border));
        }
        rows.push(field("Outline", outline), field("Rotate", rotation), order, edit);
        this.propSync = () => rotation.set(this.selected()?.rotation || 0);
        P.append(...rows);
    }
}

// Node body: the last composed page, or a placeholder, plus the button that opens the editor.
class ComposePreview {
    constructor(node, value) {
        this.node = node;
        this.value = value;
        this.root = el("div", "akpv");
        this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
        this.render();
    }

    // The layout comes from the linked Anima Komikku Page & Panels; the last run's layout is the fallback.
    layout() {
        const slot = this.node.inputs?.findIndex((i) => i.name === "layout");
        const source = slot >= 0 ? this.node.getInputNode?.(slot) : null;
        const value = source?.widgets?.find((w) => w.name === "layout")?.value ?? this.node.properties?.komikku_layout;
        return value ? parseLayout(value) : null;
    }

    open() {
        if (this.editor?.root.isConnected) return;
        const layout = this.layout();
        if (!layout?.panels.length) {
            this.status.textContent = "Connect the layout from Anima Komikku Page & Panels and design the page first.";
            return;
        }
        this.editor = new ComposeEditor(this.node, layout, this.value, this.node.properties?.komikku_panels ?? [], (value, preview) => {
            this.value = value;
            this.localPreview = preview;
            this.render();
            this.node.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
        });
    }

    render() {
        const comp = parseComposition(this.value);
        const page = this.node.properties?.komikku_page;
        const bar = el("div", "akpv-bar");
        this.status = el("div", "akpv-sum");
        this.status.innerHTML = `<b>${comp.texts.length} texts</b> · ${comp.overlays.length} images${comp.panels.some((f) => f.zoom !== 1 || f.dx || f.dy) ? " · reframed" : ""}`;
        const open = el("button", "akpv-open");
        open.innerHTML = `${PAGE_ICON.replace(/22/g, "15")} Open Page Editor`;
        open.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        if (this.localPreview) this.status.append(" · ", el("span", "todo", "edited, run to render"));
        bar.append(this.status, open);
        const body = el("div", "akpv-body");
        if (this.localPreview || page) {
            const img = el("img", "akpc-preview-img");
            img.src = this.localPreview ?? viewUrl(page);
            body.appendChild(img);
            body.title = "Open the page editor";
            body.addEventListener("click", () => this.open());
        } else {
            const box = el("div", "akpv-placeholder");
            box.append(el("b", null, "No page composed yet"),
                el("small", null, "Run the workflow once to load the panels, then open the editor to frame images, add bubbles, text and images."));
            body.appendChild(box);
        }
        this.root.replaceChildren(bar, body);
    }
}

app.registerExtension({
    name: "AnimaKomikku.PageComposeEditor",
    setup() { installComposeCss(); },
    getCustomWidgets() {
        return {
            ANIMA_KOMIKKU_PAGE_COMPOSITION(node, inputName, inputData) {
                const preview = new ComposePreview(node, inputData[1]?.default);
                node.__komikkuPreview = preview;
                const widget = node.addDOMWidget(inputName, "ANIMA_KOMIKKU_PAGE_COMPOSITION", preview.root, {
                    getValue: () => preview.value,
                    setValue: (v) => { preview.value = v; preview.render(); },
                    getMinHeight: () => 320,
                });
                const onRemoved = node.onRemoved;
                node.onRemoved = function () { preview.editor?.close(false); return onRemoved?.apply(this, arguments); };
                return { widget };
            },
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            // Kept in node properties (saved with the workflow, never sent to the backend) so the editor can show the last run.
            this.properties ??= {};
            if (message?.komikku_page?.[0]) this.properties.komikku_page = message.komikku_page[0];
            if (message?.komikku_panels) this.properties.komikku_panels = message.komikku_panels;
            if (message?.komikku_layout?.[0]) this.properties.komikku_layout = message.komikku_layout[0];
            if (this.__komikkuPreview) this.__komikkuPreview.localPreview = null;
            this.__komikkuPreview?.render();
        };
    },
    nodeCreated(node) {
        if (node.comfyClass === NODE_CLASS && node.size[0] < 360) node.setSize([360, node.size[1]]);
    },
});
