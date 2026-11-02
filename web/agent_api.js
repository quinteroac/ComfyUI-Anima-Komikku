import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    PAGES, PRESETS, buildPreset, withShots, splitPanel, knifeCut, readingOrder, nearestRatio, shapeFrom, corners, parseLayout, importPageLayout,
} from "./page_layout_editor.js";
import { TEXT_TYPES, newText, parseComposition, drawPage, exportLettering, fontString } from "./page_compose_editor.js";

// window.animaKomikku: scriptable access to the two Komikku editors for agents and scripts (see docs/AGENT_API.md).
// Every call edits the node's widget value, the same JSON the editors save, so the result opens in the editors and runs
// like a hand-made page. Panels are numbered from 1 as in the editors; positions inside a panel are fractions of its box.

function findNode(type, id) {
    const nodes = (app.graph?.nodes ?? []).filter((n) => n.comfyClass === type);
    const node = id == null ? nodes[0] : nodes.find((n) => n.id === id);
    if (!node) throw new Error(id == null ? `no ${type} node in the graph` : `no ${type} node with id ${id}`);
    return node;
}

function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function writeWidget(node, name, value) {
    if (node.__komikkuPreview?.editor?.root.isConnected) throw new Error("the editor of this node is open: close it before scripting the node");
    widget(node, name).value = JSON.stringify(value);
    node.setDirtyCanvas?.(true, true);
    app.graph?.change?.();
}

function panelAt(layout, n) {
    const p = layout.panels[n - 1];
    if (!p) throw new Error(`panel ${n} does not exist: the page has ${layout.panels.length} panels`);
    return p;
}

const round = (v) => Math.round(v * 1000) / 1000;

function aspect(p, layout) {
    return p.w * layout.page.width / (p.h * layout.page.height);
}

