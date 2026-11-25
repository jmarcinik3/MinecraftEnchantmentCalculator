// Animations: slide a box to its new height or width, open and close tooltip lines, slide cards (FLIP), keep an element in place while the page redraws.
import { h, motion_ok } from "./Dom.js";
import { meta } from "./Store.js";
import { steps_scroll } from "./Results.js";

// Section 2's Cards/Slots/List switch: how long it takes and how it eases.
const MORPH_MS = 360;
const MORPH_EASING = "cubic-bezier(0.25, 0.8, 0.25, 1)";

// `timing` (optional): { duration, easing } to slide with instead of the default 0.25s ease-out.
export function growSmoothly(element, from, timing = null) {
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1 || !motion_ok()) return;
    element.classList.add("resizing");
    if (timing) {
        element.style.transitionDuration = timing.duration + "ms";
        element.style.transitionTimingFunction = timing.easing;
    }
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
        element.style.transitionDuration = "";
        element.style.transitionTimingFunction = "";
    };
    // Only its own height transition (the level bars inside have short ones of their own).
    const own = event => { if (event.target === element && event.propertyName === "height") finish(); };
    element.addEventListener("transitionend", own);
    element.addEventListener("transitioncancel", own);
    setTimeout(finish, (timing ? timing.duration : 250) + 150);
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

// What moves with a card's slot between views: the slot's wrapper (or button), a direct child of the card.
function slotUnit(card) {
    let unit = card.querySelector(".mc-slot");
    while (unit && unit.parentElement !== card) unit = unit.parentElement;
    return unit;
}

// A part of a card, by its first class (the tooltip, the head strip, the summary...).
function partName(part) {
    return part.classList[0] || part.tagName;
}

// A copy for show only: nothing in it may take focus, be found by data-focus, or be read out.
export function inertCopy(node) {
    const copy = node.cloneNode(true);
    for (const part of copy.querySelectorAll("[data-focus], [id]")) {
        part.removeAttribute("data-focus");
        part.removeAttribute("id");
    }
    for (const part of copy.querySelectorAll("button, input, a, [tabindex]")) part.tabIndex = -1;
    copy.removeAttribute("data-focus");
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    return copy;
}

// A look-alike of the card laid out as it was (`box`: its size then), for the old contents to
// fade out in place while the real card is already drawn in its new shape. `hide_slot`: the
// slot keeps its room but is not drawn (the real slot travels on its own).
function cardGhost(card, unit, box, hide_slot) {
    const clone = inertCopy(card);
    const index = [...card.children].indexOf(unit);
    if (hide_slot && index >= 0) clone.children[index].style.visibility = "hidden"; // its room stays, so the rest is laid out as it was
    if (hide_slot) clone.querySelectorAll(":scope > .stack-edit").forEach(part => part.remove());
    clone.querySelectorAll(":scope > .slot-tip, :scope > .card-frame, :scope > .card-ghost").forEach(part => part.remove());
    clone.classList.remove("fresh", "flash", "highlight", "popover-open", "dragging", "drop-target", "merge-target", "drag-source", "morphing");
    for (const name of ["data-key", "data-index"]) clone.removeAttribute(name);
    clone.style.width = box.width + "px";
    clone.style.height = box.height + "px";
    return clone;
}

