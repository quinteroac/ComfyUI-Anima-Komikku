import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { detectPanels, matchPanels } from "./panel_detect.js";
import { assistPanel, generateText, runPrompt } from "./text_assist.js";

const NODE_CLASS = "AnimaKomikkuPageLayout";
const MIN_SIZE = 0.04;
const SNAP = 0.012;
const HISTORY_LIMIT = 60;

export const PAGES = [
    { name: "Manga B5", width: 182, height: 257 },
    { name: "Manga A5", width: 148, height: 210 },
    { name: "US comic", width: 168, height: 260 },
    { name: "A4", width: 210, height: 297 },
    { name: "Square", width: 200, height: 200 },
    { name: "Landscape 16:9", width: 320, height: 180 },
];

// rows: [weight, [column weights]] top to bottom; cols: [weight, [row weights]] in reading order.
export const PRESETS = [
    { id: "splash", name: "Splash", rows: [[1, [1]]] },
    { id: "tiers-2", name: "2 tiers", rows: [[1, [1]], [1, [1]]] },
    { id: "tiers-3", name: "3 tiers", rows: [[1, [1]], [1, [1]], [1, [1]]] },
    { id: "yonkoma", name: "4-koma", rows: [[1, [1]], [1, [1]], [1, [1]], [1, [1]]] },
    { id: "grid-2x2", name: "Grid 2×2", rows: [[1, [1, 1]], [1, [1, 1]]] },
    { id: "grid-2x3", name: "Grid 2×3", rows: [[1, [1, 1]], [1, [1, 1]], [1, [1, 1]]] },
    { id: "grid-3x3", name: "Grid 3×3", rows: [[1, [1, 1, 1]], [1, [1, 1, 1]], [1, [1, 1, 1]]] },
    { id: "tiers-2-1", name: "Wide · pair", rows: [[1, [1]], [1.1, [1, 1]], [1, [1]]] },
    { id: "hero-top", name: "Hero top", rows: [[2, [1]], [1, [1, 1, 1]]] },
    { id: "manga-5", name: "Manga 5", rows: [[1.2, [1]], [1, [1.4, 1]], [1, [1, 1.4]]] },
    { id: "manga-6", name: "Manga 6", rows: [[1, [1, 1.6]], [1.3, [1]], [1, [1, 1, 1]]] },
    { id: "manga-7", name: "Manga 7", rows: [[0.9, [1, 1]], [1.2, [1.6, 1]], [1, [1, 1, 1]]] },
    { id: "tall-side", name: "Tall side", cols: [[1.3, [1]], [1, [1, 1, 1]]] },
    { id: "columns-3", name: "3 columns", cols: [[1, [1]], [1, [1]], [1, [1]]] },
    { id: "cinema", name: "Cinematic", rows: [[1, [1]], [1, [1]], [1, [1]], [1.4, [1, 1]]] },
];

const RATIOS = [[1, 1], [4, 3], [3, 2], [16, 9], [2, 1], [21, 9], [3, 1]];

export function nearestRatio(a) {
    let best = null;
    for (const [w, h] of RATIOS) {
        for (const [rw, rh, r] of [[w, h, w / h], [h, w, h / w]]) {
            const err = Math.abs(Math.log(a / r));
            if (!best || err < best.err) best = { err, label: `${rw}:${rh}` };
        }
    }
    return best.err < 0.04 ? best.label : a >= 1 ? `${a.toFixed(2)}:1` : `1:${(1 / a).toFixed(2)}`;
}

// Template panels take over the prompts of the current panels, in order.
export function withShots(panels, previous) {
    return panels.map((p, i) => ({ ...p, prompt: previous[i]?.prompt ?? "" }));
}

