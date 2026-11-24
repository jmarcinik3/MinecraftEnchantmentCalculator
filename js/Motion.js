// Animations: slide a box to its new height or width, open and close tooltip lines, slide cards (FLIP), keep an element in place while the page redraws.
import { motion_ok } from "./Dom.js";
import { meta } from "./Store.js";
import { steps_scroll } from "./Results.js";

export function growSmoothly(element, from) {
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1 || !motion_ok()) return;
    element.classList.add("resizing");
    element.style.height = from + "px";
    element.getBoundingClientRect(); // apply the old height before the transition starts
    element.style.height = to + "px";
    // Back to its natural height once done. The timer covers a slide that never ends
    // (the section closed mid-slide, or a hidden tab), so it can never stay stuck.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        element.classList.remove("resizing");
        element.style.height = "";
    };
    // Only its own height transition (the level bars inside have short ones of their own).
    const own = event => { if (event.target === element && event.propertyName === "height") finish(); };
    element.addEventListener("transitionend", own);
    element.addEventListener("transitioncancel", own);
    setTimeout(finish, 400);
}

// New tooltip lines open from no height in their own place (and fade in), so the lines
// below them slide down with the box, wherever in the list they were added. Same
// duration and easing as growSmoothly, so the lines and the box move together.
export function openLines(lines) {
    if (!motion_ok()) return;
    for (const line of lines) {
        const height = line.getBoundingClientRect().height;
        line.style.overflow = "hidden";
        line.animate([{ height: "0px" }, { height: height + "px" }], { duration: 250, easing: "ease-out" })
            .finished.then(() => { line.style.overflow = ""; }, () => {});
        line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-out" });
    }
}