// Where each card was before a redraw (by entry id), for animateCards: relative to the
// grid, so only moves inside it animate (not the whole section moving with the page).
// Each also has where its slot and its other parts were and how its box looked (`slot`,
// `parts`, `chrome`), and with `ghosts` (a change of view or mode) a copy of its contents
// (`ghost`, no slot) and a way to make a whole copy (`solo`). The add bar is "add-card".
export function cardRects(box, ghosts = false) {
    const rects = new Map();
    const grid = box.querySelector(".entry-grid");
    if (!grid) return rects;
    const base = grid.getBoundingClientRect();
    const relative = rect => ({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        // Caught mid-switch, the box is the frame still growing or shrinking, not the card.
        const frame = card.querySelector(":scope > .card-frame");
        const outline = (frame || card).getBoundingClientRect();
        const style = getComputedStyle(frame || card);
        const unit = slotUnit(card);
        rects.set(card.dataset.key, {
            ...relative(outline),
            slot: unit ? relative((card.querySelector(".mc-slot") || unit).getBoundingClientRect()) : null, // the slot itself: its wrapper can be wider (the slots view's button)
            parts: new Map([...card.children].filter(part => part !== unit).map(part => [partName(part), relative(part.getBoundingClientRect())])),
            chrome: { background: style.backgroundColor, border: parseFloat(style.borderTopWidth) > 0 ? style.borderTopColor : "rgba(0, 0, 0, 0)", radius: style.borderTopLeftRadius, width: parseFloat(getComputedStyle(card).borderTopWidth) || 0 },
            ghost: ghosts && !frame ? cardGhost(card, unit, outline, true) : null,
            solo: ghosts ? () => cardGhost(card, unit, outline, false) : null
        });
    }
    const add = grid.querySelector(":scope > .entry-add-card");
    if (add) {
        const outline = add.getBoundingClientRect();
        rects.set("add-card", { ...relative(outline), solo: ghosts ? () => { const copy = inertCopy(add); copy.style.width = outline.width + "px"; copy.style.height = outline.height + "px"; return copy; } : null });
    }
    return rects;
}

// A copy of something that is gone, left where it was and fading out (then removed).
function leaveInGrid(grid, spec, timing) {
    if (!spec.solo) return;
    const leaving = h("div", { class: "card-leaving", "aria-hidden": "true" }, spec.solo());
    Object.assign(leaving.style, { left: spec.left + "px", top: spec.top + "px", width: spec.width + "px", height: spec.height + "px" });
    grid.append(leaving);
    const remove = () => leaving.remove();
    leaving.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], { duration: timing.duration * 0.6, easing: "ease-in", fill: "forwards" }).finished.then(remove, remove);
    setTimeout(remove, timing.duration + 150);
}

// After a redraw, each card slides from where it was to where it is now (reordering,
// or the cards after an added or removed one), new cards fade in, and the grid's height
// slides too (growSmoothly), so nothing jumps.
// `morph`: "view" (a switch between Cards, Slots and List) or "mode" (Automatic and
// Custom: the same entries gain or lose their tools; `leaving` are old cards with no new one): see morphCard.
export function animateCards(box, old_rects, old_height, morph = false, leaving = []) {
    if (!motion_ok() || !old_rects.size && !leaving.length) return;
    const grid = box.querySelector(".entry-grid");
    if (!grid) return;
    const timing = morph ? { duration: MORPH_MS, easing: MORPH_EASING } : { duration: 250, easing: "ease-out" };
    if (old_height != null) growSmoothly(grid, old_height, morph ? timing : null);
    const now_rects = cardRects(box);
    for (const card of grid.querySelectorAll(".entry-card[data-key]")) {
        const old = old_rects.get(card.dataset.key);
        if (!old) {
            card.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 250, easing: "ease-out", delay: morph === "mode" ? MORPH_MS * 0.25 : 0, fill: "backwards" });
            continue;
        }
        const now = now_rects.get(card.dataset.key);
        if (morph) {
            morphCard(card, old, now, timing, morph);
            continue;
        }
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
    }
    for (const spec of leaving) leaveInGrid(grid, spec, timing);
    const add = grid.querySelector(":scope > .entry-add-card");
    const was = old_rects.get("add-card");
    if (add && was) {
        const dy = was.top - now_rects.get("add-card").top;
        if (Math.abs(dy) >= 1) add.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing);
    } else if (add && morph === "mode") {
        add.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: "ease-out", delay: MORPH_MS * 0.3, fill: "backwards" });
    } else if (!add && was && morph === "mode") {
        leaveInGrid(grid, was, timing);
    }
}