function insidePolygon(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

const STORY = ["quality", "style"];

class LayoutApi {
    constructor(node) { this.node = node; }

    get() { return parseLayout(widget(this.node, "layout").value); }

    set(layout) {
        writeWidget(this.node, "layout", layout);
        return this.describe();
    }

    edit(fn) {
        const layout = this.get();
        fn(layout);
        return this.set(layout);
    }

    // A value linked from another node is read and written at its source.
    valueWidget(name) {
        const slot = this.node.inputs?.findIndex((i) => i.name === name && i.link != null);
        const source = slot >= 0 ? this.node.getInputNode(slot) : null;
        return source ? source.widgets?.[0] : widget(this.node, name);
    }

    // The tags written before every panel prompt: quality tags and the artist style tags.
    story(values = {}) {
        for (const [name, value] of Object.entries(values)) {
            const w = STORY.includes(name) && this.valueWidget(name);
            if (!w) throw new Error(`unknown story field "${name}": use ${STORY.join(", ")}`);
            w.value = value;
        }
        if (Object.keys(values).length) { this.node.setDirtyCanvas?.(true, true); app.graph?.change?.(); }
        return Object.fromEntries(STORY.map((name) => [name, this.valueWidget(name)?.value]));
    }

    describe() {
        const L = this.get();
        return {
            story: this.story(), page: L.page, margin: L.margin, gutter: L.gutter, direction: L.direction, template: L.preset, reference: L.reference?.image ?? null,
            panels: L.panels.map((p, i) => ({
                n: i + 1, aspect: nearestRatio(aspect(p, L)), shape: p.polygon ? "polygon" : "rect", box: [p.x, p.y, p.w, p.h].map(round),
                prompt: p.prompt,
            })),
        };
    }

    // format: a page name from animaKomikku.pages(), or { width, height } in mm. A page still on its template is rebuilt.
    page({ format, width, height, margin, gutter, direction } = {}) {
        return this.edit((L) => {
            if (format) {
                const page = PAGES.find((p) => p.name.toLowerCase() === format.toLowerCase());
                if (!page) throw new Error(`unknown page format "${format}": use one of ${PAGES.map((p) => p.name).join(", ")}`);
                L.page = { ...page };
            }
            if (width && height) L.page = { name: "Custom", width, height };
            if (margin != null) L.margin = margin;
            if (gutter != null) L.gutter = gutter;
            if (direction) L.direction = direction;
            const preset = PRESETS.find((p) => p.id === L.preset);
            if (preset) L.panels = withShots(buildPreset(preset, L), L.panels);
        });
    }

    template(id) {
        const preset = PRESETS.find((p) => p.id === id);
        if (!preset) throw new Error(`unknown template "${id}": use one of ${PRESETS.map((p) => p.id).join(", ")}`);
        return this.edit((L) => { L.preset = id; L.panels = withShots(buildPreset(preset, L), L.panels); });
    }

    split(n, axis, { at = 0.5, slant = 0 } = {}) {
        return this.edit((L) => {
            const pieces = splitPanel(panelAt(L, n), axis, L, at, slant);
            if (!pieces) throw new Error(`panel ${n} is too small to split there`);
            L.panels.splice(n - 1, 1, ...pieces);
            L.preset = null;
        });
    }

    // Knife cut along the segment a-b in page fractions; every panel it crosses is cut.
    cut(a, b) {
        return this.edit((L) => {
            const cut = knifeCut(L, a, b);
            if (!cut) throw new Error("the cut crosses no panel");
            L.panels = cut.panels;
            L.preset = null;
        });
    }

    // A panel from a box [x, y, w, h] or a polygon [[x, y], ...] in page fractions.
    addPanel(shape, prompt = "") {
        return this.edit((L) => {
            const pts = typeof shape[0] === "number" ? corners({ x: shape[0], y: shape[1], w: shape[2], h: shape[3] }) : shape;
            L.panels.push(shapeFrom({ prompt }, pts));
            L.preset = null;
        });
    }

    remove(n) {
        return this.edit((L) => { panelAt(L, n); L.panels.splice(n - 1, 1); L.preset = null; });
    }

    // New panel order: order[k] is the current number of the panel that becomes panel k + 1.
    reorder(order) {
        return this.edit((L) => {
            if (order.length !== L.panels.length || new Set(order).size !== order.length) throw new Error(`reorder needs each of the ${L.panels.length} panel numbers once`);
            L.panels = order.map((n) => panelAt(L, n));
        });
    }

    renumber() {
        return this.edit((L) => { L.panels = readingOrder(L.panels, L.direction); });
    }

    prompt(n, prompt) {
        return this.edit((L) => { panelAt(L, n).prompt = prompt; });
    }

    // One prompt per panel, in panel order.
    prompts(list) {
        return this.edit((L) => {
            if (list.length !== L.panels.length) throw new Error(`the page has ${L.panels.length} panels, got ${list.length} prompts`);
            list.forEach((prompt, i) => { L.panels[i].prompt = prompt; });
        });
    }

    // Copies the panel layout of an existing page: a URL, a file in the ComfyUI input folder ("komikku/page.png"), or a Blob.
    async importPage(source) {
        let url = source;
        if (typeof source === "string" && !/^(https?:|data:|blob:)/.test(source)) {
            const i = source.lastIndexOf("/");
            url = api.apiURL(`/view?type=input&filename=${encodeURIComponent(source.slice(i + 1))}&subfolder=${encodeURIComponent(source.slice(0, Math.max(0, i)))}`);
        }
        const blob = source instanceof Blob ? source : await (await fetch(url)).blob();
        const { layout, warning } = await importPageLayout(blob, this.get());
        return warning ? { ...this.set(layout), warning } : this.set(layout);
    }

    // PNG data URL of the layout with the panel numbers, for an agent to look at.
    preview(width = 700) {
        const L = this.get();
        const W = width, H = Math.round(W * L.page.height / L.page.width);
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, W, H);
        L.panels.forEach((p, i) => {
            ctx.beginPath();
            corners(p).forEach(([x, y], k) => (k ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
            ctx.closePath();
            ctx.fillStyle = p.prompt.trim() ? "#e8ecf6" : "#f6e3e3";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#111";
            ctx.stroke();
            const cx = (p.x + p.w / 2) * W, cy = (p.y + p.h / 2) * H;
            ctx.fillStyle = "#111";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `bold ${Math.round(W / 18)}px sans-serif`;
            ctx.fillText(String(i + 1), cx, cy - W / 40);
            ctx.font = `${Math.round(W / 45)}px sans-serif`;
            ctx.fillText(nearestRatio(aspect(p, L)), cx, cy + W / 30);
        });
        return canvas.toDataURL("image/png");
    }
}

// Lettering box size from the text: about 1.6:1 wide for horizontal text, tall for vertical text.
function fitBox(t, layout) {
    const pageH = 1000 * layout.page.height / layout.page.width;
    const spec = TEXT_TYPES[t.type];
    const boxy = ["caption", "rounded"].includes(t.type);
    const fw = spec.shape ? (boxy ? 0.86 : 0.7) : 0.98, fh = spec.shape ? (boxy ? 0.8 : 0.66) : 0.98;
    let w, h;
    if (t.vertical) {
        const chars = [...t.text.replace(/\s+/g, "")].length || 1;
        const cols = Math.max(1, Math.round(Math.sqrt(chars * 1.08 / (1.2 * 1.6))));
        w = (cols * 1.2 * t.size + t.size) / fw;
        h = (Math.ceil(chars / cols) * 1.08 * t.size + t.size * 0.6) / fh;
    } else {
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.font = fontString(t, t.size);
        const length = ctx.measureText(t.text.replace(/\n/g, " ")).width;
        const lines = Math.max(1, Math.round(Math.sqrt(length / (1.6 * 1.18 * t.size))), t.text.split("\n").length);
        w = (length / lines * 1.15 + t.size) / fw;
        h = (lines * 1.18 * t.size + t.size * 0.4) / fh;
    }
    t.w = Math.min(w / 1000, 0.7);
    t.h = Math.min(h / pageH, 0.5);
}

// Busy-ness of the composed page: gradient magnitude with an integral image, so box means are O(1).
function detailMap(canvas) {
    const W = canvas.width, H = canvas.height;
    const px = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
    const sum = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
        let row = 0;
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            row += x > 0 && y > 0 ? Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i - W]) : 0;
            sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row;
        }
    }
    return (x0, y0, x1, y1) => {
        const a = Math.max(0, Math.round(x0 * W)), b = Math.max(0, Math.round(y0 * H)), c = Math.min(W, Math.round(x1 * W)), d = Math.min(H, Math.round(y1 * H));
        if (c <= a || d <= b) return 0;
        return (sum[d * (W + 1) + c] - sum[b * (W + 1) + c] - sum[d * (W + 1) + a] + sum[b * (W + 1) + a]) / ((c - a) * (d - b));
    };
}