// Panel shapes: rect panels store x, y, w, h; free-form panels add `polygon` ([[x, y], ...] in page fractions)
// and keep x, y, w, h as its bounding box, which sets the generated image size.
export function corners(p) {
    return p.polygon ?? [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
}

function setPolygon(p, pts) {
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return Object.assign(p, { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, polygon: pts });
}

// Pieces that come out axis-aligned stay plain rects.
export function shapeFrom(base, pts) {
    const p = setPolygon({ ...base }, pts);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    if (pts.length === 4 && pts.every(([x, y]) => (near(x, p.x) || near(x, p.x + p.w)) && (near(y, p.y) || near(y, p.y + p.h)))) delete p.polygon;
    return p;
}

function polygonArea(pts) {
    return Math.abs(pts.reduce((sum, q, i) => { const r = pts[(i + 1) % pts.length]; return sum + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
}

// Keeps the part of the polygon where dot(P - a, n) >= offset (Sutherland-Hodgman against one line).
function clipHalf(pts, a, n, offset) {
    const side = (q) => (q[0] - a[0]) * n[0] + (q[1] - a[1]) * n[1] - offset;
    const out = [];
    pts.forEach((cur, i) => {
        const prev = pts[(i + pts.length - 1) % pts.length];
        const sc = side(cur), sp = side(prev);
        if ((sc >= 0) !== (sp >= 0)) {
            const t = sp / (sp - sc);
            out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
        }
        if (sc >= 0) out.push(cur);
    });
    return out.filter((q, i) => { const r = out[(i + 1) % out.length]; return Math.hypot(q[0] - r[0], q[1] - r[1]) > 1e-9; });
}

function segmentsCross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

// Cuts a panel along the line a-b, leaving one gutter between the pieces. The piece read first keeps the prompt.
export function cutPanel(p, a, b, layout) {
    const W = layout.page.width, H = layout.page.height;
    const toMm = (q) => [q[0] * W, q[1] * H], toPage = (q) => [q[0] / W, q[1] / H];
    const A = toMm(a), B = toMm(b);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (len < 1e-6) return null;
    const n = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
    const pts = corners(p).map(toMm);
    const one = clipHalf(pts, A, n, layout.gutter / 2), two = clipHalf(pts, A, [-n[0], -n[1]], layout.gutter / 2);
    const minArea = Math.max(25, polygonArea(pts) * 0.03);
    if (one.length < 3 || two.length < 3 || polygonArea(one) < minArea || polygonArea(two) < minArea) return null;
    const [first, second] = readingOrder([shapeFrom(p, one.map(toPage)), shapeFrom(p, two.map(toPage))], layout.direction);
    return [{ ...first, prompt: p.prompt }, { ...second, prompt: "" }];
}

// Cuts a panel across its box: axis "x" leaves two side-by-side pieces, "y" two stacked ones. `at` is the cut position
// across the box and `slant` tilts the cut, moving its two ends by -slant/2 and +slant/2 (page fractions).
export function splitPanel(p, axis, layout, at = 0.5, slant = 0) {
    const cx = p.x + p.w * at, cy = p.y + p.h * at;
    return axis === "x" ? cutPanel(p, [cx + slant / 2, p.y], [cx - slant / 2, p.y + p.h], layout)
        : cutPanel(p, [p.x, cy - slant / 2], [p.x + p.w, cy + slant / 2], layout);
}

// Knife cut: every panel the segment a-b crosses is cut. Returns the new panels and the index of the first cut one, or null.
export function knifeCut(layout, a, b) {
    const results = [];
    layout.panels.forEach((p, i) => {
        const pts = corners(p);
        if (!pts.some((q, k) => segmentsCross(a, b, q, pts[(k + 1) % pts.length]))) return;
        const pieces = cutPanel(p, a, b, layout);
        if (pieces) results.push([i, pieces]);
    });
    if (!results.length) return null;
    const panels = layout.panels.slice();
    for (const [i, pieces] of results.slice().reverse()) panels.splice(i, 1, ...pieces);
    return { panels, first: results[0][0] };
}

// Detected outlines that are boxes become plain rect panels.
function importedShape(pts) {
    const p = setPolygon({}, pts);
    const near = (a, b) => Math.abs(a - b) < 0.006;
    if (pts.length === 4 && pts.every(([x, y]) => (near(x, p.x) || near(x, p.x + p.w)) && (near(y, p.y) || near(y, p.y + p.h)))) delete p.polygon;
    return p;
}

function inputUrl(name) {
    const i = name.lastIndexOf("/");
    return api.apiURL(`/view?filename=${encodeURIComponent(name.slice(i + 1))}&subfolder=${encodeURIComponent(name.slice(0, Math.max(0, i)))}&type=input`);
}

// Panel boxes ([x1, y1, x2, y2] in page fractions) found by WeVisOne-VL on an input image, or null when the
// ComfyUI-WeVisOne-VL pack or its model is not installed.
async function modelPanelBoxes(image) {
    const info = await (await api.fetchApi("/object_info/WeVisOneVLLoader")).json();
    const model = info.WeVisOneVLLoader?.input.required.clip_name[1].options.find((name) => /wevisone/i.test(name));
    if (!model) return null;
    const text = await runPrompt({
        "1": { class_type: "LoadImage", inputs: { image } },
        "2": { class_type: "WeVisOneVLLoader", inputs: { clip_name: model } },
        "3": { class_type: "WeVisOneVLPerceive", inputs: { clip: ["2", 0], image: ["1", 0], task: "detection", query: "comic panel", max_length: 1024, individual_masks: false } },
        "4": { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
    }, "4");
    return [...text.matchAll(/<(\d+)><(\d+)><(\d+)><(\d+)>/g)].map((m) => m.slice(1).map((v) => v / 1000));
}

// Copies the panel layout of an existing page: uploads it as the editor reference, finds its panels and returns the new layout,
// with a warning when the gutters alone found them. WeVisOne-VL, when installed, finds the panels; the gutter outlines only
// refine the shapes it found.
export async function importPageLayout(file, layout) {
    const image = await createImageBitmap(file);
    const body = new FormData();
    body.append("image", file, `layout_ref_${Date.now().toString(36)}.png`);
    body.append("subfolder", "komikku");
    body.append("type", "input");
    const res = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    const data = await res.json();
    const name = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
    const { panels: outlines } = detectPanels(image);
    const boxes = await modelPanelBoxes(name);
    const panels = boxes?.length ? matchPanels(boxes, outlines) : outlines;
    if (!panels.length) throw new Error("no panels found: the page needs a plain gutter between panels");
    const H = 257;
    return {
        layout: {
            ...layout, page: { name: "Imported", width: Math.round(H * image.width / image.height), height: H }, preset: null,
            panels: withShots(readingOrder(panels.map(importedShape), layout.direction), layout.panels),
            reference: { image: name, opacity: 0.5 },
        },
        warning: boxes ? null : "Panels found from the gutters only: install the ComfyUI-WeVisOne-VL nodes and a WeVisOne-VL-4B model in models/text_encoders for better detection.",
    };
}

function translated(p, dx, dy) {
    const q = { ...p, x: p.x + dx, y: p.y + dy };
    if (p.polygon) q.polygon = p.polygon.map(([x, y]) => [x + dx, y + dy]);
    return q;
}

// Where the panel number sits: the leftmost of the top corners, pulled slightly inside the shape.
function labelPoint(p) {
    if (!p.polygon) return [p.x, p.y];
    const v = p.polygon.filter((q) => q[1] - p.y < 0.01).reduce((best, q) => q[0] < best[0] ? q : best);
    const cx = p.polygon.reduce((s, q) => s + q[0], 0) / p.polygon.length, cy = p.polygon.reduce((s, q) => s + q[1], 0) / p.polygon.length;
    return [v[0] + (cx - v[0]) * 0.15, v[1] + (cy - v[1]) * 0.15];
}

export const SVG_NS = "http://www.w3.org/2000/svg";

// Shared by the editor (prefix "akpe") and the node preview ("akpv"): panel fills clipped to their shape,
// one SVG layer for the outlines, and the panel numbers on top.
export function drawPanels(pageEl, layout, prefix, sel = -1, emptyText = "") {
    pageEl.querySelectorAll(`.${prefix}-panel, .${prefix}-lines, .${prefix}-num`).forEach((n) => n.remove());
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", `${prefix}-lines`);
    svg.setAttribute("viewBox", "0 0 1 1");
    svg.setAttribute("preserveAspectRatio", "none");
    let selShape = null;
    layout.panels.forEach((p, i) => {
        const d = el("div", `${prefix}-panel${p.prompt.trim() ? "" : " empty"}`);
        d.dataset.index = i;
        Object.assign(d.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` });
        if (p.polygon) d.style.clipPath = `polygon(${p.polygon.map(([x, y]) => `${(x - p.x) / p.w * 100}% ${(y - p.y) / p.h * 100}%`).join(", ")})`;
        d.appendChild(el("span", null, p.prompt.trim() || emptyText));
        pageEl.appendChild(d);
        const shape = document.createElementNS(SVG_NS, "polygon");
        shape.setAttribute("points", corners(p).map((q) => q.join(",")).join(" "));
        shape.setAttribute("vector-effect", "non-scaling-stroke");
        if (i === sel) { shape.setAttribute("class", "sel"); selShape = shape; } else svg.appendChild(shape);
    });
    if (selShape) svg.appendChild(selShape);
    pageEl.appendChild(svg);
    layout.panels.forEach((p, i) => {
        const [x, y] = labelPoint(p);
        const num = el("div", `${prefix}-num${i === sel ? " sel" : ""}`, String(i + 1));
        Object.assign(num.style, { left: `${x * 100}%`, top: `${y * 100}%` });
        pageEl.appendChild(num);
    });
}

export function parseLayout(value) {
    try { return JSON.parse(value); } catch { return { page: { ...PAGES[0] }, margin: 10, gutter: 4, direction: "rtl", preset: null, panels: [] }; }
}

export function buildPreset(preset, layout) {
    const mx = layout.margin / layout.page.width, my = layout.margin / layout.page.height;
    const gx = layout.gutter / layout.page.width, gy = layout.gutter / layout.page.height;
    const split = (start, length, gap, weights) => {
        const total = weights.reduce((a, b) => a + b, 0);
        const free = length - gap * (weights.length - 1);
        let pos = start;
        return weights.map((w) => { const seg = [pos, free * w / total]; pos += seg[1] + gap; return seg; });
    };
    const rtl = layout.direction === "rtl";
    const panels = [];
    if (preset.rows) {
        const rows = split(my, 1 - 2 * my, gy, preset.rows.map((r) => r[0]));
        preset.rows.forEach(([, cols], r) => {
            const segs = split(mx, 1 - 2 * mx, gx, cols);
            if (rtl) segs.reverse();
            for (const [x, w] of segs) panels.push({ x, y: rows[r][0], w, h: rows[r][1], prompt: "" });
        });
    } else {
        let cols = split(mx, 1 - 2 * mx, gx, preset.cols.map((c) => c[0]));
        if (rtl) cols = cols.slice().reverse();
        preset.cols.forEach(([, rowWeights], c) => {
            for (const [y, h] of split(my, 1 - 2 * my, gy, rowWeights)) panels.push({ x: cols[c][0], y, w: cols[c][1], h, prompt: "" });
        });
    }
    return panels;
}

export function readingOrder(panels, direction) {
    const sorted = panels.slice().sort((a, b) => a.y - b.y);
    const rows = [];
    for (const p of sorted) {
        const row = rows.find((r) => p.y < r.bottom - Math.min(p.h, r.bottom - r.top) * 0.5);
        if (row) { row.items.push(p); row.bottom = Math.max(row.bottom, p.y + p.h); }
        else rows.push({ top: p.y, bottom: p.y + p.h, items: [p] });
    }
    const sign = direction === "rtl" ? -1 : 1;
    return rows.flatMap((r) => r.items.sort((a, b) => sign * (a.x - b.x)));
}

const CSS = `
.akpe, .akpv { --pe-bg: #0e1016; --pe-side: #141823; --pe-card: #1b2030; --pe-fg: #e6e8f0; --pe-muted: #8a90a6; --pe-line: #2a3044;
  --pe-accent: #ff5d8f; --pe-accent-hover: #ff7ba5; --pe-accent-soft: rgba(255,93,143,.14); --pe-blue: #3fd0e6; --pe-warn: #ff6b5a;
  font: 12.5px/1.4 Inter, system-ui, sans-serif; color: var(--pe-fg); }
.akpe *, .akpv * { box-sizing: border-box; }
.akpe button, .akpe select, .akpe input, .akpe textarea, .akpv button { font: inherit; color: var(--pe-fg); }

/* Fullscreen editor */
.akpe { position: fixed; inset: 0; z-index: 10000; display: grid; grid-template-rows: 52px 1fr; grid-template-columns: 290px 1fr 360px;
  grid-template-areas: "head head head" "left stage right"; background: var(--pe-bg); outline: none; }
.akpe-head { grid-area: head; display: flex; align-items: center; gap: 10px; padding: 0 14px; background: var(--pe-side); border-bottom: 1px solid var(--pe-line); }
.akpe-logo { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; margin-right: 8px; }
.akpe-logo svg { color: var(--pe-accent); }
.akpe-logo span { color: var(--pe-accent); }
.akpe-spacer { flex: 1; }
.akpe-seg { display: flex; align-items: center; gap: 2px; padding: 3px; background: var(--pe-card); border: 1px solid var(--pe-line); border-radius: 8px; }
.akpe-zoom { min-width: 46px; text-align: center; color: var(--pe-muted); font-size: 11.5px; }
.akpe-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 6px; border: 1px solid transparent;
  background: transparent; cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s, color .12s; }
.akpe-btn:hover:not(:disabled) { background: rgba(255,255,255,.07); }
.akpe-btn:disabled { opacity: .35; cursor: default; }
.akpe-btn.on, .akpe-btn.primary { background: var(--pe-accent); color: #fff; font-weight: 600; }
.akpe-btn.primary:hover:not(:disabled) { background: var(--pe-accent-hover); }
.akpe-btn.outline { border-color: var(--pe-line); background: var(--pe-card); }
.akpe-btn.outline:hover:not(:disabled) { border-color: var(--pe-accent); }
.akpe-btn.danger:hover:not(:disabled) { background: rgba(255,107,90,.16); border-color: var(--pe-warn); color: #ffb8ad; }
.akpe-btn.icon { width: 32px; padding: 0; font-size: 16px; }

.akpe-left, .akpe-right { background: var(--pe-side); display: flex; flex-direction: column; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.akpe-left { grid-area: left; border-right: 1px solid var(--pe-line); }
.akpe-right { grid-area: right; border-left: 1px solid var(--pe-line); overflow: hidden; }
.akpe-sec { border-bottom: 1px solid var(--pe-line); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.akpe-sec-title { display: flex; align-items: center; gap: 7px; color: var(--pe-fg); font-size: 12px; font-weight: 650; letter-spacing: .02em; cursor: pointer; user-select: none; }
.akpe-sec-title::before { content: "▾"; color: var(--pe-accent); font-size: 10px; transition: transform .15s; }
.akpe-sec.closed .akpe-sec-title::before { transform: rotate(-90deg); }
.akpe-sec.closed > :not(.akpe-sec-title) { display: none; }
.akpe-field { display: grid; grid-template-columns: 74px 1fr; align-items: center; gap: 8px; }
.akpe-field > label { color: var(--pe-muted); font-size: 11.5px; }
.akpe-row { display: flex; gap: 6px; align-items: center; }
.akpe-row > * { flex: 1; }
.akpe select, .akpe input[type=number] { width: 100%; height: 30px; padding: 0 8px; background: var(--pe-card); border: 1px solid var(--pe-line); border-radius: 6px; outline: none; }
.akpe select:focus, .akpe input[type=number]:focus { border-color: var(--pe-accent); }
.akpe select option { background: var(--pe-card); }
.akpe-x { flex: 0 0 auto; color: var(--pe-muted); }
.akpe-templates { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.akpe-tpl { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 7px 2px 5px; border-radius: 7px; border: 1px solid var(--pe-line);
  background: var(--pe-card); cursor: pointer; color: var(--pe-muted); font-size: 9.5px; text-align: center; line-height: 1.15; transition: border-color .12s, color .12s; }
.akpe-tpl:hover { border-color: var(--pe-blue); color: var(--pe-fg); }
.akpe-tpl.active { border-color: var(--pe-accent); color: var(--pe-fg); background: var(--pe-accent-soft); }
.akpe-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.akpe-tools .akpe-btn { height: 34px; }

.akpe-stage { grid-area: stage; position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.akpe-canvas { flex: 1; min-height: 0; overflow: auto; display: flex; padding: 28px; scrollbar-width: thin;
  background: radial-gradient(circle at 1px 1px, rgba(255,255,255,.05) 1px, transparent 0) 0 0 / 18px 18px; }
.akpe-page { position: relative; flex: 0 0 auto; margin: auto; background: #f7f5f0; box-shadow: 0 0 0 1px rgba(255,93,143,.3), 0 18px 50px rgba(0,0,0,.55); touch-action: none; cursor: crosshair; user-select: none; }
.akpe-safe { position: absolute; border: 1px dashed rgba(0,0,0,.16); pointer-events: none; }
.akpe-panel { position: absolute; background: #fff; cursor: move; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
.akpe-panel.empty { background: repeating-linear-gradient(135deg, #fff 0 8px, #f3f0e8 8px 16px); }
.akpe-ref { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
.akpe-page.has-ref .akpe-panel, .akpe-page.has-ref .akpe-panel.empty { background: rgba(255,255,255,.18); }
.akpe-page.has-ref .akpe-panel span { background: rgba(255,255,255,.85); }
.akpe input[type=range] { flex: 3; min-width: 0; accent-color: var(--pe-accent); }
.akpe-panel span { padding: 5px 10px 7px; color: #3a3833; font-size: 11px; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.akpe-panel.empty span { color: #aaa497; font-style: italic; }
.akpe-lines, .akpv-lines, .akpe-guide { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.akpe-lines polygon { fill: none; stroke: #1d1d1f; stroke-width: 2.2; stroke-linejoin: miter; }
.akpe-lines polygon.sel { stroke: var(--pe-accent); stroke-width: 3.5; }
.akpe-num { position: absolute; margin: 6px 0 0 6px; min-width: 28px; height: 28px; padding: 0 7px; border-radius: 14px; display: flex; align-items: center; justify-content: center;
  background: #1d1d1f; color: #fff; font-weight: 800; font-size: 14px; pointer-events: none; z-index: 2; }
.akpe-num.sel { background: var(--pe-accent); }
.akpe-num i { position: absolute; left: calc(100% + 6px); white-space: nowrap; color: #7a766d; font: 700 10.5px Inter, system-ui, sans-serif; }
.akpe-handle { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #fff; border: 2px solid var(--pe-accent); border-radius: 3px; z-index: 3; }
.akpe-vertex { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; background: #fff; border: 2.5px solid var(--pe-accent); border-radius: 50%; z-index: 4; cursor: move; }
.akpe-mid { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; background: var(--pe-accent); border-radius: 50%; opacity: .5; z-index: 3; cursor: copy; }
.akpe-mid:hover { opacity: 1; transform: scale(1.3); }
.akpe-ghost { position: absolute; border: 2px dashed var(--pe-blue); background: rgba(63,208,230,.13); pointer-events: none; }
.akpe-guide { z-index: 5; }
.akpe-guide polyline { fill: rgba(63,208,230,.13); stroke: var(--pe-blue); stroke-width: 2; stroke-dasharray: 6 4; }
.akpe-guide line { stroke: var(--pe-blue); stroke-width: 2.5; }
.akpe-toolrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 3px; background: var(--pe-card); border: 1px solid var(--pe-line); border-radius: 8px; }
.akpe-toolrow .akpe-btn { height: 34px; padding: 0 4px; }
.akpe-blank { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: #8f8a7e; text-align: center; pointer-events: none; padding: 20px; }
.akpe-blank b { color: #4b4840; font-size: 15px; }
.akpe-foot { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--pe-line); background: var(--pe-side); }
.akpe-hint { flex: 1; color: var(--pe-muted); font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
.akpe-size { color: var(--pe-accent); font: 11px ui-monospace, monospace; }

.akpe-shot-card { padding: 14px; display: flex; flex-direction: column; gap: 9px; border-bottom: 1px solid var(--pe-line); flex: 1.3; min-height: 0; }
.akpe-shot-head { display: flex; align-items: center; gap: 10px; }
.akpe-badge { min-width: 36px; height: 36px; border-radius: 18px; background: var(--pe-accent); color: #fff; font-weight: 800; font-size: 17px; display: flex; align-items: center; justify-content: center; padding: 0 9px; }
.akpe-title { font-weight: 700; font-size: 14px; }
.akpe-meta { color: var(--pe-muted); font-size: 11.5px; }
.akpe-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.akpe-chip { padding: 2px 8px; border-radius: 10px; background: var(--pe-card); border: 1px solid var(--pe-line); color: var(--pe-muted); font-size: 11px; }
.akpe-chip.accent { color: var(--pe-accent); border-color: rgba(255,93,143,.45); }
.akpe-prefix { color: var(--pe-muted); font-size: 11.5px; font-style: italic; }
.akpe textarea { width: 100%; flex: 1; min-height: 120px; resize: none; padding: 10px; border-radius: 8px; border: 1px solid var(--pe-line);
  background: #0a0c11; outline: none; line-height: 1.45; font-size: 13px; }
.akpe textarea:focus { border-color: var(--pe-accent); }
.akpe-shots-card { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
.akpe-shots { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; scrollbar-width: thin; }
.akpe-shot { display: flex; gap: 9px; align-items: center; padding: 6px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.akpe-shot:hover { background: rgba(255,255,255,.04); }
.akpe-shot.sel { border-color: var(--pe-accent); background: var(--pe-accent-soft); }
.akpe-shot b { min-width: 22px; height: 22px; border-radius: 11px; background: #2a3044; display: flex; align-items: center; justify-content: center; font-size: 11px; }
.akpe-shot.sel b { background: var(--pe-accent); color: #fff; }
.akpe-shot span { flex: 1; color: var(--pe-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.akpe-shot span.todo { color: var(--pe-warn); }
.akpe-import-note { color: var(--pe-warn); font-size: 11px; line-height: 1.4; }
.akpe-shot i { color: var(--pe-muted); font-style: normal; font-size: 10.5px; }
.akpe-empty { color: var(--pe-muted); text-align: center; padding: 22px 8px; }
.akpe-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--pe-line); }
.akpe-actions .akpe-btn { height: 38px; font-size: 13.5px; }

/* Node preview */
.akpv { width: 100%; height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--pe-bg); border: 1px solid var(--pe-line); border-radius: 10px; overflow: hidden; }
.akpv-bar { display: flex; align-items: center; gap: 8px; }
.akpv-sum { flex: 1; min-width: 0; color: var(--pe-muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.akpv-sum b { color: var(--pe-fg); }
.akpv-sum .todo { color: var(--pe-warn); }
.akpv-open { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: none; border-radius: 6px; background: var(--pe-accent); color: #fff !important; font-weight: 600; cursor: pointer; white-space: nowrap; }
.akpv-open:hover { background: var(--pe-accent-hover); }
.akpv-body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.akpv-page { position: relative; background: #f7f5f0; box-shadow: 0 6px 18px rgba(0,0,0,.45); }
.akpv-panel { position: absolute; background: #fff; overflow: hidden; }
.akpv-panel.empty { background: repeating-linear-gradient(135deg, #fff 0 6px, #f1eee6 6px 12px); }
.akpv-panel span { position: absolute; left: 6px; right: 6px; bottom: 3px; color: #4a473f; font-size: 9px; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.akpv-lines polygon { fill: none; stroke: #1d1d1f; stroke-width: 1.6; }
.akpv-num { position: absolute; margin: 3px 0 0 3px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #1d1d1f; color: #fff; font-size: 10.5px; display: flex; align-items: center; justify-content: center; }
.akpv-placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; border: 1.5px dashed var(--pe-line); border-radius: 8px; text-align: center; padding: 16px; }
.akpv-placeholder svg { color: var(--pe-accent); }
.akpv-placeholder b { font-size: 14px; }
.akpv-placeholder small { color: var(--pe-muted); max-width: 260px; }
.akpv-placeholder .akpv-open { height: 34px; padding: 0 18px; font-size: 13px; }
`;

export const PAGE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2.5" width="16" height="19" rx="1.5"/><path d="M4 10h16M12 10v11.5M12 15.5h8"/></svg>`;

export function installCss() {
    if (document.getElementById("akpe-style")) return;
    const style = document.createElement("style");
    style.id = "akpe-style";
    style.textContent = CSS;
    document.head.appendChild(style);
}

export function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function button(label, title, onClick, cls = "") {
    const b = el("button", `akpe-btn ${cls}`, label);
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}

export function section(title, ...children) {
    const sec = el("div", "akpe-sec");
    const head = el("div", "akpe-sec-title", title);
    head.addEventListener("click", () => sec.classList.toggle("closed"));
    sec.append(head, ...children);
    return sec;
}

export function field(label, ...children) {
    const f = el("div", "akpe-field");
    const row = el("div", "akpe-row");
    row.append(...children);
    f.append(el("label", null, label), row);
    return f;
}

function presetThumb(preset) {
    const layout = { page: { width: 30, height: 42 }, margin: 2, gutter: 1.4, direction: "ltr" };
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "30"); svg.setAttribute("height", "42");
    const bg = document.createElementNS(svgNS, "rect");
    Object.entries({ width: 30, height: 42, rx: 1.5, fill: "#f7f5f0" }).forEach(([k, v]) => bg.setAttribute(k, v));
    svg.appendChild(bg);
    for (const p of buildPreset(preset, layout)) {
        const r = document.createElementNS(svgNS, "rect");
        Object.entries({ x: p.x * 30, y: p.y * 42, width: p.w * 30, height: p.h * 42, fill: "#fff", stroke: "#1d1d1f", "stroke-width": 0.8 })
            .forEach(([k, v]) => r.setAttribute(k, v));
        svg.appendChild(r);
    }
    return svg;
}

// Tells ComfyUI's Ctrl+Z handler to leave the graph alone while an editor is open.
export function installUndoGuard(isOpen) {
    const C = app.constructor;
    const prev = C.maskeditor_is_opended;
    const hook = () => isOpen() || !!prev?.();
    C.maskeditor_is_opended = hook;
    return () => { if (C.maskeditor_is_opended === hook) C.maskeditor_is_opended = prev; };
}

class PageEditor {
    constructor(node, value, onSave) {
        this.node = node;
        this.onSave = onSave;
        this.layout = parseLayout(value);
        this.sel = this.layout.panels.length ? 0 : -1;
        this.zoom = 1;
        this.tool = "select";
        this.draft = null;
        this.undoStack = [];
        this.redoStack = [];
        this.drag = null;
        this.root = el("div", "akpe");
        this.root.tabIndex = 0;
        this.build();
        document.body.appendChild(this.root);
        this.guardOff = installUndoGuard(() => this.root.isConnected);
        this.render();
        this.root.focus({ preventScroll: true });
    }

    close(save) {
        if (save) this.onSave(JSON.stringify(this.layout));
        this.resizeObserver.disconnect();
        this.root.remove();
        this.guardOff();
    }

    widgetValue(name) { return this.node.widgets?.find((w) => w.name === name)?.value; }

    snapshot() {
        this.undoStack.push(JSON.stringify(this.layout));
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack = [];
    }

    restore(from, to) {
        if (!from.length) return;
        to.push(JSON.stringify(this.layout));
        this.layout = JSON.parse(from.pop());
        this.sel = Math.min(Math.max(this.sel, 0), this.layout.panels.length - 1);
        this.render();
    }

    changed(edited = false) {
        if (edited) this.layout.preset = null;
        this.render();
    }

    build() {
        // Header: title, zoom, history, close.
        const head = el("div", "akpe-head");
        const logo = el("div", "akpe-logo");
        logo.innerHTML = `${PAGE_ICON} Page Layout <span>Anima Komikku</span>`;
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

        // Left: page format, templates, panel tools.
        const left = el("div", "akpe-left");
        this.pageSelect = el("select");
        for (const p of PAGES) this.pageSelect.appendChild(new Option(`${p.name} · ${p.width}×${p.height}`, p.name));
        this.pageSelect.appendChild(new Option("Custom", "Custom"));
        this.pageSelect.addEventListener("change", () => {
            const page = PAGES.find((p) => p.name === this.pageSelect.value);
            this.snapshot();
            this.layout.page = page ? { ...page } : { ...this.layout.page, name: "Custom" };
            this.regenerate();
        });
        this.pageW = this.numberInput(10, 1, (v) => { this.layout.page = { ...this.layout.page, name: "Custom", width: v }; }, (v) => v > 0);
        this.pageH = this.numberInput(10, 1, (v) => { this.layout.page = { ...this.layout.page, name: "Custom", height: v }; }, (v) => v > 0);
        this.marginInput = this.numberInput(0, 1, (v) => { this.layout.margin = v; }, (v) => v >= 0);
        this.gutterInput = this.numberInput(0, 0.5, (v) => { this.layout.gutter = v; }, (v) => v >= 0);
        this.rtlBtn = button("← Manga", "Right to left: panel numbers and splits follow manga reading order", () => this.setDirection("rtl"), "outline");
        this.ltrBtn = button("Comic →", "Left to right: western comic reading order", () => this.setDirection("ltr"), "outline");
        const size = el("span", "akpe-x", "×");
        // Import: copy the panel layout of an existing page, which stays behind the panels as a reference.
        const file = el("input");
        file.type = "file";
        file.accept = "image/*";
        file.style.display = "none";
        file.addEventListener("change", () => { if (file.files[0]) this.importPage(file.files[0]); file.value = ""; });
        this.importBtn = button("📄 Import page…", "Copy the panel layout of an existing comic or manga page", () => file.click(), "outline");
        this.refOpacity = el("input");
        this.refOpacity.type = "range";
        Object.assign(this.refOpacity, { min: 0, max: 1, step: 0.05, title: "Reference opacity" });
        this.refOpacity.addEventListener("input", () => { this.layout.reference.opacity = Number(this.refOpacity.value); this.renderReference(); });
        this.refRow = field("Reference", this.refOpacity, button("✕", "Remove the reference page", () => { this.snapshot(); delete this.layout.reference; this.render(); }, "icon outline"));
        this.importNote = el("div", "akpe-import-note");
        this.importNote.style.display = "none";
        left.appendChild(section("Page",
            field("Format", this.pageSelect),
            field("Size", this.pageW, size, this.pageH),
            field("Margin", this.marginInput),
            field("Gutter", this.gutterInput),
            field("Reading", this.rtlBtn, this.ltrBtn),
            field("Import", this.importBtn, file),
            this.importNote,
            this.refRow));

        const templates = el("div", "akpe-templates");
        this.presetEls = new Map();
        for (const preset of PRESETS) {
            const item = el("div", "akpe-tpl");
            item.title = `${preset.name} (keeps the prompts in order)`;
            item.append(presetThumb(preset), el("span", null, preset.name));
            item.addEventListener("click", (e) => { e.stopPropagation(); this.applyPreset(preset.id); });
            templates.appendChild(item);
            this.presetEls.set(preset.id, item);
        }
        left.appendChild(section("Templates", templates));

        const toolRow = el("div", "akpe-toolrow");
        this.toolBtns = {
            select: button("▭ Draw", "Select, move and reshape panels; drag on empty paper to draw a rectangle (V)", () => this.setTool("select")),
            polygon: button("⬠ Polygon", "Click corner by corner to draw a free-form panel (P)", () => this.setTool("polygon")),
            knife: button("✂ Cut", "Drag a line across panels to cut them, slanted or straight (C)", () => this.setTool("knife")),
        };
        toolRow.append(...Object.values(this.toolBtns));
        const tools = el("div", "akpe-tools");
        this.splitVBtn = button("◫ Split ⇆", "Cut the selected panel into two side-by-side panels", () => this.split("x"), "outline");
        this.splitHBtn = button("⊟ Split ⇅", "Cut the selected panel into two stacked panels", () => this.split("y"), "outline");
        this.dupBtn = button("⧉ Duplicate", "Duplicate the selected panel", () => this.duplicate(), "outline");
        this.delBtn = button("✕ Delete", "Delete the selected panel (Del)", () => this.remove(), "outline danger");
        this.earlierBtn = button("▲ Earlier", "Move this panel one number earlier", () => this.move(-1), "outline");
        this.laterBtn = button("▼ Later", "Move this panel one number later", () => this.move(1), "outline");
        this.shapeBtn = button("⬠ Edit corners", "Turn the panel into a polygon so its corners can be dragged to slant its sides", () => this.toggleShape(), "outline");
        tools.append(this.splitVBtn, this.splitHBtn, this.dupBtn, this.delBtn, this.earlierBtn, this.laterBtn);
        this.autoBtn = button("↻ Renumber in reading order", "Renumber all panels in the page's reading order", () => this.autoNumber(), "outline");
        this.clearBtn = button("Clear page", "Remove all panels", () => { this.snapshot(); this.layout.panels = []; this.layout.preset = null; this.sel = -1; this.render(); }, "outline danger");
        left.appendChild(section("Panel", toolRow, tools, this.shapeBtn, this.autoBtn, this.clearBtn));

        // Stage: page canvas.
        const stage = el("div", "akpe-stage");
        this.canvas = el("div", "akpe-canvas");
        this.page = el("div", "akpe-page");
        this.canvas.appendChild(this.page);
        const foot = el("div", "akpe-foot");
        this.sizeLabel = el("div", "akpe-size");
        this.hint = el("div", "akpe-hint");
        foot.append(this.hint, this.sizeLabel);
        this.guide = document.createElementNS(SVG_NS, "svg");
        this.guide.setAttribute("class", "akpe-guide");
        this.guide.setAttribute("viewBox", "0 0 1 1");
        this.guide.setAttribute("preserveAspectRatio", "none");
        stage.append(this.canvas, foot);

        // Right: selected panel prompt, panel list, save.
        const right = el("div", "akpe-right");
        const card = el("div", "akpe-shot-card");
        const shotHead = el("div", "akpe-shot-head");
        this.badge = el("div", "akpe-badge");
        const headText = el("div");
        headText.style.flex = "1";
        this.title = el("div", "akpe-title");
        this.meta = el("div", "akpe-meta");
        headText.append(this.title, this.meta);
        const nav = el("div", "akpe-seg");
        this.prevBtn = button("‹", "Previous panel", () => this.select(this.sel - 1), "icon");
        this.nextBtn = button("›", "Next panel", () => this.select(this.sel + 1), "icon");
        nav.append(this.prevBtn, this.nextBtn);
        shotHead.append(this.badge, headText, nav);
        this.chips = el("div", "akpe-chips");
        this.prefix = el("div", "akpe-prefix");
        this.prompt = el("textarea");
        this.prompt.placeholder = "Anima tags for this panel, framing first: 1girl, solo, close-up, from below, rain, night, city ...";
        this.prompt.addEventListener("focus", () => { this.typingSnapshot = false; });
        this.prompt.addEventListener("input", () => {
            const p = this.layout.panels[this.sel];
            if (!p) return;
            if (!this.typingSnapshot) { this.snapshot(); this.typingSnapshot = true; }
            p.prompt = this.prompt.value;
            this.renderPanels();
            this.renderShots();
            this.undoBtn.disabled = false;
        });
        this.noSel = el("div", "akpe-empty", "Select a panel to write its prompt.");
        this.assistHost = el("div");
        card.append(shotHead, this.chips, this.prefix, this.prompt, this.assistHost, this.noSel);

        const list = el("div", "akpe-shots-card");
        this.listTitle = el("div", "akpe-sec-title");
        this.listTitle.style.cursor = "default";
        this.shots = el("div", "akpe-shots");
        list.append(this.listTitle, this.shots);

        const actions = el("div", "akpe-actions");
        actions.append(button("Cancel", "Close without saving", () => this.close(false), "outline"),
            button("💾 Save", "Save the page to the node", () => this.close(true), "primary"));
        right.append(card, list, actions);

        this.root.append(head, left, stage, right);

        this.page.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        this.page.addEventListener("pointermove", (e) => this.onPointerMove(e));
        this.page.addEventListener("pointerup", (e) => this.onPointerUp(e));
        this.page.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        this.page.addEventListener("dblclick", (e) => this.onDoubleClick(e));
        this.canvas.addEventListener("wheel", (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }, { passive: false });
        this.root.addEventListener("keydown", (e) => this.onKey(e));
        for (const type of ["keyup", "keypress", "paste", "copy", "cut"]) this.root.addEventListener(type, (e) => e.stopPropagation());
        this.resizeObserver = new ResizeObserver(() => this.fitPage());
        this.resizeObserver.observe(this.canvas);
    }

    numberInput(min, step, apply, valid) {
        const input = el("input");
        input.type = "number";
        input.min = min;
        input.step = step;
        input.addEventListener("change", () => {
            const v = Number(input.value);
            if (!valid(v)) return this.render();
            this.snapshot();
            apply(v);
            this.regenerate();
        });
        return input;
    }

    setZoom(z) {
        this.zoom = Math.min(6, Math.max(0.3, z));
        this.fitPage();
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

    async importPage(file) {
        this.importBtn.disabled = true;
        this.hint.textContent = "Finding panels… (the first import loads WeVisOne-VL, when installed)";
        try {
            const { layout, warning } = await importPageLayout(file, this.layout);
            this.snapshot();
            this.layout = layout;
            this.sel = 0;
            this.render();
            this.importNote.textContent = warning ?? "";
            this.importNote.style.display = warning ? "" : "none";
        } catch (err) {
            this.hint.textContent = `Could not import the page: ${err.message}.`;
        } finally {
            this.importBtn.disabled = false;
        }
    }

    renderReference() {
        const ref = this.layout.reference;
        this.page.classList.toggle("has-ref", !!ref);
        this.refRow.style.display = ref ? "" : "none";
        if (!ref) { this.refImg?.remove(); this.refImg = null; return; }
        if (!this.refImg) this.refImg = el("img", "akpe-ref");
        if (this.refImg.dataset.name !== ref.image) { this.refImg.src = inputUrl(ref.image); this.refImg.dataset.name = ref.image; }
        this.refImg.style.opacity = ref.opacity;
        this.refOpacity.value = ref.opacity;
        if (this.page.firstChild !== this.refImg) this.page.prepend(this.refImg);
    }

    setDirection(dir) {
        if (this.layout.direction === dir) return;
        this.snapshot();
        this.layout.direction = dir;
        this.regenerate();
    }

    regenerate() {
        // Spacing and page changes rebuild the panels only while the layout is still an untouched template.
        const preset = PRESETS.find((p) => p.id === this.layout.preset);
        if (preset) this.layout.panels = withShots(buildPreset(preset, this.layout), this.layout.panels);
        this.changed();
    }

    applyPreset(id) {
        this.snapshot();
        this.layout.preset = id;
        this.layout.panels = withShots(buildPreset(PRESETS.find((p) => p.id === id), this.layout), this.layout.panels);
        this.sel = 0;
        this.changed();
    }

    select(i) {
        if (i < 0 || i >= this.layout.panels.length) return;
        this.sel = i;
        this.render();
    }

    split(axis) {
        const p = this.layout.panels[this.sel];
        if (!p) return;
        const pieces = splitPanel(p, axis, this.layout);
        if (!pieces) return;
        this.snapshot();
        this.layout.panels.splice(this.sel, 1, ...pieces);
        this.changed(true);
    }

    // Cuts every panel the dragged segment crosses.
    applyCut(a, b) {
        const cut = knifeCut(this.layout, a, b);
        if (!cut) return;
        this.snapshot();
        this.sel = cut.first;
        this.layout.panels = cut.panels;
        this.changed(true);
    }

    duplicate() {
        const p = this.layout.panels[this.sel];
        if (!p) return;
        this.snapshot();
        this.layout.panels.splice(this.sel + 1, 0, translated(p, Math.min(0.03, 1 - p.x - p.w), Math.min(0.03, 1 - p.y - p.h)));
        this.sel += 1;
        this.changed(true);
    }

    toggleShape() {
        const p = this.layout.panels[this.sel];
        if (!p) return;
        this.snapshot();
        if (p.polygon) delete p.polygon;
        else p.polygon = corners(p);
        this.changed(true);
    }

    setTool(tool) {
        this.tool = tool;
        this.draft = null;
        this.renderGuide();
        this.render();
    }

    finishPolygon() {
        const pts = this.draft;
        this.draft = null;
        this.renderGuide();
        const W = this.layout.page.width, H = this.layout.page.height;
        if (!pts || pts.length < 3 || polygonArea(pts.map(([x, y]) => [x * W, y * H])) < 25) return;
        this.snapshot();
        this.layout.panels.push(shapeFrom({ prompt: "" }, pts));
        this.sel = this.layout.panels.length - 1;
        this.tool = "select";
        this.changed(true);
        this.prompt.focus();
    }

    remove() {
        if (!this.layout.panels[this.sel]) return;
        this.snapshot();
        this.layout.panels.splice(this.sel, 1);
        this.sel = Math.min(this.sel, this.layout.panels.length - 1);
        this.changed(true);
    }

    move(delta) {
        const j = this.sel + delta;
        if (!this.layout.panels[this.sel] || j < 0 || j >= this.layout.panels.length) return;
        this.snapshot();
        const ps = this.layout.panels;
        [ps[this.sel], ps[j]] = [ps[j], ps[this.sel]];
        this.sel = j;
        this.changed();
    }

    autoNumber() {
        const current = this.layout.panels[this.sel];
        this.snapshot();
        this.layout.panels = readingOrder(this.layout.panels, this.layout.direction);
        this.sel = this.layout.panels.indexOf(current);
        this.changed();
    }

    pointerPos(e) {
        const r = this.page.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    }

    snapLines(skip) {
        const mx = this.layout.margin / this.layout.page.width, my = this.layout.margin / this.layout.page.height;
        const gx = this.layout.gutter / this.layout.page.width, gy = this.layout.gutter / this.layout.page.height;
        const xs = [0, 1, mx, 1 - mx], ys = [0, 1, my, 1 - my];
        this.layout.panels.forEach((p, i) => {
            if (i === skip) return;
            xs.push(p.x, p.x + p.w, p.x - gx, p.x + p.w + gx);
            ys.push(p.y, p.y + p.h, p.y - gy, p.y + p.h + gy);
            for (const [x, y] of p.polygon ?? []) { xs.push(x); ys.push(y); }
        });
        return { xs, ys };
    }

    snapPoint(pos, free, extra = []) {
        const { xs, ys } = this.snapLines(this.sel);
        for (const [x, y] of extra) { xs.push(x); ys.push(y); }
        const clamp = (v) => Math.min(1, Math.max(0, v));
        return [this.snap(clamp(pos.x), xs, free).v, this.snap(clamp(pos.y), ys, free).v];
    }

    snap(value, lines, disabled) {
        if (disabled) return { v: value, d: Infinity };
        let best = { v: value, d: SNAP };
        for (const l of lines) {
            const d = Math.abs(l - value);
            if (d < best.d) best = { v: l, d };
        }
        return best;
    }

    onPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        const pos = this.pointerPos(e);
        if (this.tool === "polygon") {
            const pt = this.snapPoint(pos, e.altKey, this.draft ?? []);
            const first = this.draft?.[0];
            if (first && this.draft.length >= 3 && Math.hypot((pt[0] - first[0]) * this.page.clientWidth, (pt[1] - first[1]) * this.page.clientHeight) < 10) return this.finishPolygon();
            this.draft = [...(this.draft ?? []), pt];
            this.renderGuide(pos);
            return;
        }
        if (this.tool === "knife") {
            this.drag = { mode: "knife", start: pos, end: pos, moved: false };
            this.page.setPointerCapture(e.pointerId);
            return;
        }
        const handle = e.target.dataset?.handle;
        const vertex = e.target.dataset?.vertex, mid = e.target.dataset?.mid;
        const panelEl = e.target.closest(".akpe-panel");
        if (vertex != null) {
            this.drag = { mode: "vertex", index: Number(vertex), start: pos, moved: false };
        } else if (mid != null) {
            // Dragging an edge dot inserts a corner there.
            this.snapshot();
            const p = this.layout.panels[this.sel];
            const i = Number(mid);
            const a = p.polygon[i], b = p.polygon[(i + 1) % p.polygon.length];
            p.polygon.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            this.drag = { mode: "vertex", index: i + 1, start: pos, moved: true };
            this.renderPanels();
        } else if (handle) {
            this.drag = { mode: "resize", handle, start: pos, orig: { ...this.layout.panels[this.sel] }, moved: false };
        } else if (panelEl) {
            this.sel = Number(panelEl.dataset.index);
            this.drag = { mode: "move", start: pos, orig: { ...this.layout.panels[this.sel] }, moved: false };
            this.render();
        } else {
            this.drag = { mode: "draw", start: pos, moved: false };
        }
        this.page.setPointerCapture(e.pointerId);
    }

    onPointerMove(e) {
        const d = this.drag;
        const pos = this.pointerPos(e);
        if (this.tool === "polygon" && this.draft) return this.renderGuide(pos);
        if (!d) return;
        const dx = pos.x - d.start.x, dy = pos.y - d.start.y;
        if (!d.moved) {
            if (Math.hypot(dx, dy) < 0.006) return;
            d.moved = true;
            if (d.mode !== "draw" && d.mode !== "knife") this.snapshot();
        }
        const free = e.altKey;
        if (d.mode === "knife") {
            d.end = pos;
            if (e.shiftKey) {
                // Shift keeps the cut at 15° steps, measured on the page (not in page fractions).
                const W = this.layout.page.width, H = this.layout.page.height;
                const ang = Math.round(Math.atan2(dy * H, dx * W) / (Math.PI / 12)) * (Math.PI / 12);
                const len = Math.hypot(dx * W, dy * H);
                d.end = { x: d.start.x + Math.cos(ang) * len / W, y: d.start.y + Math.sin(ang) * len / H };
            }
            return this.renderGuide(null, [d.start, d.end]);
        }
        if (d.mode === "vertex") {
            const p = this.layout.panels[this.sel];
            const others = p.polygon.filter((_, k) => k !== d.index);
            p.polygon[d.index] = this.snapPoint(pos, free, others);
            setPolygon(p, p.polygon);
            this.layout.preset = null;
            this.renderPanels();
            this.renderSide();
            return;
        }
        if (d.mode === "draw") {
            const { xs, ys } = this.snapLines(-1);
            const clamp = (v) => Math.min(1, Math.max(0, v));
            const x0 = this.snap(clamp(d.start.x), xs, free).v, y0 = this.snap(clamp(d.start.y), ys, free).v;
            const x1 = this.snap(clamp(pos.x), xs, free).v, y1 = this.snap(clamp(pos.y), ys, free).v;
            d.rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
            this.renderGhost(d.rect);
            return;
        }
        const p = this.layout.panels[this.sel];
        const { xs, ys } = this.snapLines(this.sel);
        const o = d.orig;
        if (d.mode === "move") {
            let x = Math.min(1 - o.w, Math.max(0, o.x + dx)), y = Math.min(1 - o.h, Math.max(0, o.y + dy));
            const sl = this.snap(x, xs, free), sr = this.snap(x + o.w, xs, free);
            x = sl.d <= sr.d ? sl.v : sr.v - o.w;
            const st = this.snap(y, ys, free), sb = this.snap(y + o.h, ys, free);
            y = st.d <= sb.d ? st.v : sb.v - o.h;
            Object.assign(p, translated(o, Math.min(1 - o.w, Math.max(0, x)) - o.x, Math.min(1 - o.h, Math.max(0, y)) - o.y));
        } else {
            let left = o.x, right = o.x + o.w, top = o.y, bottom = o.y + o.h;
            const h = d.handle;
            if (h.includes("w")) left = Math.min(right - MIN_SIZE, Math.max(0, this.snap(o.x + dx, xs, free).v));
            if (h.includes("e")) right = Math.max(left + MIN_SIZE, Math.min(1, this.snap(o.x + o.w + dx, xs, free).v));
            if (h.includes("n")) top = Math.min(bottom - MIN_SIZE, Math.max(0, this.snap(o.y + dy, ys, free).v));
            if (h.includes("s")) bottom = Math.max(top + MIN_SIZE, Math.min(1, this.snap(o.y + o.h + dy, ys, free).v));
            Object.assign(p, { x: left, y: top, w: right - left, h: bottom - top });
        }
        this.layout.preset = null;
        this.renderPanels();
        this.renderSide();
    }

    onPointerUp(e) {
        const d = this.drag;
        this.drag = null;
        if (this.page.hasPointerCapture?.(e.pointerId)) this.page.releasePointerCapture(e.pointerId);
        this.ghost?.remove();
        this.ghost = null;
        if (!d) return;
        if (d.mode === "knife") {
            this.renderGuide();
            if (d.moved) this.applyCut([d.start.x, d.start.y], [d.end.x, d.end.y]);
        } else if (d.mode === "draw") {
            if (d.rect && d.rect.w >= MIN_SIZE && d.rect.h >= MIN_SIZE) {
                this.snapshot();
                this.layout.panels.push({ ...d.rect, prompt: "" });
                this.sel = this.layout.panels.length - 1;
                this.changed(true);
                this.prompt.focus();
            } else if (!d.moved) {
                this.sel = -1;
                this.render();
            }
        } else if (d.moved) {
            this.changed(true);
        } else if (d.mode === "move") {
            this.prompt.focus();
        }
    }

    onDoubleClick(e) {
        if (this.tool === "polygon") return this.finishPolygon();
        const vertex = e.target.dataset?.vertex;
        const p = this.layout.panels[this.sel];
        if (vertex == null || !p?.polygon || p.polygon.length <= 3) return;
        this.snapshot();
        p.polygon.splice(Number(vertex), 1);
        setPolygon(p, p.polygon);
        this.changed(true);
    }

    onKey(e) {
        // Keys never reach ComfyUI while the editor is open.
        e.stopPropagation();
        if (e.target.closest("textarea, input, select")) {
            if (e.key === "Escape") this.root.focus({ preventScroll: true });
            return;
        }
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        let handled = true;
        if (this.draft && (e.key === "Enter" || e.key === "Escape")) {
            if (e.key === "Enter") this.finishPolygon();
            else { this.draft = null; this.renderGuide(); }
        } else if (this.draft && e.key === "Backspace") {
            this.draft.pop();
            this.renderGuide();
        } else if (!mod && ["v", "p", "c"].includes(key)) this.setTool({ v: "select", p: "polygon", c: "knife" }[key]);
        else if (e.key === "Delete" || e.key === "Backspace") this.remove();
        else if (mod && key === "z" && !e.shiftKey) this.restore(this.undoStack, this.redoStack);
        else if (mod && (key === "y" || (key === "z" && e.shiftKey))) this.restore(this.redoStack, this.undoStack);
        else if (mod && key === "s") this.close(true);
        else if (e.key === "Tab" && this.layout.panels.length) this.select((this.sel + (e.shiftKey ? -1 : 1) + this.layout.panels.length) % this.layout.panels.length);
        else if (e.key === "Enter" && this.sel >= 0) this.prompt.focus();
        else if (e.key === "Escape") { this.sel = -1; this.render(); }
        else handled = false;
        if (handled) e.preventDefault();
    }

    // Live guide for the polygon being drawn or the cut line.
    renderGuide(pointer = null, line = null) {
        this.guide.replaceChildren();
        if (this.draft) {
            const poly = document.createElementNS(SVG_NS, "polyline");
            const pts = pointer ? [...this.draft, [pointer.x, pointer.y]] : this.draft;
            poly.setAttribute("points", pts.map((q) => q.join(",")).join(" "));
            poly.setAttribute("vector-effect", "non-scaling-stroke");
            this.guide.appendChild(poly);
        }
        if (line) {
            const l = document.createElementNS(SVG_NS, "line");
            Object.entries({ x1: line[0].x, y1: line[0].y, x2: line[1].x, y2: line[1].y }).forEach(([k, v]) => l.setAttribute(k, v));
            l.setAttribute("vector-effect", "non-scaling-stroke");
            this.guide.appendChild(l);
        }
    }

    renderGhost(r) {
        if (!this.ghost) { this.ghost = el("div", "akpe-ghost"); this.page.appendChild(this.ghost); }
        Object.assign(this.ghost.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    }

    aspect(p) { return (p.w * this.layout.page.width) / (p.h * this.layout.page.height); }

    pixelSize(p) {
        const mp = Number(this.widgetValue("panel_megapixels")) || 1;
        const a = this.aspect(p);
        const w = Math.sqrt(mp * 1024 * 1024 * a);
        return [Math.max(16, Math.round(w / 16) * 16), Math.max(16, Math.round(w / a / 16) * 16)];
    }

    render() {
        const L = this.layout;
        this.pageSelect.value = PAGES.some((p) => p.name === L.page.name) ? L.page.name : "Custom";
        this.pageW.value = L.page.width;
        this.pageH.value = L.page.height;
        this.marginInput.value = L.margin;
        this.gutterInput.value = L.gutter;
        this.rtlBtn.classList.toggle("on", L.direction === "rtl");
        this.ltrBtn.classList.toggle("on", L.direction === "ltr");
        this.undoBtn.disabled = !this.undoStack.length;
        this.redoBtn.disabled = !this.redoStack.length;
        for (const [id, item] of this.presetEls) item.classList.toggle("active", id === L.preset);
        const has = !!L.panels[this.sel];
        for (const b of [this.splitVBtn, this.splitHBtn, this.dupBtn, this.delBtn, this.shapeBtn]) b.disabled = !has;
        this.shapeBtn.textContent = L.panels[this.sel]?.polygon ? "▭ Make rectangle" : "⬠ Edit corners";
        for (const [name, b] of Object.entries(this.toolBtns)) b.classList.toggle("on", name === this.tool);
        this.hint.textContent = {
            select: "Drag on paper = new panel · drag panel = move · drag corners to reshape · dots on edges add a corner, double-click a corner removes it · Alt = no snap",
            polygon: "Click to add corners · click the first corner, double-click or Enter to close · Backspace removes the last corner · Esc cancels · Alt = no snap",
            knife: "Drag a line across one or more panels to cut them along it, keeping the gutter · Shift = 15° steps",
        }[this.tool];
        this.earlierBtn.disabled = !has || this.sel === 0;
        this.laterBtn.disabled = !has || this.sel === L.panels.length - 1;
        this.autoBtn.disabled = L.panels.length < 2;
        this.clearBtn.disabled = !L.panels.length;
        this.sizeLabel.textContent = `${L.page.name} · ${L.page.width}×${L.page.height} · ${L.panels.length} panels`;
        this.fitPage();
        this.renderReference();
        this.renderPanels();
        this.renderSide();
        this.renderShots();
    }

    renderPanels() {
        const L = this.layout;
        this.page.querySelectorAll(".akpe-handle, .akpe-vertex, .akpe-mid, .akpe-safe, .akpe-blank").forEach((n) => n.remove());
        const mx = L.margin / L.page.width, my = L.margin / L.page.height;
        const safe = el("div", "akpe-safe");
        Object.assign(safe.style, { left: `${mx * 100}%`, top: `${my * 100}%`, right: `${mx * 100}%`, bottom: `${my * 100}%` });
        this.page.appendChild(safe);
        if (!L.panels.length) {
            const blank = el("div", "akpe-blank");
            blank.append(el("b", null, "Empty page"), el("span", null, "Pick a template on the left, or drag on the paper to draw panels."));
            this.page.appendChild(blank);
        }
        drawPanels(this.page, L, "akpe", this.sel, "Click to write this panel");
        this.page.querySelectorAll(".akpe-num").forEach((n, i) => n.appendChild(el("i", null, nearestRatio(this.aspect(L.panels[i])))));
        if (!this.guide.isConnected) this.page.appendChild(this.guide);
        const p = L.panels[this.sel];
        if (!p || this.tool !== "select") return;
        if (p.polygon) {
            p.polygon.forEach(([x, y], i) => {
                const [nx, ny] = p.polygon[(i + 1) % p.polygon.length];
                const v = el("div", "akpe-vertex");
                v.dataset.vertex = i;
                v.title = "Drag to move this corner · double-click to remove it";
                Object.assign(v.style, { left: `${x * 100}%`, top: `${y * 100}%` });
                const m = el("div", "akpe-mid");
                m.dataset.mid = i;
                m.title = "Drag to add a corner here";
                Object.assign(m.style, { left: `${(x + nx) / 2 * 100}%`, top: `${(y + ny) / 2 * 100}%` });
                this.page.append(m, v);
            });
            return;
        }
        const points = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
        const cursors = { nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw", n: "ns", s: "ns", e: "ew", w: "ew" };
        for (const [name, [fx, fy]] of Object.entries(points)) {
            const h = el("div", "akpe-handle");
            h.dataset.handle = name;
            Object.assign(h.style, { left: `${(p.x + p.w * fx) * 100}%`, top: `${(p.y + p.h * fy) * 100}%`, cursor: `${cursors[name]}-resize` });
            this.page.appendChild(h);
        }
    }

    renderSide() {
        const L = this.layout;
        const p = L.panels[this.sel];
        for (const n of [this.chips, this.prefix, this.prompt, this.assistHost]) n.style.display = p ? "" : "none";
        this.noSel.style.display = p ? "none" : "";
        this.prevBtn.disabled = !p || this.sel === 0;
        this.nextBtn.disabled = !p || this.sel === L.panels.length - 1;
        if (!p) {
            this.badge.textContent = "–";
            this.title.textContent = "No panel selected";
            this.meta.textContent = L.panels.length ? "Click a panel on the page" : "The page has no panels yet";
            return;
        }
        const [w, h] = this.pixelSize(p);
        this.badge.textContent = this.sel + 1;
        this.title.textContent = `Panel ${this.sel + 1}`;
        this.meta.textContent = `of ${L.panels.length}`;
        this.chips.replaceChildren(el("span", "akpe-chip accent", nearestRatio(this.aspect(p))), el("span", "akpe-chip", `${w}×${h} px`));
        this.prefix.textContent = "Generated as its own image, after the quality and style tags.";
        if (document.activeElement !== this.prompt || this.prompt.value !== p.prompt) this.prompt.value = p.prompt;
        // One assist panel per selected panel, so a pending proposal never lands on another panel.
        if (this.assistFor !== p) {
            this.assistFor = p;
            this.assistHost.replaceChildren(assistPanel(this.node, el, button,
                [{ label: "✨ Enhance with CLIP", title: "Rewrite this panel as richer Anima tags", run: (loader) => this.enhancePanel(loader, p) }],
                (text) => { this.snapshot(); p.prompt = text; this.render(); }));
        }
    }

    enhancePanel(loader, p) {
        const i = this.layout.panels.indexOf(p);
        const panels = this.layout.panels;
        const a = this.aspect(p);
        const system = "You write the prompt of one manga or comic panel for Anima, an anime image model prompted with Danbooru tags. "
            + "Rewrite and enrich the given panel as comma-separated Danbooru tags: the people count (1girl, 1boy, 2girls, solo...), the framing (close-up, upper body, cowboy shot, full body, wide shot, from below, from above, dutch angle...), "
            + "then pose, action, expression, setting, lighting and mood. A short natural-language phrase may follow the tags to say who is on the left or right. "
            + "Never name a character, an artist or a style, and never describe a character's face, hair or outfit: a reference image already gives them. "
            + "Frame it for the panel's aspect ratio. Do not mention the panel, the page or the aspect ratio. Output only the prompt, in English.";
        const lines = [
            `This is panel ${i + 1} of ${panels.length}; it is ${nearestRatio(a)} (${a > 1.15 ? "wide" : a < 0.87 ? "tall" : "about square"}).`,
            i > 0 ? `Previous panel: ${panels[i - 1].prompt.trim() || "(not written yet)"}` : "This is the first panel of the page.",
            i < panels.length - 1 ? `Next panel: ${panels[i + 1].prompt.trim() || "(not written yet)"}` : "This is the last panel of the page.",
            p.prompt.trim() ? `Panel to enrich: ${p.prompt.trim()}` : "This panel is empty: write one that fits between the previous and next panels.",
        ];
        return generateText(loader, system, lines.join("\n"));
    }

    renderShots() {
        const L = this.layout;
        const missing = L.panels.filter((p) => !p.prompt.trim()).length;
        this.listTitle.textContent = missing ? `Panels · ${missing} without prompt` : `Panels · ${L.panels.length}`;
        this.shots.replaceChildren(...L.panels.map((p, i) => {
            const row = el("div", `akpe-shot${i === this.sel ? " sel" : ""}`);
            row.append(el("b", null, String(i + 1)), el("span", p.prompt.trim() ? null : "todo", p.prompt.trim() || "No prompt yet"),
                el("i", null, nearestRatio(this.aspect(p))));
            row.addEventListener("click", (e) => { e.stopPropagation(); this.select(i); });
            return row;
        }));
        if (!L.panels.length) this.shots.appendChild(el("div", "akpe-empty", "Pick a template or draw panels on the page."));
    }
}

// Compact node body: an "open editor" placeholder until the page has panels, then a live preview of the page.
class PagePreview {
    constructor(node, value) {
        this.node = node;
        this.value = value;
        this.root = el("div", "akpv");
        this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
        new ResizeObserver(() => this.fit()).observe(this.root);
        this.render();
    }

    open() {
        if (this.editor?.root.isConnected) return;
        this.editor = new PageEditor(this.node, this.value, (value) => {
            this.value = value;
            this.render();
            this.node.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
        });
    }

    openButton(label) {
        const b = el("button", "akpv-open");
        b.innerHTML = `${PAGE_ICON.replace(/22/g, "15")} ${label}`;
        b.addEventListener("click", (e) => { e.stopPropagation(); this.open(); });
        return b;
    }

    render() {
        const L = parseLayout(this.value);
        this.layout = L;
        this.pageEl = null;
        if (!L.panels.length) {
            const box = el("div", "akpv-placeholder");
            const icon = el("div");
            icon.innerHTML = PAGE_ICON.replace(/22/g, "40");
            box.append(icon, el("b", null, "No page layout yet"),
                el("small", null, "Design the manga page: pick a template or draw panels, number them and write one prompt per panel."),
                this.openButton("Open Page Editor"));
            this.root.replaceChildren(box);
            return;
        }
        const missing = L.panels.filter((p) => !p.prompt.trim()).length;
        const bar = el("div", "akpv-bar");
        const sum = el("div", "akpv-sum");
        sum.innerHTML = `<b>${L.panels.length} panels</b> · ${L.page.name} · ${L.direction === "rtl" ? "manga ←" : "comic →"}`;
        if (missing) sum.append(" · ", el("span", "todo", `${missing} without prompt`));
        bar.append(sum, this.openButton("Edit page"));
        const body = el("div", "akpv-body");
        body.title = "Open the page editor";
        body.addEventListener("click", () => this.open());
        this.pageEl = el("div", "akpv-page");
        drawPanels(this.pageEl, L, "akpv");
        body.appendChild(this.pageEl);
        this.body = body;
        this.root.replaceChildren(bar, body);
        this.fit();
    }

    fit() {
        if (!this.pageEl) return;
        const aw = this.body.clientWidth - 8, ah = this.body.clientHeight - 8;
        if (aw <= 0 || ah <= 0) return;
        const ratio = this.layout.page.width / this.layout.page.height;
        const w = Math.min(aw, ah * ratio);
        this.pageEl.style.width = `${w}px`;
        this.pageEl.style.height = `${w / ratio}px`;
    }
}

app.registerExtension({
    name: "AnimaKomikku.PageLayoutEditor",
    setup() { installCss(); },
    getCustomWidgets() {
        return {
            ANIMA_KOMIKKU_PAGE_LAYOUT(node, inputName, inputData) {
                const preview = new PagePreview(node, inputData[1]?.default);
                node.__komikkuPreview = preview;
                const widget = node.addDOMWidget(inputName, "ANIMA_KOMIKKU_PAGE_LAYOUT", preview.root, {
                    getValue: () => preview.value,
                    setValue: (v) => { preview.value = v; preview.render(); },
                    getMinHeight: () => 330,
                });
                const onRemoved = node.onRemoved;
                node.onRemoved = function () { preview.editor?.close(false); return onRemoved?.apply(this, arguments); };
                return { widget };
            },
        };
    },
    nodeCreated(node) {
        if (node.comfyClass === NODE_CLASS && node.size[0] < 420) node.setSize([420, node.size[1]]);
    },
});