// One card changing views or modes, as the game would move it: the card travels to its new
// place while its frame (an empty box, so nothing is stretched) grows or shrinks to its new
// size and look, and the slot travels and resizes on its own (it never fades).
// A change of view: the old contents fade out in place (a copy) and the new ones fade in.
// A change of mode: the parts it already had travel to their new places and only the new
// ones (the head strip, the buttons) fade in. Nothing that rests hidden (a tooltip shown
// on hover, the grip) is animated, or it would flash.
function morphCard(card, old, now, timing, how) {
    const keep = how === "mode";
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const unit = slotUnit(card);
    // The slot scales about its own corner, wherever it sits in its wrapper.
    let origin = "0 0";
    if (unit) {
        const slot = unit.querySelector(".mc-slot") || unit;
        const inner = slot.getBoundingClientRect();
        const outer = unit.getBoundingClientRect();
        origin = `${inner.left - outer.left}px ${inner.top - outer.top}px`;
    }
    const fading = [...card.children].filter(child => child !== unit && !child.matches(".slot-tip, .stack-edit") && getComputedStyle(child).opacity === "1" && !(keep && old.parts.has(partName(child))));
    const looks = (box, chrome) => ({ width: box.width + "px", height: box.height + "px", backgroundColor: chrome.background, borderColor: chrome.border, borderRadius: chrome.radius });
    const frame = h("div", { class: "card-frame", "aria-hidden": "true" });
    frame.style.left = frame.style.top = -now.chrome.width + "px";
    card.prepend(frame);
    card.classList.add("morphing");
    // The card is laid out at its new size, so the new contents are uncovered as the box grows
    // (clipped to it, like the frame) and can start to fade in early instead of waiting for it.
    const cut = box => `inset(0px ${now.width - box.width}px ${now.height - box.height}px 0px)`;
    const animations = [
        card.animate([{ transform: `translate(${dx}px, ${dy}px)`, clipPath: cut(old) }, { transform: "none", clipPath: cut(now) }], timing),
        frame.animate([looks(old, old.chrome), looks(now, now.chrome)], { ...timing, fill: "forwards" }) // holds its last look until the plain card replaces it
    ];
    let ghost = null;
    if (!keep && old.ghost) {
        // In the grid beside the card, not in it: inside a List or Slots card its rules (a smaller slot...) would reach the copy.
        ghost = h("div", { class: "card-ghost", "aria-hidden": "true" }, old.ghost);
        ghost.style.left = now.left + "px";
        ghost.style.top = now.top + "px";
        card.parentElement.append(ghost);
        animations.push(ghost.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing));
        animations.push(ghost.animate([{ width: old.width + "px", height: old.height + "px" }, { width: now.width + "px", height: now.height + "px" }], timing));
        animations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: timing.duration * 0.25, easing: "ease-out", fill: "forwards" }));
    }
    if (keep) {
        for (const child of card.children) {
            const was = old.parts.get(partName(child));
            const is = now.parts.get(partName(child));
            if (!was || !is || child === unit) continue;
            animations.push(child.animate([{ transform: `translate(${was.left - is.left - dx}px, ${was.top - is.top - dy}px)` }, { transform: "none" }], timing));
        }
    }
    if (unit && old.slot && now.slot) {
        unit.style.zIndex = "2";
        const move = `translate(${old.slot.left - now.slot.left - dx}px, ${old.slot.top - now.slot.top - dy}px) scale(${old.slot.width / now.slot.width}, ${old.slot.height / now.slot.height})`;
        animations.push(unit.animate([{ transform: move, transformOrigin: origin }, { transform: "none", transformOrigin: origin }], timing));
    }
    for (const child of fading) {
        animations.push(child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: timing.duration * 0.55, delay: timing.duration * (keep ? 0.15 : 0.15), easing: "ease-out", fill: "backwards" }));
    }
    // Back to the plain card once everything has played; the timer covers a hidden tab.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        frame.remove();
        if (ghost) ghost.remove();
        card.classList.remove("morphing");
        if (unit) unit.style.zIndex = "";
    };
    Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    setTimeout(finish, timing.duration + 150);
}

