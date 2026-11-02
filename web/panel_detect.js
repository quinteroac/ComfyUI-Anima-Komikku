// Finds the panels of an existing comic or manga page: the gutter is the paper colour reached from the page edge,
// everything else splits into panels. Returns polygons in page fractions ([[x, y], ...]), unordered.

const WORK_SIZE = 1000;

function pageGray(image) {
    const scale = Math.min(1, WORK_SIZE / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    return { gray, w, h };
}

// Paper colour: the median of the outermost pixels. Pages with black gutters are handled the same way.
function paperTest(gray, w, h, tolerance) {
    const edge = [];
    for (let x = 0; x < w; x++) edge.push(gray[x], gray[(h - 1) * w + x]);
    for (let y = 0; y < h; y++) edge.push(gray[y * w], gray[y * w + w - 1]);
    edge.sort((a, b) => a - b);
    const paper = edge[edge.length >> 1];
    return (v) => Math.abs(v - paper) <= tolerance;
}

// Gutter: paper-coloured pixels connected to the page edge.
function gutterMask(gray, w, h, isPaper) {
    const mask = new Uint8Array(w * h);
    const stack = [];
    const push = (i) => { if (!mask[i] && isPaper(gray[i])) { mask[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
        const i = stack.pop(), x = i % w;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (i >= w) push(i - w);
        if (i < w * (h - 1)) push(i + w);
    }
    return mask;
}

// Box erosion of the panel area, so thin bridges across a gutter (balloon tails, speed lines) do not merge two panels.
function erode(solid, w, h, r) {
    const rows = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) { run = solid[y * w + x] ? run + 1 : 0; rows[y * w + x] = run > 2 * r ? 1 : 0; }
    }
    for (let x = r; x < w - r; x++) {
        let run = 0;
        for (let y = 0; y < h; y++) {
            run = rows[y * w + x + r] ? run + 1 : 0;
            if (run > 2 * r) out[(y - r) * w + x] = 1;
        }
    }
    return out;
}

// Per component: its pixel count and, for each row, the leftmost and rightmost pixel.
function components(solid, w, h) {
    const label = new Int32Array(w * h);
    const found = [];
    for (let start = 0; start < solid.length; start++) {
        if (!solid[start] || label[start]) continue;
        const c = { area: 0, rows: new Map(), pixels: new Set() };
        found.push(c);
        label[start] = found.length;
        const stack = [start];
        while (stack.length) {
            const i = stack.pop(), x = i % w, y = (i - x) / w;
            c.area++;
            c.pixels.add(i);
            const row = c.rows.get(y);
            if (!row) c.rows.set(y, [x, x]);
            else { if (x < row[0]) row[0] = x; if (x > row[1]) row[1] = x; }
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
                if (j >= 0 && j < solid.length && solid[j] && !label[j]) { label[j] = found.length; stack.push(j); }
            }
        }
    }
    return found;
}

function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => {
        const out = [];
        for (const p of list) {
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
            out.push(p);
        }
        out.pop();
        return out;
    };
    return [...half(pts), ...half(pts.slice().reverse())];
}

// Drops hull corners that sit within `eps` of the line through their neighbours, smallest deviation first.
function simplify(hull, eps) {
    const pts = hull.slice();
    const dev = (i) => {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
        return Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / len;
    };
    while (pts.length > 3) {
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (dev(i) < dev(best)) best = i;
        if (dev(best) > eps && pts.length <= 8) break;
        pts.splice(best, 1);
    }
    return pts;
}