class ComposeApi {
    constructor(node) { this.node = node; }

    layout() {
        const layout = this.node.__komikkuPreview.layout();
        if (!layout?.panels.length) throw new Error("no page layout: connect Anima Komikku Page & Panels and design the page first");
        return layout;
    }

    get() { return parseComposition(widget(this.node, "composition").value); }

    previews() { return this.node.properties?.komikku_panels ?? []; }

    pageWidth() { return Number(widget(this.node, "page_width")?.value) || 2480; }

    border() { return Number(widget(this.node, "border")?.value) || 0; }

    // Any change to the texts drops the saved lettering layer until save() renders it again.
    edit(fn) {
        const comp = this.get();
        const texts = JSON.stringify(comp.texts);
        const result = fn(comp);
        if (JSON.stringify(comp.texts) !== texts) comp.lettering = null;
        writeWidget(this.node, "composition", comp);
        return result;
    }

    describe() {
        const L = this.layout(), comp = this.get();
        const panelOf = (t) => L.panels.findIndex((p) => insidePolygon(corners(p), t.x + t.w / 2, t.y + t.h / 2)) + 1 || null;
        return {
            ran: this.previews().length > 0, saved: !comp.texts.length || !!comp.lettering,
            panels: L.panels.map((p, i) => ({ n: i + 1, aspect: nearestRatio(aspect(p, L)), box: [p.x, p.y, p.w, p.h].map(round), framing: comp.panels[i] ?? { zoom: 1, dx: 0, dy: 0 }, prompt: p.prompt })),
            texts: comp.texts.map((t) => ({ id: t.id, panel: panelOf(t), type: t.type, text: t.text, box: [t.x, t.y, t.w, t.h].map(round), tail: t.tail && [t.tail.x, t.tail.y].map(round) })),
            overlays: comp.overlays.map((o) => ({ id: o.id, panel: o.panel + 1, image: o.image })),
        };
    }