// An element's box as keyframe values (its height, margins, paddings and borders), and the same all
// at zero. A box that folds away must shrink all of these, not only its height: padding and borders
// keep an element tall, and it would end its animation still that tall and then vanish with a jump.
const BOX_SIDES = ["marginTop", "marginBottom", "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"];
const FOLDED = { height: "0px", ...Object.fromEntries(BOX_SIDES.map(side => [side, "0px"])) };

function boxOf(element) {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height + "px", ...Object.fromEntries(BOX_SIDES.map(side => [side, style[side]])) };
}

// A bar that has just appeared (Custom's coverage chips) opens from no height and fades in;
// one that has gone (`old`: { height, margin, clone }, from barSnapshot) closes the same way
// in its place, under `anchor`, so what follows slides with it.
export function revealBar(bar) {
    if (!motion_ok()) return;
    const box = boxOf(bar);
    bar.style.overflow = "hidden";
    const clear = () => { bar.style.overflow = ""; };
    bar.animate([{ ...FOLDED, opacity: 0 }, { ...box, opacity: 1 }], { duration: MORPH_MS, easing: MORPH_EASING }).finished.then(clear, clear);
    setTimeout(clear, MORPH_MS + 150);
}

export function barSnapshot(bar) {
    if (!bar) return null;
    const copy = inertCopy(bar);
    copy.style.margin = "0";
    return { box: boxOf(bar), clone: copy };
}

export function leaveBar(anchor, old) {
    if (!motion_ok() || !old || !anchor) return;
    const wrap = h("div", { class: "bar-leaving", "aria-hidden": "true" }, old.clone);
    wrap.style.overflow = "hidden";
    wrap.style.pointerEvents = "none";
    anchor.after(wrap);
    const remove = () => wrap.remove();
    wrap.animate([{ ...old.box, opacity: 1 }, { ...FOLDED, opacity: 0 }], { duration: MORPH_MS, easing: MORPH_EASING, fill: "forwards" }).finished.then(remove, remove);
    setTimeout(remove, MORPH_MS + 150);
}

// The coverage chips of a folded "All n reached" menu roll out of its chip one row at a
// time (rollChipsIn, after the redraw that shows them; `old_height` is the strip's height
// before) and back into it, the last row first (rollChipsOut, then `done` redraws).
const ROLL_STEP_MS = 80;

function chipRows(strip) {
    const summary = strip.querySelector(".cover-chip.summary");
    const chips = [...strip.querySelectorAll(".cover-chip.ok:not(.summary)")];
    const tops = [...new Set(chips.map(chip => Math.round(chip.getBoundingClientRect().top)))].sort((a, b) => a - b);
    return { summary, chips, rows: tops.length, row: chip => tops.indexOf(Math.round(chip.getBoundingClientRect().top)) };
}

// How far a chip sits from the summary chip: the ones on its row slide out from under it,
// the rows below drop from its row.
function fromSummary(summary, chip) {
    const from = summary.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    const same_row = Math.abs(box.top - from.top) < 4;
    return same_row ? { dx: Math.min(0, from.left + from.width / 2 - box.left), dy: 0 } : { dx: 0, dy: from.top - box.top };
}