// A swap that leaves the tooltip the same size (Best for Frost Walker, Protection for
// Projectile Protection): every row whose text changes rolls at once, like a counter, all in
// one direction. The old text leaves through one edge of its row (a copy laid over where it
// was; `old_lines` holds each line's text and box) while the new text comes in from the
// other, so within a row they fill it between them and never overlap. Rows are matched by
// position; unchanged rows stay still.
// The direction follows the way the text moves. First, the enchantments that stay: if they
// end up lower in the list (a line was added above them, Best for Frost Walker) the rows roll
// down; if higher (a line above them went, Sharpness for None) they roll up. Else, when one
// enchantment replaces another, up if the new one sits lower in the tooltip's fixed order
// (Frost Walker for Depth Strider: the new text rises from below, towards where it will
// live), down if higher. A change of level alone rolls up for a higher level and down for a
// lower one; anything else rolls up.
export function rollLines(preview, old_lines) {
    if (!motion_ok()) return;
    const tooltip = preview.querySelector(".mc-tooltip");
    if (!tooltip) return;
    const now = [...tooltip.querySelectorAll(".mc-ench[data-ns]")];
    const old_ns = new Set(old_lines.map(line => line.ns));
    const now_ns = new Set(now.map(line => line.dataset.ns));
    const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
    // Where an enchantment sits in the tooltip (the game's fixed order).
    const rank = ns => meta.tooltip_order.indexOf(ns);
    const coming = now.filter(line => !old_ns.has(line.dataset.ns)).map(line => rank(line.dataset.ns));
    const going = old_lines.filter(line => !now_ns.has(line.ns)).map(line => rank(line.ns));
    // How far each enchantment that stays moves in the list: old row minus new row, so a
    // positive number means it moves up.
    const moves = now.map((line, index) => old_lines.findIndex(old => old.ns === line.dataset.ns) - index)
        .filter((move, index) => old_ns.has(now[index].dataset.ns));
    const stay = moves.length ? mean(moves) : 0;
    let up = true;
    if (stay !== 0) {
        up = stay > 0;
    } else if (coming.length && going.length && mean(coming) !== mean(going)) {
        up = mean(coming) > mean(going);
    } else if (!coming.length && !going.length) {
        // The same enchantments, only levels differ.
        const changes = now.map((line, index) => Number(line.dataset.level) - Number(old_lines[index] && old_lines[index].node.dataset.level)).filter(Number.isFinite);
        up = changes.length ? mean(changes) >= 0 : true;
    }
    const sign = up ? 1 : -1;
    const options = { duration: 240, easing: "ease-in-out" };
    for (let index = 0; index < Math.max(now.length, old_lines.length); index++) {
        const line = now[index];
        const old = old_lines[index];
        if (line && old && line.textContent === old.node.textContent) continue;
        if (line) {
            line.animate([{ transform: `translateY(${100 * sign}%)`, clipPath: up ? "inset(0 0 100% 0)" : "inset(100% 0 0 0)" }, { transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }],
                { ...options, fill: "backwards" });
        }
        if (old && old.box) {
            const ghost = old.node;
            ghost.classList.remove("fresh");
            ghost.setAttribute("aria-hidden", "true");
            ghost.removeAttribute("data-ns");
            Object.assign(ghost.style, { position: "absolute", left: old.box.left + "px", top: old.box.top + "px", width: old.box.width + "px", height: old.box.height + "px", margin: "0", pointerEvents: "none" });
            tooltip.append(ghost);
            const done = () => ghost.remove();
            ghost.animate([{ transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }, { transform: `translateY(${-100 * sign}%)`, clipPath: up ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)" }],
                { ...options, fill: "forwards" }).finished.then(done, done);
            setTimeout(done, 450); // a hidden tab never finishes animations
        }
    }
}

// The tooltip is as wide as its longest line; when that changes, its width slides from the
// old one (lines stay on one line meanwhile, so the height doesn't jump).
export function slideWidth(tooltip, from, from_height = null) {
    if (!tooltip || from == null || !motion_ok()) return;
    const rect = tooltip.getBoundingClientRect();
    const frames = [{}, {}];
    if (Math.abs(rect.width - from) >= 1) { frames[0].width = from + "px"; frames[1].width = rect.width + "px"; }
    // `from_height`: in a swap that rolls rows (rollLines) the lines don't push the box open
    // or shut as they go, so the box's own height slides too.
    if (from_height != null && Math.abs(rect.height - from_height) >= 1) { frames[0].height = from_height + "px"; frames[1].height = rect.height + "px"; }
    if (!Object.keys(frames[0]).length) return;
    const style = tooltip.style;
    style.boxSizing = "border-box";
    style.overflow = "hidden";
    style.whiteSpace = "nowrap";
    // Held at the end size until the lines closing in it (closeLines, rollLines) are gone,
    // which happens just after, so the box never flashes larger.
    const slide = tooltip.animate(frames, { duration: 250, easing: "ease-out", fill: "forwards" });
    const finish = () => { slide.cancel(); style.boxSizing = style.overflow = style.whiteSpace = ""; };
    slide.finished.then(() => setTimeout(finish, 0), finish);
    setTimeout(finish, 450); // a hidden tab never finishes animations
}

// Removed tooltip lines close the way new ones open: a copy stays in its place and folds
// away (shrinking and fading), so the lines below slide up with the box instead of jumping.
export function closeLines(preview, old_lines) {
    if (!motion_ok()) return;
    const tooltip = preview.querySelector(".mc-tooltip");
    if (!tooltip) return;
    const kept = new Set([...tooltip.querySelectorAll(".mc-ench[data-ns]")].map(line => line.dataset.ns));
    old_lines.forEach(({ ns, node }, index) => {
        if (kept.has(ns)) return;
        const ghost = node;
        ghost.classList.remove("fresh");
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("data-ns");
        ghost.style.pointerEvents = "none";
        const lines = tooltip.querySelectorAll(".mc-ench");
        const before = lines[Math.min(index, lines.length)];
        before ? before.before(ghost) : tooltip.append(ghost);
        const height = ghost.getBoundingClientRect().height;
        ghost.style.overflow = "hidden";
        const remove = () => ghost.remove();
        ghost.animate([{ height: height + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 250, easing: "ease-out", fill: "forwards" }).finished.then(remove, remove);
        setTimeout(remove, 400); // a hidden tab never finishes animations
    });
}

// Where each card was before a redraw (by entry id), for animateCards: relative to the
// grid, so only moves inside it animate (not the whole section moving with the page).
export function cardRects(box) {
    const rects = new Map();
    const grid = box.querySelector(".entry-grid");
    if (!grid) return rects;
    const base = grid.getBoundingClientRect();
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        const rect = card.getBoundingClientRect();
        rects.set(card.dataset.key, { left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
    }
    return rects;
}

// After a redraw, each card slides from where it was to where it is now (reordering,
// or the cards after an added or removed one), new cards fade in, and the grid's height
// slides too (growSmoothly), so nothing jumps.
// `morph` (Cards <-> List): each card also grows or shrinks from its old size to its new
// one, its contents fading in as it does, so nothing is seen stretched.
export function animateCards(box, old_rects, old_height, morph = false) {
    if (!motion_ok() || !old_rects.size) return;
    const grid = box.querySelector(".entry-grid");
    if (!grid) return;
    if (old_height != null) growSmoothly(grid, old_height);
    const now_rects = cardRects(box);
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        const old = old_rects.get(card.dataset.key);
        if (!old) {
            card.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 250, easing: "ease-out" });
            continue;
        }
        const now = now_rects.get(card.dataset.key);
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (morph) {
            const scale = `scale(${old.width / now.width}, ${old.height / now.height})`;
            card.animate([{ transform: `translate(${dx}px, ${dy}px) ${scale}`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
                { duration: 320, easing: "ease-out" });
            for (const child of card.children) child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
            continue;
        }
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 250, easing: "ease-out" });
    }
}