function hullArea(pts) {
    return Math.abs(pts.reduce((sum, q, i) => { const r = pts[(i + 1) % pts.length]; return sum + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
}

function outline(rows) {
    const edge = [];
    for (const [y, [x0, x1]] of rows) edge.push([x0, y], [x1 + 1, y], [x0, y + 1], [x1 + 1, y + 1]);
    return convexHull(edge);
}

// A component that fills its outline poorly is usually several panels joined by art crossing the gutter.
// Split it at the row or column that is emptiest inside it, as long as that line is mostly gutter.
function splitMerged(c, solid, w, minPart, depth = 0) {
    const ys = [...c.rows.keys()];
    const y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    const x0 = Math.min(...[...c.rows.values()].map((r) => r[0])), x1 = Math.max(...[...c.rows.values()].map((r) => r[1])) + 1;
    const hull = outline(c.rows);
    if (depth >= 5 || c.area > hullArea(hull) * 0.82) return [c];
    const fill = (from, to, count) => {
        let best = null;
        const margin = Math.round((to - from) * 0.1);
        for (let k = from + margin; k < to - margin; k++) {
            const empty = 1 - count(k) / (k < y1 && from === y0 ? x1 - x0 : y1 - y0);
            if (!best || empty > best.empty) best = { k, empty };
        }
        return best;
    };
    const rowCount = (y) => { let n = 0; for (let x = x0; x < x1; x++) n += c.pixels.has(y * w + x) ? 1 : 0; return n; };
    const colCount = (x) => { let n = 0; for (let y = y0; y < y1; y++) n += c.pixels.has(y * w + x) ? 1 : 0; return n; };
    const row = fill(y0, y1, rowCount), col = fill(x0, x1, colCount);
    const cut = !col || (row && row.empty >= col.empty) ? { axis: "y", ...row } : { axis: "x", ...col };
    if (!cut.k || cut.empty < 0.45) return [c];
    const parts = [{ area: 0, rows: new Map(), pixels: new Set() }, { area: 0, rows: new Map(), pixels: new Set() }];
    for (const i of c.pixels) {
        const x = i % w, y = (i - x) / w;
        const v = cut.axis === "y" ? y : x;
        if (Math.abs(v - cut.k) <= 1) continue;
        const part = parts[v < cut.k ? 0 : 1];
        part.area++;
        part.pixels.add(i);
        const r = part.rows.get(y);
        if (!r) part.rows.set(y, [x, x]);
        else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
    }
    // Both halves must be panel-sized; thin bands are usually a figure's limbs or a gap in the art, not a gutter.
    if (parts.some((part) => part.area < minPart)) return [c];
    return parts.flatMap((part) => splitMerged(part, solid, w, minPart, depth + 1));
}

// Pushes every corner out by r along the bisector of its two edges, which undoes the erosion without chamfering corners.
function grow(pts, r) {
    const n = pts.length;
    const sign = pts.reduce((sum, q, i) => { const t = pts[(i + 1) % n]; return sum + q[0] * t[1] - t[0] * q[1]; }, 0) > 0 ? 1 : -1;
    const normal = (a, b) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [sign * (b[1] - a[1]) / len, -sign * (b[0] - a[0]) / len]; };
    return pts.map((q, i) => {
        const a = normal(pts[(i + n - 1) % n], q), b = normal(q, pts[(i + 1) % n]);
        const m = [a[0] + b[0], a[1] + b[1]];
        const d = m[0] * a[0] + m[1] * a[1] || 1;
        return [q[0] + m[0] * r / d, q[1] + m[1] * r / d];
    });
}

function inside(poly, x, y) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
}

// Intersection over union of two polygons in page fractions, sampled on a grid.
function overlap(a, b, steps = 120) {
    let both = 0, either = 0;
    for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
            const x = (i + 0.5) / steps, y = (j + 0.5) / steps;
            const inA = inside(a, x, y), inB = inside(b, x, y);
            both += inA && inB;
            either += inA || inB;
        }
    }
    return either ? both / either : 0;
}

// Panel boxes from a detection model ([x1, y1, x2, y2] in page fractions) decide which panels the page has; a four-corner
// gutter outline that matches a box replaces it, so slanted cuts survive. Outlines with more corners are art or balloons
// bitten out of a panel, and unmatched ones are dropped.
export function matchPanels(boxes, outlines, minOverlap = 0.85) {
    const quads = outlines.filter((o) => o.length === 4);
    return boxes.map(([x1, y1, x2, y2]) => {
        const box = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
        const best = quads.map((o) => [overlap(box, o), o]).sort((a, b) => b[0] - a[0])[0];
        return best && best[0] >= minOverlap ? best[1] : box;
    });
}

export function detectPanels(image, { tolerance = 40, minArea = 0.012 } = {}) {
    const { gray, w, h } = pageGray(image);
    const gutter = gutterMask(gray, w, h, paperTest(gray, w, h, tolerance));
    const solid = gutter.map((g) => 1 - g);
    const r = Math.max(2, Math.round(Math.max(w, h) * 0.004));
    const eroded = erode(solid, w, h, r);
    const panels = [];
    for (const c of components(eroded, w, h)) {
        if (c.area < minArea * w * h) continue;
        for (const part of splitMerged(c, eroded, w, 0.04 * w * h)) {
            if (part.area < minArea * w * h) continue;
            const hull = simplify(outline(part.rows), Math.max(w, h) * 0.008);
            panels.push(grow(hull, r).map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]));
        }
    }
    return { panels, aspect: image.width / image.height };
}