export function rollChipsIn(strip, old_height) {
    if (!motion_ok()) return;
    const { summary, chips, rows, row } = chipRows(strip);
    if (!summary || !chips.length) return;
    growSmoothly(strip, old_height, { duration: 240 + (rows - 1) * ROLL_STEP_MS, easing: MORPH_EASING });
    const seen = new Map();
    for (const chip of chips) {
        const r = row(chip);
        const column = seen.get(r) || 0;
        seen.set(r, column + 1);
        const { dx, dy } = fromSummary(summary, chip);
        chip.animate([{ opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.8)` }, { opacity: 1, transform: "none" }],
            { duration: 280, delay: r * ROLL_STEP_MS + column * 18, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)", fill: "backwards" });
    }
}

export function rollChipsOut(strip, done) {
    const { summary, chips, rows, row } = chipRows(strip);
    if (!motion_ok() || !summary || !chips.length) return done();
    const open = strip.getBoundingClientRect().height;
    for (const chip of chips) chip.style.display = "none";
    const closed = strip.getBoundingClientRect().height;
    for (const chip of chips) chip.style.display = "";
    const total = 200 + (rows - 1) * ROLL_STEP_MS;
    strip.style.overflow = "hidden";
    strip.style.pointerEvents = "none";
    strip.animate([{ height: open + "px" }, { height: closed + "px" }], { duration: total, easing: MORPH_EASING, fill: "forwards" });
    const seen = new Map();
    for (const chip of chips) {
        const r = row(chip);
        const column = seen.get(r) || 0;
        seen.set(r, column + 1);
        const { dx, dy } = fromSummary(summary, chip);
        chip.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.8)` }],
            { duration: 200, delay: (rows - 1 - r) * ROLL_STEP_MS + column * 12, easing: "ease-in", fill: "forwards" });
    }
    setTimeout(done, total + 20);
}

// A "Pick one" group's chosen row when it appears (None to an enchantment) opens from no height
// and fades in; when it goes (an enchantment to None) a copy of it (`copy`, from inertCopy)
// closes the same way where it was, so the group and what follows slide with it.
export function openRow(row) {
    if (!motion_ok()) return;
    const box = boxOf(row);
    row.style.overflow = "hidden";
    const clear = () => { row.style.overflow = ""; };
    row.animate([{ ...FOLDED, opacity: 0 }, { ...box, opacity: 1 }], { duration: 300, easing: "ease-out" }).finished.then(clear, clear);
    setTimeout(clear, 450);
}

export function closeRow(group, copy) {
    if (!motion_ok()) return;
    group.append(copy);
    copy.style.overflow = "hidden";
    copy.style.pointerEvents = "none";
    const box = boxOf(copy);
    const remove = () => copy.remove();
    copy.animate([{ ...box, opacity: 1 }, { ...FOLDED, opacity: 0 }], { duration: 300, easing: "ease-out", fill: "forwards" }).finished.then(remove, remove);
    setTimeout(remove, 450);
}

// The coverage chips (Custom mode) when what they say changes: a chip that goes from amber to green
// (or back) fades between the looks and changes width, the others slide to their new places, new
// ones fade in, gone ones (folded away, or removed) fade out where they were, the ring fills or
// empties, and the strip grows or shrinks. chipSnapshot before the redraw, animateChips after it.
export function chipSnapshot(strip) {
    const snap = { height: 0, chips: new Map(), ring: null };
    if (!strip) return snap;
    const base = strip.getBoundingClientRect();
    snap.height = base.height;
    for (const chip of strip.querySelectorAll(".cover-chip[data-ns]")) {
        const box = chip.getBoundingClientRect();
        const style = getComputedStyle(chip);
        snap.chips.set(chip.dataset.ns, {
            short: chip.classList.contains("short"), left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height,
            background: style.backgroundColor, color: style.color, border: style.borderTopColor, copy: inertCopy(chip)
        });
    }
    const fill = strip.querySelector(".ring-fill");
    if (fill) snap.ring = fill.getAttribute("stroke-dasharray");
    return snap;
}