    // zoom over the cover scale (1 = fill the panel, 0.5-4), dx/dy shift the image by fractions of the panel box.
    frame(n, { zoom, dx, dy } = {}) {
        panelAt(this.layout(), n);
        return this.edit((comp) => {
            while (comp.panels.length < n) comp.panels.push({ zoom: 1, dx: 0, dy: 0 });
            const f = comp.panels[n - 1];
            if (zoom != null) f.zoom = Math.min(4, Math.max(0.5, zoom));
            if (dx != null) f.dx = dx;
            if (dy != null) f.dy = dy;
            return { ...f };
        });
    }

    // Adds lettering to panel n. `speaker` is where the tail points ([x, y] in the panel box, e.g. the speaking mouth);
    // `at` is the bubble center in the panel box, otherwise the bubble goes where the panel art is least busy, away from
    // other lettering and the speaker, toward the top and the reading start. Other options override the text style.
    async addText(n, type, text, { at, speaker, ...style } = {}) {
        if (!TEXT_TYPES[type]) throw new Error(`unknown text type "${type}": use one of ${Object.keys(TEXT_TYPES).join(", ")}`);
        const L = this.layout();
        const p = panelAt(L, n);
        const comp = this.get();
        const t = Object.assign(newText(type, 0, 0), { text }, style);
        const toPage = ([x, y]) => [p.x + x * p.w, p.y + y * p.h];
        const speakerPt = speaker && toPage(speaker);
        const sized = style.w == null || style.h == null;
        let center = at && toPage(at);
        if (!center) {
            // Text that fits nowhere inside the panel shrinks a few times before it may spill over the panel edge.
            const detail = await this.detail(L, comp);
            const size = t.size;
            for (let k = 0; k < 4 && !center; k++) {
                t.size = size * 0.85 ** k;
                if (sized) fitBox(t, L);
                Object.assign(t, style.w == null ? {} : { w: style.w }, style.h == null ? {} : { h: style.h });
                center = this.bestSpot(L, comp, p, t, speakerPt, detail, true);
            }
            center ??= this.bestSpot(L, comp, p, t, speakerPt, detail, false);
        } else if (sized) fitBox(t, L);
        t.x = Math.min(1 - t.w, Math.max(0, center[0] - t.w / 2));
        t.y = Math.min(1 - t.h, Math.max(0, center[1] - t.h / 2));
        if (TEXT_TYPES[type].tail) {
            // The tail stops short of the speaker so it does not cover the face.
            const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
            const [sx, sy] = speakerPt ?? [p.x + p.w / 2, Math.min(p.y + p.h * 0.9, t.y + t.h * 1.8)];
            t.tail = { x: sx + (cx - sx) * 0.25, y: sy + (cy - sy) * 0.25 };
        }
        this.edit((c) => { c.texts.push(t); });
        return { id: t.id, box: [t.x, t.y, t.w, t.h].map(round) };
    }

    async detail(L, comp) {
        return detailMap(await drawPage(L, { ...comp, texts: [] }, this.previews(), this.pageWidth(), this.border(), 400));
    }

