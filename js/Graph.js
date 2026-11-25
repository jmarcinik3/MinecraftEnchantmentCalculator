// Section 1's conflict graph (a prototype): one node per enchantment the item can take that conflicts with
// another, one line per conflict, so a large conflict pattern shows as a shape instead of a long list.
import { TEXT } from "./Text.js";
import { logic, state } from "./Store.js";
import { h } from "./Dom.js";
import { setWanted } from "./App.js";

const WIDTH = 640;
const HEIGHT = 420;
const MARGIN = 22;
const ITERATIONS = 300;
let graph_open = false;
// The last layout, kept while the same enchantments and conflicts are drawn (a pick redraws section 1 but moves nothing).
let layout = { key: "", points: new Map() };

function svg(tag, attrs = {}, ...children) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) if (child != null) el.append(child);
    return el;
}

// Fruchterman-Reingold: every node pushes the others away, every conflict pulls its two nodes together, and a
// little gravity keeps separate clusters on the page. Starts from a circle in a fixed order, so it is repeatable.
function computeLayout(nodes, edges) {
    const index = new Map(nodes.map((ns, i) => [ns, i]));
    const x = nodes.map((_, i) => Math.cos((2 * Math.PI * i) / nodes.length) * 150);
    const y = nodes.map((_, i) => Math.sin((2 * Math.PI * i) / nodes.length) * 150);
    const k = Math.sqrt((WIDTH * HEIGHT) / Math.max(1, nodes.length)) * 0.7;
    const pairs = edges.map(([a, b]) => [index.get(a), index.get(b)]);
    for (let step = 0; step < ITERATIONS; step++) {
        const temperature = (WIDTH / 8) * (1 - step / ITERATIONS) + 0.5;
        const dx = new Array(nodes.length).fill(0);
        const dy = new Array(nodes.length).fill(0);
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                let ex = x[i] - x[j];
                let ey = y[i] - y[j];
                const distance = Math.max(0.01, Math.hypot(ex, ey));
                const push = (k * k) / distance;
                ex /= distance; ey /= distance;
                dx[i] += ex * push; dy[i] += ey * push;
                dx[j] -= ex * push; dy[j] -= ey * push;
            }
            dx[i] -= x[i] * 0.4; dy[i] -= y[i] * 0.4; // gravity
        }
        for (const [a, b] of pairs) {
            const ex = x[a] - x[b];
            const ey = y[a] - y[b];
            const distance = Math.max(0.01, Math.hypot(ex, ey));
            const pull = (distance * distance) / k;
            dx[a] -= (ex / distance) * pull; dy[a] -= (ey / distance) * pull;
            dx[b] += (ex / distance) * pull; dy[b] += (ey / distance) * pull;
        }
        for (let i = 0; i < nodes.length; i++) {
            const length = Math.max(0.01, Math.hypot(dx[i], dy[i]));
            const move = Math.min(length, temperature);
            x[i] += (dx[i] / length) * move;
            y[i] += (dy[i] / length) * move;
        }
    }
    // Fit the result into the box.
    const [minX, maxX, minY, maxY] = [Math.min(...x), Math.max(...x), Math.min(...y), Math.max(...y)];
    const scale = Math.min((WIDTH - 2 * MARGIN) / Math.max(1, maxX - minX), (HEIGHT - 2 * MARGIN) / Math.max(1, maxY - minY));
    const points = new Map();
    nodes.forEach((ns, i) => points.set(ns, [
        WIDTH / 2 + (x[i] - (minX + maxX) / 2) * scale,
        HEIGHT / 2 + (y[i] - (minY + maxY) / 2) * scale
    ]));
    return points;
}

// With a search typed, the nodes that match it are ringed and the rest fade. `matches` is a function of the
// enchantment, or null with no search. Drawn at once, and again whenever the search changes.
let drawn = null;
let matcher = null;
export function markSearch(matches) {
    matcher = matches;
    if (!drawn) return;
    for (const node of drawn.querySelectorAll(".graph-node")) {
        const hit = Boolean(matches) && matches(node.dataset.ns);
        node.classList.toggle("match", hit);
        node.classList.toggle("unmatched", Boolean(matches) && !hit);
    }
}