export function animateChips(strip, old) {
    if (!motion_ok() || !old.chips.size && old.ring == null) return;
    const timing = { duration: 320, easing: MORPH_EASING };
    if (old.height) growSmoothly(strip, old.height, timing);
    const base = strip.getBoundingClientRect();
    const seen = new Set();
    for (const chip of strip.querySelectorAll(".cover-chip[data-ns]")) {
        const was = old.chips.get(chip.dataset.ns);
        seen.add(chip.dataset.ns);
        if (!was) {
            chip.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out", fill: "backwards", delay: 60 });
            continue;
        }
        const box = chip.getBoundingClientRect();
        const dx = was.left - (box.left - base.left);
        const dy = was.top - (box.top - base.top);
        const changed = was.short !== chip.classList.contains("short");
        if (!changed) {
            if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) chip.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
            continue;
        }
        const style = getComputedStyle(chip);
        chip.style.overflow = "hidden";
        const clear = () => { chip.style.overflow = ""; };
        chip.animate([
            { transform: `translate(${dx}px, ${dy}px)`, width: was.width + "px", backgroundColor: was.background, color: was.color, borderColor: was.border },
            { transform: "none", width: box.width + "px", backgroundColor: style.backgroundColor, color: style.color, borderColor: style.borderTopColor }
        ], timing).finished.then(clear, clear);
        setTimeout(clear, timing.duration + 150);
    }
    // Chips that are no longer there fade out where they were.
    for (const [ns, was] of old.chips) {
        if (seen.has(ns)) continue;
        const ghost = h("span", { class: "chip-leaving", "aria-hidden": "true" }, was.copy);
        Object.assign(ghost.style, { left: was.left + "px", top: was.top + "px", width: was.width + "px", height: was.height + "px" });
        was.copy.style.margin = "0";
        strip.append(ghost);
        const remove = () => ghost.remove();
        ghost.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.85)" }], { duration: 220, easing: "ease-in", fill: "forwards" }).finished.then(remove, remove);
        setTimeout(remove, 400);
    }
    const fill = strip.querySelector(".ring-fill");
    if (fill && old.ring != null && old.ring !== fill.getAttribute("stroke-dasharray")) {
        fill.animate([{ strokeDasharray: old.ring }, { strokeDasharray: fill.getAttribute("stroke-dasharray") }], { duration: 420, easing: MORPH_EASING });
    }
}

// The highlight of a segmented switch (Automatic | Custom, Cards | Slots | List) slides
// to the button just chosen: pillRects before the redraw, slidePills after it.
export function pillRects(box) {
    const rects = new Map();
    for (const switcher of box.querySelectorAll(".segmented")) {
        const chosen = switcher.querySelector("button.selected");
        if (!chosen) continue;
        const outer = switcher.getBoundingClientRect();
        const inner = chosen.getBoundingClientRect();
        rects.set(switcher.classList[1], { left: inner.left - outer.left - switcher.clientLeft, width: inner.width });
    }
    return rects;
}

export function slidePills(box, old) {
    if (!motion_ok()) return;
    for (const switcher of box.querySelectorAll(".segmented")) {
        const was = old.get(switcher.classList[1]);
        const chosen = switcher.querySelector("button.selected");
        if (!was || !chosen) continue;
        const outer = switcher.getBoundingClientRect();
        const inner = chosen.getBoundingClientRect();
        const now = { left: inner.left - outer.left - switcher.clientLeft, width: inner.width };
        if (Math.abs(was.left - now.left) < 1 && Math.abs(was.width - now.width) < 1) continue;
        const pill = h("span", { class: "seg-pill", "aria-hidden": "true" });
        pill.style.left = now.left + "px";
        pill.style.width = now.width + "px";
        switcher.prepend(pill);
        switcher.classList.add("sliding");
        const finish = () => { pill.remove(); switcher.classList.remove("sliding"); };
        pill.animate([{ left: was.left + "px", width: was.width + "px" }, { left: now.left + "px", width: now.width + "px" }], { duration: 280, easing: MORPH_EASING }).finished.then(finish, finish);
        setTimeout(finish, 450);
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
