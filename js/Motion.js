// Animations: slide a box to its new height or width, open and close tooltip lines, slide cards (FLIP), keep an element in place while the page redraws.
import { motion_ok } from "./Dom.js";
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
// `same_size`: the box ends as tall as it was, so the lines only fade in.
export function openLines(lines, same_size = false) {
    if (!motion_ok()) return;
    for (const line of lines) {
        const height = line.getBoundingClientRect().height;
        if (!same_size) {
            line.style.overflow = "hidden";
            line.animate([{ height: "0px" }, { height: height + "px" }], { duration: 250, easing: "ease-out" })
                .finished.then(() => { line.style.overflow = ""; }, () => {});
        }
        line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-out" });
    }
}

// The tooltip is as wide as its longest line; when that changes, its width slides from the
// old one (lines stay on one line meanwhile, so the height doesn't jump).
export function slideWidth(tooltip, from) {
    if (!tooltip || from == null || !motion_ok()) return;
    const to = tooltip.getBoundingClientRect().width;
    if (Math.abs(to - from) < 1) return;
    const style = tooltip.style;
    style.boxSizing = "border-box";
    style.overflow = "hidden";
    style.whiteSpace = "nowrap";
    // Held at the end width until the lines closing in it (closeLines) are gone, which
    // happens just after, so the box never flashes wider.
    const slide = tooltip.animate([{ width: from + "px" }, { width: to + "px" }], { duration: 250, easing: "ease-out", fill: "forwards" });
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