// The graph for the chosen item, in a fold-away box under the preview; null when nothing conflicts.
export function conflictGraph(matches = null) {
    matcher = matches;
    if (!state.item) return null;
    const options = logic.applicable(state.item);
    const edges = [];
    for (let i = 0; i < options.length; i++) {
        for (let j = i + 1; j < options.length; j++) if (logic.conflicts(options[i], options[j])) edges.push([options[i], options[j]]);
    }
    const nodes = options.filter(ns => edges.some(edge => edge.includes(ns)));
    if (!nodes.length) return null;
    const key = state.item + "|" + nodes.join() + "|" + edges.length;
    if (layout.key !== key) layout = { key, points: graph_open ? computeLayout(nodes, edges) : new Map() };
    const neighbours = ns => edges.filter(edge => edge.includes(ns)).map(edge => (edge[0] === ns ? edge[1] : edge[0]));

    const box = h("details", {
        class: "fold-box graph-box", open: graph_open,
        ontoggle: event => {
            graph_open = event.target.open;
            if (!graph_open) return;
            if (!layout.points.size) layout.points = computeLayout(nodes, edges);
            if (!canvas) fill();
        }
    }, h("summary", {}, TEXT.wanted.graph_title));
    const hint = TEXT.wanted.graph_hint({ nodes: nodes.length, edges: edges.length });
    const caption = h("div", { class: "graph-caption", "aria-live": "polite" }, hint);
    let canvas = null;

    function fill() {
        if (canvas) canvas.remove();
        const lines = edges.map(([a, b]) => {
            const [x1, y1] = layout.points.get(a);
            const [x2, y2] = layout.points.get(b);
            return svg("line", { x1, y1, x2, y2, class: "graph-edge", "data-a": a, "data-b": b });
        });
        const dots = nodes.map(ns => {
            const [cx, cy] = layout.points.get(ns);
            const chosen = Boolean(state.wanted[ns]);
            const blocked = !chosen && Object.keys(state.wanted).some(other => logic.conflicts(other, ns));
            const rivals = neighbours(ns);
            const text = TEXT.wanted.graph_node({ name: logic.enchName(ns), names: rivals.map(logic.enchName) });
            const toggle = () => setWanted(ns, chosen ? 0 : logic.maxLevel(ns));
            return svg("g", {
                class: "graph-node" + (chosen ? " chosen" : "") + (blocked ? " blocked" : ""),
                "data-ns": ns, tabindex: "0", role: "button", "aria-pressed": String(chosen), "aria-label": text,
                onmouseenter: () => light(ns, rivals, text), onmouseleave: () => light(null),
                onfocus: () => light(ns, rivals, text), onblur: () => light(null),
                onclick: toggle,
                onkeydown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }
            }, svg("circle", { cx, cy, r: 7 }), svg("title", {}, text));
        });
        canvas = svg("svg", { class: "graph-canvas", viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: "group", "aria-label": TEXT.wanted.graph_title }, lines, dots);
        box.insertBefore(canvas, caption);
        drawn = canvas;
        markSearch(matcher);
    }

    // Hovering or focusing a node lights its conflicts and dims the rest.
    function light(ns, rivals = [], text = hint) {
        if (!canvas) return;
        canvas.classList.toggle("focus", ns != null);
        for (const node of canvas.querySelectorAll(".graph-node")) {
            node.classList.toggle("self", node.dataset.ns === ns);
            node.classList.toggle("near", ns != null && rivals.includes(node.dataset.ns));
        }
        for (const line of canvas.querySelectorAll(".graph-edge")) line.classList.toggle("hot", ns != null && (line.dataset.a === ns || line.dataset.b === ns));
        caption.textContent = ns == null ? hint : text;
    }

    box.append(caption);
    if (graph_open) fill();
    return box;
}