    // Center of the least busy spot for t inside panel p; with strict off the box only needs its center inside the panel.
    bestSpot(L, comp, p, t, speakerPt, detail, strict) {
        const pts = corners(p);
        const panelDetail = detail(p.x, p.y, p.x + p.w, p.y + p.h) || 1;
        const rtl = L.direction === "rtl";
        const step = 0.01, pad = 0.01;
        let best = null;
        for (let y = p.y + pad; y + t.h <= p.y + p.h - pad + 1e-9; y += step) {
            for (let x = p.x + pad; x + t.w <= p.x + p.w - pad + 1e-9; x += step) {
                const cx = x + t.w / 2, cy = y + t.h / 2;
                const probes = strict ? [[x, y], [x + t.w, y], [x, y + t.h], [x + t.w, y + t.h], [cx, cy]] : [[cx, cy]];
                if (!probes.every(([px, py]) => insidePolygon(pts, px, py))) continue;
                let score = detail(x, y, x + t.w, y + t.h) / panelDetail;
                for (const o of comp.texts) {
                    const ox = Math.max(0, Math.min(x + t.w, o.x + o.w) - Math.max(x, o.x)), oy = Math.max(0, Math.min(y + t.h, o.y + o.h) - Math.max(y, o.y));
                    score += 5 * ox * oy / (t.w * t.h);
                }
                if (speakerPt) {
                    const [sx, sy] = speakerPt;
                    if (sx > x - t.w * 0.1 && sx < x + t.w * 1.1 && sy > y - t.h * 0.1 && sy < y + t.h * 1.1) score += 3;
                    score += 0.5 * Math.hypot((cx - sx) / p.w, (cy - sy) / p.h);
                }
                score += 0.3 * (cy - p.y) / p.h + 0.15 * (rtl ? 1 - (cx - p.x) / p.w : (cx - p.x) / p.w);
                if (!best || score < best.score) best = { score, center: [cx, cy] };
            }
        }
        if (best || strict) return best?.center ?? null;
        return [p.x + p.w / 2, p.y + Math.min(p.h / 2, t.h / 2 + pad)];
    }

    // Changes any lettering field (text, x, y, w, h, tail, size, font, colors...); position fields are page fractions.
    updateText(id, props) {
        return this.edit((comp) => {
            const t = comp.texts.find((x) => x.id === id);
            if (!t) throw new Error(`no text with id ${id}`);
            Object.assign(t, props);
            return { id, box: [t.x, t.y, t.w, t.h].map(round) };
        });
    }

    removeText(id) {
        return this.edit((comp) => {
            const i = comp.texts.findIndex((x) => x.id === id);
            if (i < 0) throw new Error(`no text with id ${id}`);
            comp.texts.splice(i, 1);
        });
    }

    clearTexts() {
        return this.edit((comp) => { comp.texts = []; });
    }

    // JPEG data URL of the page as composed from the last run's panels, with the lettering, for an agent to look at.
    async render(width = 1000) {
        const canvas = await drawPage(this.layout(), this.get(), this.previews(), this.pageWidth(), this.border(), width);
        return canvas.toDataURL("image/jpeg", 0.9);
    }

    // Renders the lettering layer the backend composes; run the workflow afterwards to get the final page.
    async save() {
        const L = this.layout(), comp = this.get();
        comp.lettering = comp.texts.length ? await exportLettering(comp, L, this.pageWidth(), this.node.id) : null;
        writeWidget(this.node, "composition", comp);
        this.node.__komikkuPreview.localPreview = await this.render(900);
        this.node.__komikkuPreview.render();
        return comp.lettering;
    }
}

window.animaKomikku = {
    layout: (id) => new LayoutApi(findNode("AnimaKomikkuPageLayout", id)),
    compose: (id) => new ComposeApi(findNode("AnimaKomikkuPageCompose", id)),
    pages: () => PAGES.map((p) => ({ ...p })),
    templates: () => PRESETS.map((p) => ({ id: p.id, name: p.name, panels: (p.rows ?? p.cols).reduce((n, [, parts]) => n + parts.length, 0) })),
    textTypes: () => Object.fromEntries(Object.entries(TEXT_TYPES).map(([id, t]) => [id, { name: t.name, tail: t.tail, defaults: t.defaults }])),
};