// Scrolls down just enough to show `card` when it is below the visible part of the steps
// (their own box on desktop, the window on phones); never up.
export function revealBelow(card) {
    const box = card.closest(".steps-scroll");
    const scrolls = box && box.scrollHeight > box.clientHeight;
    const bottom = scrolls ? box.getBoundingClientRect().bottom : innerHeight;
    const rect = card.getBoundingClientRect();
    const over = Math.min(rect.bottom - bottom, rect.top - (scrolls ? box.getBoundingClientRect().top : 0));
    if (over <= 0) return;
    const behavior = motion_ok() ? "smooth" : "auto";
    if (scrolls) box.scrollBy({ top: over, behavior });
    else scrollBy({ top: over, behavior });
}

// Runs `redraw` (which rebuilds the steps), then scrolls so the element matching
// `selector` is where it was on screen. Ticking or folding a step folds or unfolds others
// too (ticking one ticks the steps it needs), which moves everything below them; without
// this the list would jump, and the old scroll position would land somewhere else.
// The steps scroll inside their own box on desktop and with the page on phones.
export function keepInPlace(selector, redraw) {
    const before = document.querySelector(selector);
    const top = before ? before.getBoundingClientRect().top : null;
    redraw();
    const after = document.querySelector(selector);
    if (top == null || !after) return;
    const shift = after.getBoundingClientRect().top - top;
    if (Math.abs(shift) < 1) return;
    const box = after.closest(".steps-scroll");
    if (box && box.scrollHeight > box.clientHeight) {
        box.scrollTop += shift;
        steps_scroll.top = box.scrollTop;
    } else {
        scrollBy(0, shift);
    }
}

// A level bar that changes length (switching Depth Strider, III, for Frost Walker, II, in a
// "Pick one" group) rolls: segments it gains unroll from the left, one after another, and
// segments it loses (`old_segments`, copies of the old bar's) roll up from the right end
// and are removed. `old_levels` is how many the old bar had.
export function rollLevelBar(bar, old_levels, old_segments) {
    if (!motion_ok()) return;
    const segments = [...bar.querySelectorAll(".level-seg")];
    const levels = segments.length;
    if (!levels || levels === old_levels) return;
    const options = { duration: 260, easing: "ease-out", fill: "backwards" };
    const roll = [{ transform: "scaleX(0)", opacity: 0 }, { transform: "scaleX(1)", opacity: 1 }];
    for (let index = old_levels; index < levels; index++) {
        segments[index].style.transformOrigin = "left center";
        segments[index].animate(roll, { ...options, delay: (index - old_levels) * 70 });
    }
    const width = segments[0].getBoundingClientRect().width;
    for (let index = levels; index < old_levels; index++) {
        const ghost = old_segments[index];
        if (!ghost) continue;
        ghost.removeAttribute("data-level");
        ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "absolute", top: "0", left: index * width + "px", width: width + "px", height: "100%", transformOrigin: "left center", pointerEvents: "none" });
        bar.append(ghost);
        const remove = () => ghost.remove();
        ghost.animate([...roll].reverse(), { duration: 260, easing: "ease-in", fill: "forwards", delay: (old_levels - 1 - index) * 70 }).finished.then(remove, remove);
        setTimeout(remove, 900); // a hidden tab never finishes animations
    }
}

// PARKED: not used right now (section 1 does not scroll the page; the rows just move). It was
// in renderWanted as `holdInPlace(find_anchor, anchor_top)`, with the anchor taken from the last
// pointerdown's or the focused element's `data-focus`.
// While section 1 animates (the tooltip grows or shrinks and the rows below slide), keeps
// the thing that was clicked where it was on screen by scrolling the page a little each
// frame, so the pointer stays over it. `find()` returns the element again after the redraw
// and `top` is where it was. Stops after `ms`, or as soon as the user scrolls or presses
// a key. Near the top of the page there is nothing to scroll into, so it can only do so much.
let hold = null;
export function holdInPlace(find, top, ms = 360) {
    if (hold) hold.abort();
    if (top == null) return;
    const step = () => {
        const el = find();
        if (!el) return;
        const delta = el.getBoundingClientRect().top - top;
        if (Math.abs(delta) >= 0.5) scrollBy(0, delta);
    };
    step();
    if (!motion_ok()) return;
    const control = new AbortController();
    hold = control;
    for (const type of ["wheel", "touchmove", "keydown"]) addEventListener(type, () => control.abort(), { once: true, passive: true, signal: control.signal });
    const end = performance.now() + ms;
    const frame = () => {
        if (control.signal.aborted) return;
        step();
        if (performance.now() < end) requestAnimationFrame(frame);
        else control.abort();
    };
    requestAnimationFrame(frame);
}
