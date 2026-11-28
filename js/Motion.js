// Animations: slide a box to its new height or width, open and close tooltip lines, slide cards (FLIP), keep an element in place while the page redraws.
import { afterAnimation, h, motionOk, SLOW } from "./Dom.js";
import { meta } from "./Store.js";
import { steps_scroll } from "./Results.js";

// How long Section 2's view and mode switches, coverage bars, chips and highlights take, and how they ease.
const MORPH_MS = 360;
const MORPH_EASING = "cubic-bezier(0.25, 0.8, 0.25, 1)";
// Every fold (a section, a step, a group in section 1) takes this long and eases this way.
export const FOLD_MS = MORPH_MS;
export const FOLD_EASING = MORPH_EASING;

// How every view switch hides what goes (Section 2's Cards / Slots / List, Section 4's Steps / Slots / Tree). What comes is never faded in over
// what goes: two partly see-through layers add up to less than one, so the screen dips ("fades out, then appears"). What comes is drawn whole and
// is uncovered as its box grows; what goes is a copy laid over it, and the copy is the only thing that fades. (A new part with nothing going
// away from its place may still fade in.)
const COVER_FADE = 0.5; // how much of a morph the covering copy takes to fade
function fadeOutCover(copy, duration) {
    return copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * COVER_FADE, easing: "ease-in-out", fill: "forwards" });
}

// Holds the page's scroll at `y` (or at the page's new foot, when the page got shorter than that) for `ms`, frame by frame: while a box eases
// smaller, iPhone Safari (WebKit) let the scroll fall well past the foot (to the very top at the page's end). A touch, wheel or key lets go at once.
let scroll_hold = null;
export function holdScroll(y, ms = MORPH_MS + 200) {
    if (scroll_hold) scroll_hold.stop();
    const until = performance.now() + ms * SLOW; // (a clock, not a timer: slowed by hand)
    let frame = 0;
    const stop = () => { cancelAnimationFrame(frame); for (const type of ["wheel", "touchstart", "keydown"]) removeEventListener(type, stop, true); if (scroll_hold?.stop === stop) scroll_hold = null; };
    for (const type of ["wheel", "touchstart", "keydown"]) addEventListener(type, stop, { capture: true, passive: true });
    const tick = () => {
        const want = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
        if (Math.abs(scrollY - want) > 1) scrollTo(scrollX, want);
        if (performance.now() < until) frame = requestAnimationFrame(tick); else stop();
    };
    scroll_hold = { stop };
    tick();
}

// `timing` (optional): { duration, easing } to slide with instead of the default 0.25s ease-out.
export function growSmoothly(element, from, timing = null) {
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1 || !motionOk()) return;
    // A WAAPI animation, not a CSS transition: a transition is cancelled when an ancestor is hidden for a moment (the item bar's `measure`
    // switches the card to its condensed form and back to measure it, and the card jumped to its new height), an animation is not.
    // `.resizing` clips the box meanwhile (`overflow: clip`: a hidden overflow could be scrolled, and focusing inside it scrolled the box).
    const duration = timing ? timing.duration : 250;
    element.getAnimations().filter(a => a.id === "grow").forEach(a => a.cancel());
    element.classList.add("resizing");
    const animation = element.animate([{ height: from + "px" }, { height: to + "px" }], { duration, easing: timing ? timing.easing : "ease-out" });
    animation.id = "grow";
    // Back to its natural height once done. The timer covers a slide that never ends (a hidden tab), so it can never stay stuck.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        if (!element.getAnimations().some(a => a.id === "grow" && a !== animation)) element.classList.remove("resizing");
    };
    animation.finished.then(finish, finish);
    setTimeout(finish, duration + 150);
}

// New tooltip lines open from no height in their own place (and fade in), so the lines
// below them slide down with the box, wherever in the list they were added. Same
// duration and easing as growSmoothly, so the lines and the box move together.
export function openLines(lines) {
    if (!motionOk()) return;
    for (const line of lines) {
        const height = line.getBoundingClientRect().height;
        line.style.overflow = "clip";
        afterAnimation(line.animate([{ height: "0px" }, { height: height + "px" }], { duration: 250, easing: "ease-out" }), () => { line.style.overflow = ""; });
        line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: "ease-out" });
    }
}

// A copy of a tooltip line that is going (rolling or folding away): for show only.
function retireLine(node) {
    node.classList.remove("fresh");
    node.setAttribute("aria-hidden", "true");
    node.removeAttribute("data-ns");
    return node;
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
    if (!motionOk()) return;
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
            // Clipped to its own row while it rolls, so it never draws over the rows beside it.
            line.style.overflow = "clip";
            afterAnimation(line.animate([{ transform: `translateY(${100 * sign}%)`, clipPath: up ? "inset(0 0 100% 0)" : "inset(100% 0 0 0)" }, { transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }],
                { ...options, fill: "backwards" }), () => { line.style.overflow = ""; }, 450);
        }
        if (old && old.box) {
            const ghost = retireLine(old.node);
            Object.assign(ghost.style, { position: "absolute", left: old.box.left + "px", top: old.box.top + "px", width: old.box.width + "px", height: old.box.height + "px", margin: "0", pointerEvents: "none", overflow: "clip" });
            tooltip.append(ghost);
            afterAnimation(ghost.animate([{ transform: "translateY(0)", clipPath: "inset(0 0 0 0)" }, { transform: `translateY(${-100 * sign}%)`, clipPath: up ? "inset(100% 0 0 0)" : "inset(0 0 100% 0)" }],
                { ...options, fill: "forwards" }), () => ghost.remove(), 450);
        }
    }
}

// The tooltip is as wide as its longest line; when that changes, its width slides from the
// old one (lines stay on one line meanwhile, so the height doesn't jump).
export function slideWidth(tooltip, from, from_height = null) {
    if (!tooltip || from == null || !motionOk()) return;
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

// A tooltip's enchantment lines before a redraw: `{ rect, lines: [{ ns, node, box }] }`, each line a copy (inert: nothing in it may take
// focus or be found by data-focus) and its box inside the tooltip's padding box, for `changeLines`.
export function snapshotLines(tip) {
    const rect = tip.getBoundingClientRect();
    const lines = [...tip.querySelectorAll(".mc-ench[data-ns]")].map(line => {
        const line_rect = line.getBoundingClientRect();
        const copy = line.cloneNode(true);
        copy.removeAttribute("data-focus");
        copy.setAttribute("tabindex", "-1");
        copy.classList.remove("popover-toggle");
        return { ns: line.dataset.ns, node: copy, box: { left: line_rect.left - rect.left - tip.clientLeft, top: line_rect.top - rect.top - tip.clientTop, width: line_rect.width, height: line_rect.height } };
    });
    return { rect, lines };
}

// A redraw's change to a tooltip's lines: a swap that leaves the box the same size rolls the changed rows together (`rollLines`),
// otherwise the `fresh` lines open and the removed ones fold away (`openLines`/`closeLines`). `container` holds the tooltip.
export function changeLines(container, old_lines, fresh, same_size) {
    if (same_size) {
        rollLines(container, old_lines);
    } else {
        openLines(fresh);
        closeLines(container, old_lines);
    }
}

// Removed tooltip lines close the way new ones open: a copy stays in its place and folds
// away (shrinking and fading), so the lines below slide up with the box instead of jumping.
export function closeLines(preview, old_lines) {
    if (!motionOk()) return;
    const tooltip = preview.querySelector(".mc-tooltip");
    if (!tooltip) return;
    const kept = new Set([...tooltip.querySelectorAll(".mc-ench[data-ns]")].map(line => line.dataset.ns));
    old_lines.forEach(({ ns, node }, index) => {
        if (kept.has(ns)) return;
        const ghost = retireLine(node);
        ghost.style.pointerEvents = "none";
        const lines = tooltip.querySelectorAll(".mc-ench");
        const before = lines[Math.min(index, lines.length)];
        before ? before.before(ghost) : tooltip.append(ghost);
        const height = ghost.getBoundingClientRect().height;
        ghost.style.overflow = "clip"; // never over the lines beside it while it closes
        const remove = () => ghost.remove();
        afterAnimation(ghost.animate([{ height: height + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 250, easing: "ease-out", fill: "forwards" }), remove, 400);
    });
}

// What moves with a card's slot between views: the slot's wrapper (or button), a direct child of the card.
function slotUnit(card) {
    let unit = card.querySelector(".mc-slot");
    while (unit && unit.parentElement !== card) unit = unit.parentElement;
    return unit;
}

// A part of a card, by its first class (the tooltip, the head strip, the summary...).
const COPIES_OFFSET = { right: 8, bottom: 10 }; // the - / + from its slot's bottom-right corner (Style.css .copies-control)
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
    if (hide_slot) clone.querySelectorAll(":scope > .copies-control").forEach(part => part.remove());
    clone.querySelectorAll(":scope > .slot-tip, :scope > .card-frame, :scope > .card-ghost").forEach(part => part.remove());
    clone.classList.remove("fresh", "flash", "highlight", "popover-open", "dragging", "drop-target", "merge-target", "drag-source", "morphing");
    for (const name of ["data-key", "data-index"]) clone.removeAttribute(name);
    clone.style.width = box.width + "px";
    clone.style.height = box.height + "px";
    return clone;
}

// A card's copy and remove buttons (by class).
const TOOLS = ["entry-tool", "entry-remove"];

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
            // The stack count's - / +, where it was (or where a flyer of it is, caught mid-switch): it flies from there (morphCard).
            control: (() => { const c = document.querySelector(`body > .copies-flyer[data-for="${CSS.escape(card.dataset.key)}"]`) || card.querySelector(".copies-control"); const r = c && c.getBoundingClientRect(); return r && r.width >= 1 && getComputedStyle(c).visibility !== "hidden" ? relative(r) : null; })(),
            // The copy and remove buttons (⧉ and ×), where they were: they travel to their new places on a view change (morphCard).
            tools: Object.fromEntries(TOOLS.map(name => { const b = card.querySelector("." + name); const r = b && b.getBoundingClientRect(); return [name, r && r.width >= 1 && getComputedStyle(b).visibility !== "hidden" ? relative(r) : null]; })),
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
    afterAnimation(leaving.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96)" }], { duration: timing.duration * 0.6, easing: "ease-in", fill: "forwards" }), remove, timing.duration + 150);
}

// After a redraw, each card slides from where it was to where it is now (reordering,
// or the cards after an added or removed one), new cards fade in, and the grid's height
// slides too (growSmoothly), so nothing jumps.
// `morph`: "view" (a switch between Cards, Slots and List) or "mode" (Automatic and
// Custom: the same entries gain or lose their tools; `leaving` are old cards with no new one): see morphCard.
export function animateCards(box, old_rects, old_height, morph = false, leaving = []) {
    if (!motionOk() || !old_rects.size && !leaving.length) return;
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
    // (Where the old contents are a copy laid over the card, the new ones are simply there under it: only what has nothing going away over it fades in.)
    // (Always, even with the old contents' copy over it: the new tooltip fades in while the old one fades out, so every switch both shows it going
    // and coming; it was skipped where a copy lay over it, and then whether a tooltip faded depended on which view it came from.)
    const fading = [...card.children].filter(child => child !== unit && !child.matches(".slot-tip, .copies-control") && getComputedStyle(child).opacity === "1" && !(keep && old.parts.has(partName(child))));
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
        // (Exactly the card's box, so the card's edge is what cuts it.)
        animations.push(ghost.animate([{ width: old.width + "px", height: old.height + "px" }, { width: now.width + "px", height: now.height + "px" }], timing));
        // Its tooltip fades from the first frame (ease-out: most of the fade early, while the card's box is still closing over it), so it is seen
        // fading as the card's edge cuts it, even into a Slots card, whose box closes most of the way in the first frames.
        animations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: timing.duration * 0.5, easing: "ease-out", fill: "forwards" }));
    }
    if (keep) {
        for (const child of card.children) {
            const was = old.parts.get(partName(child));
            const is = now.parts.get(partName(child));
            if (!was || !is || child === unit) continue;
            animations.push(child.animate([{ transform: `translate(${was.left - is.left - dx}px, ${was.top - is.top - dy}px)` }, { transform: "none" }], timing));
        }
    }
    // The stack count's - / + (in every view; always shown on touch) rides its slot's bottom-right corner, unfaded, and above every slot: a copy of it
    // flies in the grid itself (a card is a layer of its own, so the slots of the cards after it would pass over the real one) while the real one hides.
    const copies_flyers = [];
    const slot_of = card.querySelector(".mc-slot");
    for (const control of card.querySelectorAll(".copies-control")) {
        if (!old.slot || !now.slot || !slot_of) continue;
        // (Hidden ones too, at any width: with a mouse it shows only while its card is hovered, and the copy shows exactly when it would.)
        // (Measured whole: the control and its - and + shown for a moment, as on hover; a count of 1 is nothing but them.)
        const parts = [control, ...control.querySelectorAll(".copies-step")];
        const shown = parts.map(part => part.style.display);
        parts.forEach((part, i) => { part.style.display = i ? "inline-flex" : "flex"; });
        const r = control.getBoundingClientRect(), s0 = slot_of.getBoundingClientRect();
        parts.forEach((part, i) => { part.style.display = shown[i]; });
        if (r.width < 1) continue;
        // Where it sits by its slot: its right edge 8px past the slot's and its bottom 10px below (Style.css .copies-control, the same in every view
        // and whether its - and + show). Not measured here: mid-switch the card is laid out as neither view, and that put it off by up to 15px.
        const off = COPIES_OFFSET;
        const fly = control.cloneNode(true);
        fly.classList.add("copies-flyer");
        fly.dataset.for = card.dataset.key;
        fly.setAttribute("aria-hidden", "true");
        // (On the page, fixed, not in the grid: the grid clips while its height eases, and cut the copies off under the slots of a short new row.
        // Under the item bar, z-index 25.)
        Object.assign(fly.style, { position: "fixed", left: "auto", bottom: "auto", margin: "0", zIndex: "20", pointerEvents: "none" });
        document.body.append(fly);
        control.style.visibility = "hidden";
        copies_flyers.push({ fly, control, off });
    }
    // Each frame every copy is put by its own slot as that slot is drawn now (wherever its glide has got to), held by its right edge and bottom
    // as the real one is, so it never drifts from its icon; and it shows what its real one would show (the control, and its - and + by the count).
    if (copies_flyers.length) {
        const grid = card.parentElement;
        const follow = () => {
            if (!copies_flyers.every(({ fly }) => fly.isConnected)) return;
            const s = slot_of.getBoundingClientRect();
            for (const entry of copies_flyers) {
                const { fly, control } = entry;
                fly.style.display = getComputedStyle(control).display;
                const real_parts = control.querySelectorAll("*"), fly_parts = fly.querySelectorAll("*");
                real_parts.forEach((part, i) => { if (fly_parts[i]) fly_parts[i].style.display = getComputedStyle(part).display; });                const { off } = entry;
                // (By its left edge, from its width now: a fixed box's `right` counts from the window's edge, past the scrollbar.)
                fly.style.right = "auto";
                fly.style.left = s.right + off.right - fly.offsetWidth + "px";
                fly.style.top = s.bottom + off.bottom - fly.offsetHeight + "px";
            }
            requestAnimationFrame(follow);
        };
        queueMicrotask(follow); // (first once the slot's glide is set up below, before anything is drawn)
    }
    // A change of view: the copy and remove buttons travel from where they were to where they are (in the grid beside the card, in a bare card so the
    // card's button rules reach them, unfaded: the old ones are hidden in the copy of the old contents, the real new ones until the end).
    const tool_flyers = [];
    if (!keep) {
        for (const name of TOOLS) {
            const button = card.querySelector("." + name), was = old.tools?.[name], is = now.tools?.[name];
            if (!button || !was || !is) continue;
            const fly = button.cloneNode(true);
            fly.removeAttribute("data-focus");
            fly.tabIndex = -1;
            const wrap = h("div", { class: "entry-card tool-fly", "aria-hidden": "true" }, fly);
            wrap.inert = true;
            wrap.style.left = is.left + "px";
            wrap.style.top = is.top + "px";
            card.parentElement.append(wrap);
            const size = box => ({ width: box.width + "px", height: box.height + "px" });
            fly.style.boxSizing = "border-box";
            animations.push(wrap.animate([{ transform: `translate(${was.left - is.left}px, ${was.top - is.top}px)` }, { transform: "none" }], timing));
            animations.push(fly.animate([size(was), size(is)], timing));
            const in_copy = old.ghost?.querySelector("." + name);
            if (in_copy) in_copy.style.visibility = "hidden";
            button.style.visibility = "hidden";
            tool_flyers.push({ wrap, button });
        }
    }
    if (unit && old.slot && now.slot) {
        unit.style.zIndex = "2";
        const move = `translate(${old.slot.left - now.slot.left - dx}px, ${old.slot.top - now.slot.top - dy}px) scale(${old.slot.width / now.slot.width}, ${old.slot.height / now.slot.height})`;
        animations.push(unit.animate([{ transform: move, transformOrigin: origin }, { transform: "none", transformOrigin: origin }], timing));
    }
    for (const child of fading) {
        animations.push(child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: timing.duration * 0.55, delay: timing.duration * 0.15, easing: "ease-out", fill: "backwards" }));
    }
    // Back to the plain card once everything has played; the timer covers a hidden tab.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        frame.remove();
        if (ghost) ghost.remove();
        for (const { fly, control } of copies_flyers) { fly.remove(); control.style.visibility = ""; }
        for (const { wrap, button } of tool_flyers) { wrap.remove(); button.style.visibility = ""; }
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

// A section opening or closing: its body, and the gap under its heading, slide to or from no
// height. Opening applies the new state first (`apply` shows the body), then slides it open; closing
// slides first and applies at the end (`apply` hides the body), with the arrow already turned
// (`.closing`). Both sizes are fixed while it slides, since on a wide screen section 4's card and body
// stretch to fill the column. A second toggle mid-slide finishes the first at once.
export function slideSection(card, closing, apply) {
    if (card.finishSlide) card.finishSlide();
    const body = card.querySelector(":scope > .section-body");
    const head = card.querySelector(":scope > h2, :scope > .section-head");
    if (!motionOk() || !body || !head) return apply();
    const gapOf = () => parseFloat(getComputedStyle(head).marginBottom) || 0;
    let from = { height: body.getBoundingClientRect().height, gap: gapOf() };
    let to = { height: 0, gap: 0 };
    if (closing) {
        card.classList.add("closing");
    } else {
        apply();
        to = { height: body.getBoundingClientRect().height, gap: gapOf() };
        from = { height: 0, gap: 0 };
    }
    const frame = box => ({ height: box.height + "px", marginBottom: box.gap + "px" });
    const fixed = [card, body];
    for (const element of fixed) element.style.flex = "none";
    body.style.overflow = "hidden";
    const animations = [
        body.animate([{ height: frame(from).height, opacity: closing ? 1 : 0 }, { height: frame(to).height, opacity: closing ? 0 : 1 }], { duration: MORPH_MS, easing: MORPH_EASING }),
        head.animate([{ marginBottom: frame(from).marginBottom }, { marginBottom: frame(to).marginBottom }], { duration: MORPH_MS, easing: MORPH_EASING })
    ];
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        card.finishSlide = null;
        for (const animation of animations) animation.cancel();
        for (const element of fixed) element.style.flex = "";
        body.style.overflow = "";
        card.classList.remove("closing");
        if (closing) apply();
    };
    card.finishSlide = finish;
    Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    setTimeout(finish, MORPH_MS + 150);
}

// A box that has just appeared opens from no height and fades in; one that has gone (a copy of it,
// laid where it was) closes the same way, so what follows slides with it.
function openBox(element, duration, easing) {
    if (!motionOk()) return;
    const box = boxOf(element);
    element.style.overflow = "hidden";
    const clear = () => { element.style.overflow = ""; };
    afterAnimation(element.animate([{ ...FOLDED, opacity: 0 }, { ...box, opacity: 1 }], { duration, easing }), clear, duration + 150);
}

function closeBox(copy, duration, easing) {
    copy.style.overflow = "hidden";
    copy.style.pointerEvents = "none";
    const box = boxOf(copy);
    const remove = () => copy.remove();
    afterAnimation(copy.animate([{ ...box, opacity: 1 }, { ...FOLDED, opacity: 0 }], { duration, easing, fill: "forwards" }), remove, duration + 150);
}

// Custom's coverage chips (revealBar) appear and (leaveBar: `old` is { box, clone }, from barSnapshot, and
// the copy goes under `anchor`) go this way.
export function revealBar(bar) {
    openBox(bar, MORPH_MS, MORPH_EASING);
}

export function barSnapshot(bar) {
    if (!bar) return null;
    const copy = inertCopy(bar);
    copy.style.margin = "0";
    return { box: boxOf(bar), clone: copy };
}

export function leaveBar(anchor, old) {
    if (!motionOk() || !old || !anchor) return;
    const wrap = h("div", { class: "bar-leaving", "aria-hidden": "true" }, old.clone);
    anchor.after(wrap);
    // The wrapper takes the old box's size (its clone has none of its own margins), and closes.
    Object.assign(wrap.style, old.box);
    closeBox(wrap, MORPH_MS, MORPH_EASING);
}

// The coverage chips of a folded "All n reached" menu roll out of its chip one row at a
// time (rollChipsIn, after the redraw that shows them; `old_height` is the strip's height
// before) and back into it, the last row first (rollChipsOut, then `done` redraws).

function chipRows(strip) {
    const summary = strip.querySelector(".cover-chip.summary");
    const elements = [...strip.querySelectorAll(".cover-chip.ok:not(.summary)")];
    const tops = [...new Set(elements.map(chip => Math.round(chip.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const filled = new Map(); // chips counted so far in each row
    // Each chip with its row (0 = the first) and its place in that row.
    const chips = elements.map(chip => {
        const row = tops.indexOf(Math.round(chip.getBoundingClientRect().top));
        const column = filled.get(row) || 0;
        filled.set(row, column + 1);
        return { chip, row, column };
    });
    return { summary, chips, rows: tops.length };
}

// How far a chip sits from the summary chip: the ones on its row slide out from under it,
// the rows below drop from its row.
const CHIP_ROLL_MS = 320; // "All N reached" opening or closing
function fromSummary(summary, chip) {
    const from = summary.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    // (Straight from the summary's centre to the chip's: every chip comes out of, or goes back into, the summary on a line of its own.)
    return { dx: from.left + from.width / 2 - (box.left + box.width / 2), dy: from.top + from.height / 2 - (box.top + box.height / 2) };
}

export function rollChipsIn(strip, old_height) {
    if (!motionOk()) return;
    const { summary, chips, rows } = chipRows(strip);
    if (!summary || !chips.length) return;
    // All at once and at an even pace: each chip travels in a straight line out of the summary while the strip grows with them.
    growSmoothly(strip, old_height, { duration: CHIP_ROLL_MS, easing: "linear" });
    for (const { chip } of chips) {
        const { dx, dy } = fromSummary(summary, chip);
        chip.animate([{ opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.8)` }, { opacity: 1, transform: "none" }], { duration: CHIP_ROLL_MS, easing: "linear" });
    }
}

export function rollChipsOut(strip, done) {
    const { summary, chips, rows } = chipRows(strip);
    if (!motionOk() || !summary || !chips.length) return done();
    const open = strip.getBoundingClientRect().height;
    for (const { chip } of chips) chip.style.display = "none";
    const closed = strip.getBoundingClientRect().height;
    for (const { chip } of chips) chip.style.display = "";
    strip.style.overflow = "hidden";
    strip.style.pointerEvents = "none";
    // All at once and at an even pace, the reverse of opening: each chip goes back into the summary in a straight line while the strip shrinks.
    strip.animate([{ height: open + "px" }, { height: closed + "px" }], { duration: CHIP_ROLL_MS, easing: "linear", fill: "forwards" });
    for (const { chip } of chips) {
        const { dx, dy } = fromSummary(summary, chip);
        chip.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.8)` }], { duration: CHIP_ROLL_MS, easing: "linear", fill: "forwards" });
    }
    setTimeout(done, CHIP_ROLL_MS + 20);
}

// A "Pick one" group's chosen row when it appears (None to an enchantment) opens from no height
// and fades in; when it goes (an enchantment to None) a copy of it (`copy`, from inertCopy)
// closes the same way where it was, so the group and what follows slide with it.
export function openRow(row) {
    openBox(row, 300, "ease-out");
}

export function closeRow(parent, copy) {
    if (!motionOk()) return;
    parent.append(copy);
    closeBox(copy, 300, "ease-out");
}

// The coverage chips (Custom mode) when what they say changes: a chip that goes from amber to green
// (or back) crosses over from a copy of its old self, the others slide to their new places, new
// ones fade in, gone ones (folded away, or removed) fade out where they were, the ring fills or
// empties, and the strip grows or shrinks. chipSnapshot before the redraw, animateChips after it.
// Each enchantment's chip, and the summary ("All 7 reached"), which slides like them (its text changes in place).
const CHIPS = ".cover-chip[data-ns], .cover-chip.summary";
const chipKey = chip => chip.dataset.ns || "summary";
export function chipSnapshot(strip) {
    const snap = { height: 0, chips: new Map(), ring: null };
    if (!strip) return snap;
    const base = strip.getBoundingClientRect();
    snap.height = base.height;
    for (const chip of strip.querySelectorAll(CHIPS)) {
        const box = chip.getBoundingClientRect();
        snap.chips.set(chipKey(chip), {
            short: chip.classList.contains("short"), left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height, copy: inertCopy(chip)
        });
    }
    const fill = strip.querySelector(".ring-fill");
    if (fill) snap.ring = fill.getAttribute("stroke-dasharray");
    return snap;
}

// A copy of a chip as it was, laid over where it was (in the strip, which is positioned) for the animation to move or fade.
function leavingChip(strip, was) {
    const ghost = h("span", { class: "chip-leaving", "aria-hidden": "true" }, was.copy);
    Object.assign(ghost.style, { left: was.left + "px", top: was.top + "px", width: was.width + "px", height: was.height + "px" });
    was.copy.style.margin = "0";
    strip.append(ghost);
    return ghost;
}

export function animateChips(strip, old) {
    if (!motionOk() || !old.chips.size && old.ring == null) return;
    const timing = { duration: 320, easing: MORPH_EASING };
    if (old.height) growSmoothly(strip, old.height, timing);
    const base = strip.getBoundingClientRect();
    const seen = new Set();
    for (const chip of strip.querySelectorAll(CHIPS)) {
        const was = old.chips.get(chipKey(chip));
        seen.add(chipKey(chip));
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
        // A chip that changed state crosses over: a copy of the old one travels to the new place and fades
        // out while the new one travels and fades in. Its width is never animated: that would move every
        // chip after it, and the slides above would end up somewhere else.
        chip.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], timing);
        const ghost = leavingChip(strip, was);
        const remove = () => ghost.remove();
        afterAnimation(ghost.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${-dx}px, ${-dy}px)`, opacity: 0 }], timing), remove, timing.duration + 150);
    }
    // Chips that are no longer there fade out where they were.
    for (const [ns, was] of old.chips) {
        if (seen.has(ns)) continue;
        const ghost = leavingChip(strip, was);
        const remove = () => ghost.remove();
        afterAnimation(ghost.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.85)" }], { duration: 220, easing: "ease-in", fill: "forwards" }), remove, 400);
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
    if (!motionOk()) return;
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
        afterAnimation(pill.animate([{ left: was.left + "px", width: was.width + "px" }, { left: now.left + "px", width: now.width + "px" }], { duration: 280, easing: MORPH_EASING }), finish, 450);
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
    const behavior = motionOk() ? "smooth" : "auto";
    if (scrolls) box.scrollBy({ top: over, behavior });
    else scrollBy({ top: over, behavior });
}

// Runs `redraw` (which rebuilds the steps), then scrolls so the element matching
// `selector` is where it was on screen. Ticking or folding a step folds or unfolds others
// too (ticking one ticks the steps it needs), which moves everything below them; without
// this the list would jump, and the old scroll position would land somewhere else.
// The steps scroll inside their own box on desktop and with the page on phones.
export function keepInPlace(selector, redraw, eased = false) {
    const before = document.querySelector(selector);
    const top = before ? before.getBoundingClientRect().top : null;
    redraw();
    if (top == null) return;
    // Moves the scroll so the element is back at `top`; false when it is gone.
    const follow = () => {
        const after = document.querySelector(selector);
        if (!after) return false;
        const shift = after.getBoundingClientRect().top - top;
        if (Math.abs(shift) < 1) return true;
        const box = after.closest(".steps-scroll");
        if (box && box.scrollHeight > box.clientHeight) {
            box.scrollTop += shift;
            steps_scroll.top = box.scrollTop;
        } else {
            scrollBy(0, shift);
        }
        return true;
    };
    if (!follow() || !eased || !motionOk()) return;
    // The boxes above ease to their new heights (easeFold): hold the element in place frame by frame meanwhile.
    const start = performance.now();
    const tick = () => { follow(); if (performance.now() - start < FOLD_MS + 60) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
}

// A level bar that changes length (switching Depth Strider, III, for Frost Walker, II, in a
// "Pick one" group) rolls: segments it gains unroll from the left, one after another, and
// segments it loses (`old_segments`, copies of the old bar's) roll up from the right end
// and are removed. `old_levels` is how many the old bar had.
export function rollLevelBar(bar, old_levels, old_segments) {
    if (!motionOk()) return;
    const segments = [...bar.querySelectorAll(".level-seg")];
    const levels = segments.length;
    if (!levels || levels === old_levels) return;
    const options = { duration: 260, easing: "ease-out", fill: "backwards" };
    const roll = [{ transform: "scaleX(0)", opacity: 0 }, { transform: "scaleX(1)", opacity: 1 }];
    const animations = [];
    // Five levels to a row. A bar that gains or loses a row (Sharpness V to Dullness X) grows or shrinks
    // smoothly, so the row, the card and everything below follow it instead of jumping. Every level that
    // comes or goes does so at the same moment (not one after another), and the bar clips while any moves.
    const old_rows = Math.ceil(old_levels / 5);
    const rows = Math.ceil(levels / 5);
    const { width, height } = segments[0].getBoundingClientRect();
    if (rows !== old_rows) {
        bar.style.overflow = "hidden";
        animations.push(bar.animate([{ height: old_rows * height + "px" }, { height: rows * height + "px" }], { duration: 260, easing: "ease-out" }));
    }
    for (let index = old_levels; index < levels; index++) {
        segments[index].style.transformOrigin = "left center";
        animations.push(segments[index].animate(roll, options));
    }
    for (let index = levels; index < old_levels; index++) {
        const ghost = old_segments[index];
        if (!ghost) continue;
        ghost.removeAttribute("data-level");
        ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "absolute", top: Math.floor(index / 5) * height + "px", left: (index % 5) * width + "px", width: width + "px", height: height + "px", transformOrigin: "left center", pointerEvents: "none" });
        bar.append(ghost);
        const remove = () => ghost.remove();
        const out = ghost.animate([...roll].reverse(), { duration: 260, easing: "ease-in", fill: "forwards" });
        afterAnimation(out, remove, 900);
        animations.push(out);
    }
    // The empty track after the last level fades with it: cells that were track fade out (a copy), and cells
    // that are track now fade in (cells that stay track do not move).
    const old_track = old_rows * 5;
    const track = [...bar.querySelectorAll(".level-gap")];
    for (let index = levels; index < rows * 5; index++) {
        if (index >= old_levels && index < old_track) continue;
        const cell = track[index - levels];
        if (cell) animations.push(cell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out", fill: "backwards" }));
    }
    for (let index = old_levels; index < old_track; index++) {
        if (index >= levels) continue;
        const ghost = document.createElement("span");
        ghost.className = "level-gap";
        ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "absolute", top: Math.floor(index / 5) * height + "px", left: (index % 5) * width + "px", width: width + "px", height: height + "px", pointerEvents: "none" });
        bar.append(ghost);
        const remove = () => ghost.remove();
        const out = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" });
        afterAnimation(out, remove, 900);
        animations.push(out);
    }
    const settle = () => { bar.style.overflow = ""; };
    Promise.allSettled(animations.map(animation => animation.finished)).then(settle);
    setTimeout(settle, 1000);
}

// Eases `element` from the height it had (`from`) to its new one, like a section folding (FOLD_MS, FOLD_EASING); it clips while it
// does (a folding step hides what is inside). Options: `duration`/`easing` (a fold's by default), `fade` (opacity follows a box that
// opens from or closes to nothing), `during` (runs when it starts and returns what to run when it ends).
// `overhang`: what the element draws outside its box on the sides and top, in px (a step's circle on the rail, its ring): then only the bottom edge, the
// one that moves, clips (a clip-path), instead of every edge (overflow: hidden), so those parts stay on show while it eases.
export function easeHeight(element, from, { duration = FOLD_MS, easing = FOLD_EASING, fade = false, during, overhang = 0 } = {}) {
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1 || !motionOk()) return;
    if (overhang) element.style.clipPath = `inset(-${overhang}px -${overhang}px 0 -${overhang}px)`;
    else element.style.overflow = "hidden";
    const restore = during && during();
    const clear = () => { element.style.overflow = ""; element.style.clipPath = ""; if (restore) restore(); };
    const frame = height => ({ height: height + "px", ...(fade ? { opacity: height ? 1 : 0 } : {}) });
    afterAnimation(element.animate([frame(from), frame(to)], { duration, easing }), clear, duration + 150);
}

// A summary's click: fold its `<details>` with the shared slide (foldDetails) instead of the browser's own jump. `remember(open)` saves the new state at
// once (a closing slide only sets `open` at its end). Every fold-away box in section 1 takes its clicks from here.
export function foldClick(remember) {
    return event => {
        event.preventDefault();
        const details = event.currentTarget.parentElement;
        const open = !foldTarget(details);
        remember(open);
        foldDetails(details, open);
    };
}

// Whether a `<details>` is open or, while it slides, where it is heading (a click mid-slide reverses it).
export const foldTarget = details => (details.wantOpen === undefined ? details.open : details.wantOpen);

// A `<details>` opening or closing the way a section does: its box slides between the closed and the open height. Closing
// keeps the content shown until the end; `inside` (details nested in it) close then too, out of sight. Returns nothing; with no motion it
// just sets `open`. A box whose content is made only when it opens (the conflict graph) sets `details.beforeFold(open)`: it runs first, so the content
// is there when the slide measures the box, however the fold was asked for (a click on its summary, Expand groups).
// iPhone browsers (WebKit) can keep a closed <details> inside another at the height it had open, an empty space, once the outer one opens again:
// taking each closed one out of the layout for a moment makes it measure itself anew.
function relayoutClosed(details) {
    for (const nested of details.querySelectorAll("details:not([open])")) {
        const display = nested.style.display;
        nested.style.display = "none";
        void nested.offsetHeight;
        nested.style.display = display;
    }
}

export function foldDetails(details, open, inside = []) {
    if (details.finishFold) details.finishFold();
    if (details.open === open) return;
    if (details.beforeFold) details.beforeFold(open);
    details.wantOpen = open; // where it is heading, for a second click mid-slide (foldTarget)
    // The boxes inside close first, while this one is still drawn: iPhone browsers (WebKit) don't lay out a <details> closed while it is hidden in a closed
    // one, so it kept its open height and reopened as an empty space.
    const settle = () => { if (!open) for (const nested of inside) nested.open = false; details.open = open; if (open) relayoutClosed(details); };
    if (!motionOk()) return settle();
    const from = details.getBoundingClientRect().height;
    let to;
    if (open) {
        details.open = true;
        relayoutClosed(details);
        to = details.getBoundingClientRect().height;
    } else {
        details.open = false;
        to = details.getBoundingClientRect().height;
        details.open = true;
    }
    if (Math.abs(to - from) < 1) return settle();
    details.style.overflow = "hidden";
    const animation = details.animate([{ height: from + "px" }, { height: to + "px" }], { duration: FOLD_MS, easing: FOLD_EASING });
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        details.finishFold = null;
        details.wantOpen = undefined;
        animation.cancel();
        details.style.overflow = "";
        settle();
    };
    details.finishFold = finish;
    afterAnimation(animation, finish, FOLD_MS + 150);
}

// Section 4 switching between Steps, Slots and Tree (or Compact): each step travels from where it was to where it is
// now, as Section 2's cards do between Cards, Slots and List. The step's box (an empty frame, so nothing is stretched)
// grows or shrinks to its new size and look while the slots glide and scale to their new places, the old contents (a
// copy) fade out and the new ones fade in; the rail, the round labels and the tree's branches fade in on their own.
// A Steps card, a Compact Steps card and a Tree line are the same step (`data-step-card`).

// What travels with a step by name: the "+", the arrow, the cost, the rail's node and the head (Steps, Slots share all of these). The item icons are
// not here: each is its own flyer (morphView), matched by item (`data-node`) across all three views.
const STEP_BITS = { node: ".step-node", head: ".step-head", checkpoint: ".level-checkpoint", op: ".anvil-op", arrow: ".arrow-glyph", cost: ".anvil-cost" };
function stepSlots(box) {
    const found = new Map();
    if (!box.classList.contains("tree-line")) {
        for (const [name, selector] of Object.entries(STEP_BITS)) {
            const bit = box.querySelector(selector);
            if (bit) found.set(name, bit);
        }
    }
    return found;
}

const chromeOf = style => ({
    background: style.backgroundColor, border: parseFloat(style.borderTopWidth) > 0 ? style.borderColor : "rgba(0, 0, 0, 0)",
    radius: style.borderTopLeftRadius, width: parseFloat(style.borderTopWidth) || 0
});

// The steps as they are before the view changes: a copy of the whole box to fade out, where it was, and each step's box
// and slots (by step number) with the matching parts of the copy. Nothing in the copy may be found as a step, a tick box
// or a link to a card (the real ones are what the page and the tests look up).
// Everything a switch lays over the scroller (the old view's copies, the frames, the flyers) borrows the classes and attributes of the parts it copies
// (`.tree-caption`, `[data-node]`...). Every lookup of what is really in the view goes through here, which leaves the overlay out, so the switch can never
// take its own flyers for the new view's parts (and fly a flyer). The overlay is marked `.view-overlay`.
const real = (scroller, selector) => [...scroller.querySelectorAll(selector)].filter(el => !el.closest(".view-overlay"));

// Where a thing that a view hides (inside a folded step, or under a folded Tree line) goes to or comes from: a point in the card or line that holds it
// (a little in from its left, a line down), relative to `origin`; or null if even that is not shown.
function hostPoint(el, origin) {
    let host = el.closest(".tree-line, [data-step-card]");
    while (host) {
        const r = host.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) return { left: r.left - origin.left + 16, top: r.top - origin.top + Math.min(r.height / 2, 20) };
        const list = host.closest("ul.tree-children");
        host = list ? list.parentElement.querySelector(":scope > .tree-line") : null;
    }
    return null;
}

let settling = null; // ends the morph in progress (set by morphView)
const arc_stops = new Set(); // the arcs in progress (morphStep): a new switch stops them first, or it measured the arrow where the last frame had put it
export function viewSnapshot(scroller) {
    for (const stop of [...arc_stops]) stop();
    // A switch while the last one is still running starts from where that one ends (not from a copy of its frames and its old copy).
    if (settling) { const end = settling; settling = null; end(); }
    // So does one that folds a step (its contents stay on show while it shrinks): it ends first, or they would be copied as if they stayed.
    for (const animation of scroller.getAnimations({ subtree: true })) if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.cancel();
    for (const folding of scroller.querySelectorAll(".folding")) { folding.classList.remove("folding"); folding.style.overflow = ""; }
    const base = scroller.getBoundingClientRect();
    const rel = element => { const r = element.getBoundingClientRect(); return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height }; };
    const copy = inertCopy(scroller);
    // A second copy, all hidden but the parts the panel holds, goes above the panel's frame (the first is under it), so those show only inside it.
    const held_copy = inertCopy(scroller);
    copy.classList.add("view-overlay");
    held_copy.classList.add("view-overlay");
    held_copy.style.visibility = "hidden";
    const twins = [...copy.querySelectorAll("[data-step-card]")];
    // Every item icon (`data-node`) with where it is, and its twin in the copy.
    const twin_icons = [...copy.querySelectorAll("[data-node]")];
    const all_icons = real(scroller, "[data-node]");
    const slot_list = all_icons.map((el, i) => {
        const rect = rel(el);
        const shown = rect.width >= 1 && rect.height >= 1;
        return { id: el.dataset.node, index: i, rect, shown, point: shown ? null : hostPoint(el, base), twin: twin_icons[i] };
    });
    // The tooltips and step badges (`data-fly`) the same way: where each is (`shown`: not hidden), and its twin in the copy.
    const twin_fly = [...copy.querySelectorAll("[data-fly]")];
    const fly_list = real(scroller, "[data-fly]").map((el, i) => {
        const rect = rel(el);
        const shown = rect.width >= 1 && rect.height >= 1;
        return { id: el.dataset.fly, rect, shown, point: shown ? null : hostPoint(el, base), twin: twin_fly[i] };
    });
    // Compact Tree's captions (the one-line text beside each icon), each with the icon it sits beside.
    const twin_captions = [...copy.querySelectorAll(".tree-caption")];
    const caption_list = real(scroller, ".tree-caption").map((el, i) => ({
        rect: rel(el), twin: twin_captions[i], icon: all_icons.indexOf(el.parentElement.querySelector("[data-node]"))
    })).filter(caption => caption.rect.width >= 1 && caption.rect.height >= 1);
    const items = new Map();
    real(scroller, "[data-step-card]").forEach((box, index) => {
        const outline = rel(box);
        if (outline.width < 1 || outline.height < 1) return; // folded away
        const slots = new Map();
        for (const [role, slot] of stepSlots(box)) {
            const where = rel(slot);
            if (where.width >= 1) slots.set(role, where);
        }
        const twin = twins[index];
        // The frame draws the box while it travels; the copy keeps only what was inside.
        Object.assign(twin.style, { background: "transparent", borderColor: "transparent", boxShadow: "none" });
        // The parts that travel (the head, the node...) are hidden in the copy; one with nothing to travel to is shown again by morphStep and goes with the copy.
        const twin_bits = stepSlots(twin);
        for (const bit of twin_bits.values()) bit.style.visibility = "hidden";
        // The anvil panel (the embossed rectangle under the slots) is a shape of its own, so it morphs between Steps and Slots.
        const row = box.querySelector(":scope > .anvil-row");
        const panel = row ? rel(row) : null;
        const twin_row = twin.querySelector(":scope > .anvil-row");
        if (twin_row) Object.assign(twin_row.style, { background: "transparent", borderColor: "transparent", outlineColor: "transparent" });
        // What the panel holds that only this view has (the slot labels, the tooltips, the prior-work line), as the copy's parts with where they were.
        const held = ".anvil-row .cell-label, .anvil-row .mc-tooltip, .anvil-row .cell-meta";
        const twin_held = [...twin.querySelectorAll(held)];
        const kept = [...held_copy.querySelectorAll(held)];
        const all_held = real(scroller, held);
        const parts = [...box.querySelectorAll(held)].map((part, i) => ({ el: kept[all_held.indexOf(part)], rect: rel(part), under: twin_held[i], icon: all_icons.indexOf((part.closest(".anvil-cell") || document.body).querySelector("[data-node]")) })).filter(part => part.rect.width >= 1 && part.rect.height >= 1);
        for (const part of parts) { part.under.style.visibility = "hidden"; part.el.style.visibility = "visible"; }
        items.set(box.dataset.stepCard, { ...outline, parts, twin_bits, restoreRow: () => { if (twin_row) Object.assign(twin_row.style, { background: "", borderColor: "", outlineColor: "" }); }, classes: (scroller.querySelector(".rounds.timeline") || {}).className || "", chrome: chromeOf(getComputedStyle(box)), slots, twin, panel: panel && panel.width >= 1 ? { ...panel, chrome: chromeOf(getComputedStyle(row)) } : null });
    });
    for (const part of [...copy.querySelectorAll("[data-step], [data-step-card], [data-entry-link], [data-view]"), ...held_copy.querySelectorAll("[data-step], [data-step-card], [data-entry-link], [data-view]")]) {
        for (const name of ["data-step", "data-step-card", "data-entry-link", "data-view"]) part.removeAttribute(name);
    }
    for (const tip of copy.querySelectorAll(".info-tip")) tip.classList.remove("floating");
    const shared = real(scroller, ".round-label").map(rel); // the parts both timeline views have, in order
    return { copy, held_copy, slot_list, fly_list, caption_list, rect: base, top: scroller.scrollTop, client: [scroller.clientWidth, scroller.clientHeight], padding: getComputedStyle(scroller).padding, items, shared, timeline: Boolean(scroller.querySelector(".rounds.timeline")) };
}

// One step's box, from where it was (`was`) to where it is (`now`), both relative to the scroller's visible box.
// `same`: between Steps and Slots (the old copy is under the panels, and each part of it goes by itself); else the old copy lies over everything and fades.
function morphStep(box, was, now, origin, timing, same, follow, layer) {
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    // The box (and the anvil panel's) is a frame in the overlay layer, not in the card: the card's transform and clip make a layer of their own, and
    // the old copy has to sit between the frames (layers -3 and -1) to be covered by the panel and not the card. Positions are in the scroller's visible box.
    const scroller = box.closest(".steps-scroll");
    const frameOf = z => { const el = h("div", { class: "card-frame view-overlay", "aria-hidden": "true" }); el.style.cssText = `z-index: ${z}; left: 0; top: 0; width: 0; height: 0`; layer.append(el); return el; };
    const frame = frameOf("-3");
    const looks = (rect, chrome) => ({
        left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px",
        backgroundColor: chrome.background, borderColor: chrome.border, borderRadius: chrome.radius, borderWidth: chrome.width + "px"
    });
    // The slots that were in the old step glide and scale to their new places (about their own corner), and never fade.
    const moving = new Map();
    const matched = new Set();
    for (const [role, slot] of stepSlots(box)) {
        const before = was.slots.get(role);
        if (!before) continue;
        const after = slot.getBoundingClientRect();
        matched.add(role);
        moving.set(slot, { before, left: after.left - origin.left, top: after.top - origin.top });
        slot.style.zIndex = slot.matches(".arrow-glyph") ? "3" : "2"; // (the arrow over the cost circling it)
    }
    for (const [role, bit] of was.twin_bits) if (!matched.has(role)) bit.style.visibility = "";
    const row = box.querySelector(":scope > .anvil-row");
    const panel_rect = row && was.panel ? row.getBoundingClientRect() : null;
    const now_panel = panel_rect && panel_rect.width >= 1
        ? { left: panel_rect.left - origin.left, top: panel_rect.top - origin.top, width: panel_rect.width, height: panel_rect.height, chrome: chromeOf(getComputedStyle(row)) } : null;
    // What the new view adds beside the panel (In words, the one-line caption) is drawn above the frames (the card is a layer of its own), so it is clipped
    // to the part the panel has left uncovered, a clip that follows the panel's edge facing it; the panel seems to uncover it.
    // What only the new view has inside the panel (tooltips, slot labels, the prior-work line) appears as the panel grows, the reverse of what the old view's
    // lose: shown only where the panel has got to, and fading in.
    const arrivals = [];
    if (same && now_panel && was.panel) {
        for (const el of box.querySelectorAll(".anvil-row .cell-label, .anvil-row .mc-tooltip, .anvil-row .cell-meta")) {
            const r = el.getBoundingClientRect();
            const icon = (el.closest(".anvil-cell") || document.body).querySelector("[data-node]");
            // (A part goes with its item's icon: it starts where the icon starts, shifted by the icon's own journey.)
            if (r.width >= 1 && r.height >= 1) arrivals.push({ el, follows: follow.new.get(icon) || { dx: 0, dy: 0 }, rect: { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height } });
        }
    }
    const reveals = [];
    if (same && now_panel) {
        for (const el of box.querySelectorAll(":scope > .step-caption, :scope > .step-words")) {
            const r = el.getBoundingClientRect();
            if (r.width >= 1 && r.height >= 1) reveals.push({ el, top: r.top - origin.top, height: r.height });
        }
    }
    box.classList.add("morphing");
    // Laid out at its new size and uncovered as the box grows (clipped to it, like the frame). The clip leaves room on
    // the left and above for the rail's node and the badge, which sit outside the box.
    const cut = size => `inset(-14px ${now.width - size.width}px ${now.height - size.height}px -40px)`;
    const animations = [
        box.animate([{ transform: `translate(${dx}px, ${dy}px)`, clipPath: cut(was) }, { transform: "none", clipPath: cut(now) }], timing),
        frame.animate([looks(was, was.chrome), looks(now, now.chrome)], { ...timing, fill: "forwards" })
    ];
    for (const [slot, here] of moving) {
        const move = `translate(${here.before.left - here.left - dx}px, ${here.before.top - here.top - dy}px)`;
        animations.push(slot.animate([{ transform: move }, { transform: "none" }], timing));
    }
    // The arrow points at the result's icon all the way (right in Compact, down in a narrow Steps card): each frame it turns toward where that icon
    // is (its flyer while it travels). Its glide replaces its CSS turn meanwhile, so the angle is from the plain "→".
    const arrow = box.querySelector(".arrow-glyph");
    // The result's icon travels on an arc about the arrow (a circle whose centre is the arrow, wherever the arrow is on its own glide): its distance and
    // angle from the arrow ease from the old ones to the new, and the arrow turns with the angle, so it always points at the icon.
    const fly = arrow && moving.has(arrow) ? layer.querySelector(`[data-fly-result="${CSS.escape(box.dataset.stepCard)}"]`) : null;
    const clock = fly && fly.arc && fly.getAnimations()[0];
    if (clock) {
        const here = moving.get(arrow), size = arrow.getBoundingClientRect();
        const centre = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        // The arrow's centre before and after, in the layer's coordinates (its box keeps its size: it only glides).
        const a0 = { x: here.before.left + size.width / 2, y: here.before.top + size.height / 2 }, a1 = { x: here.left + size.width / 2, y: here.top + size.height / 2 };
        const i0 = centre(fly.arc.from), i1 = centre(fly.arc.to);
        const r0 = Math.hypot(i0.x - a0.x, i0.y - a0.y), r1 = Math.hypot(i1.x - a1.x, i1.y - a1.y);
        const t0 = Math.atan2(i0.y - a0.y, i0.x - a0.x);
        let turn = Math.atan2(i1.y - a1.y, i1.x - a1.x) - t0;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // the short way round
        const natural = fly.arc.to;
        const riders = [
            ...box.querySelectorAll(".anvil-cell.result .cell-label, .anvil-cell.result .mc-tooltip, .anvil-cell.result .cell-meta"),
            ...(was.parts || []).filter(part => part.icon === fly.arc.index && part.el).map(part => part.el)
        ];
        clock.effect.setKeyframes([{ opacity: 1 }, { opacity: 1 }]); // (only its clock is kept: the place is set below, frame by frame)
        // The result's label, tooltip and prior-work line pass over the cost as its icon does (the icon flies above the page): drawn over it too.
        for (const part of riders) { if (getComputedStyle(part).position === "static") part.style.position = "relative"; part.style.zIndex = "3"; }
        // The arrow's own glide is set here too, on the same line (its glide was not where the arc's centre is reckoned).
        for (const glide of arrow.getAnimations()) glide.effect.setKeyframes([{ opacity: 1 }, { opacity: 1 }]);
        // The cost goes in a straight line from its old place to its new one, eased like the rest of the switch (in step with the arrow and the icons).
        const cost = box.querySelector(".anvil-row .anvil-cost");
        const orbit = cost && moving.has(cost) ? (() => {
            const there = moving.get(cost), c = cost.getBoundingClientRect();
            const c0 = { x: there.before.left + there.before.width / 2, y: there.before.top + there.before.height / 2 }, c1 = { x: there.left + c.width / 2, y: there.top + c.height / 2 };
            for (const glide of cost.getAnimations()) glide.effect.setKeyframes([{ opacity: 1 }, { opacity: 1 }]);
            return { c0, c1 };
        })() : null;
        arrow.style.transform = "none"; // (the narrow card's own quarter turn waits for the end: meanwhile `rotate` alone turns the plain "→")
        fly.style.transformOrigin = "0 0";
        let frame_id = 0;
        const place = () => {
            const p = clock.effect.getComputedTiming().progress ?? 1; // eased, as the arrow's glide is
            const ax = a0.x + (a1.x - a0.x) * p, ay = a0.y + (a1.y - a0.y) * p;
            const angle = t0 + turn * p, r = r0 + (r1 - r0) * p;
            const w = fly.arc.from.width + (natural.width - fly.arc.from.width) * p, h = fly.arc.from.height + (natural.height - fly.arc.from.height) * p;
            const x = ax + r * Math.cos(angle) - w / 2, y = ay + r * Math.sin(angle) - h / 2;
            fly.style.transform = `translate(${x - natural.left}px, ${y - natural.top}px) scale(${w / natural.width}, ${h / natural.height})`;
            // Its label, tooltip and prior-work line (the new view's, and the old copy's) follow the icon's straight path on their own: they are
            // shifted by how far the arc is from that path, so they keep their place beside the icon.
            const lx = fly.arc.from.left + (natural.left - fly.arc.from.left) * p, ly = fly.arc.from.top + (natural.top - fly.arc.from.top) * p;
            const shift = `${x - lx}px ${y - ly}px`;
            for (const part of riders) part.style.translate = shift;
            // ...and, since their own clips moved with them, each is cut here to where the panel's inside is now (eased as the panel's frame is).
            if (was.panel && now_panel) {
                const bw = now_panel.chrome ? now_panel.chrome.width : 0;
                const lerp = key => was.panel[key] + (now_panel[key] - was.panel[key]) * p;
                const inside = { left: origin.left + lerp("left") + bw, top: origin.top + lerp("top") + bw, right: origin.left + lerp("left") + lerp("width") - bw, bottom: origin.top + lerp("top") + lerp("height") - bw };
                for (const part of riders) {
                    for (const own of part.getAnimations()) if (own.effect.getKeyframes().some(key => key.clipPath)) own.effect.setKeyframes([{}, {}]);
                    const r = part.getBoundingClientRect();
                    part.style.clipPath = `inset(${inside.top - r.top}px ${r.right - inside.right}px ${r.bottom - inside.bottom}px ${inside.left - r.left}px)`;
                }
            }
            // The arrow: from where its box is now (the card's own glide moves it), to the point on its line.
            arrow.style.translate = "";
            const at = arrow.getBoundingClientRect();
            arrow.style.translate = `${ax - (at.left + at.width / 2 - origin.left)}px ${ay - (at.top + at.height / 2 - origin.top)}px`;
            arrow.style.rotate = angle + "rad";
            if (orbit) {
                const target = { x: orbit.c0.x + (orbit.c1.x - orbit.c0.x) * p, y: orbit.c0.y + (orbit.c1.y - orbit.c0.y) * p };
                cost.style.translate = "0px 0px"; // (measured with no shift at all: the wide card's CSS centres it with a translate of its own)
                const now = cost.getBoundingClientRect();
                cost.style.translate = `${target.x - (now.left + now.width / 2 - origin.left)}px ${target.y - (now.top + now.height / 2 - origin.top)}px`;
            }
        };
        // (It ends with the morph: once its clock has run out or its icon is gone, the arrow is left as the page draws it.)
        const tick = () => {
            if (!fly.isConnected || !arrow.isConnected || clock.playState === "finished" || clock.playState === "idle") { done(); return; }
            place();
            frame_id = requestAnimationFrame(tick);
        };
        const done = () => { cancelAnimationFrame(frame_id); arrow.style.rotate = arrow.style.translate = arrow.style.transform = ""; if (orbit) cost.style.translate = ""; for (const part of riders) part.style.translate = part.style.clipPath = part.style.zIndex = part.style.position = ""; arc_stops.delete(done); };
        arc_stops.add(done);
        tick();
        Promise.allSettled([clock.finished, ...animations.map(animation => animation.finished)]).then(done);
    }
    // (Clipped to the panel's inside, within its embossed border, not its outer edge.)
    const inner = panel => { const w = panel.chrome ? panel.chrome.width : 0; return { left: panel.left + w, top: panel.top + w, width: panel.width - 2 * w, height: panel.height - 2 * w }; };
    const insetAround = (outer, r) => { const panel = inner(outer); return `inset(${panel.top - r.top}px ${r.left + r.width - panel.left - panel.width}px ${r.top + r.height - panel.top - panel.height}px ${panel.left - r.left}px)`; };
    for (const { el, rect, follows } of arrivals) {
        // (At the start the card is still at its old place, so the part is too: shifted by the card's move, and by the icon's.)
        const start = { ...rect, left: rect.left + dx + follows.dx, top: rect.top + dy + follows.dy };
        animations.push(el.animate([{ clipPath: insetAround(was.panel, start) }, { clipPath: insetAround(now_panel, rect) }], timing));
        animations.push(el.animate([{ transform: `translate(${follows.dx}px, ${follows.dy}px)` }, { transform: "none" }], timing));
        animations.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, easing: "ease-out" }));
    }
    for (const { el, top, height } of reveals) {
        const below = top >= now_panel.top + now_panel.height / 2;
        const edge = panel => below ? panel.top + panel.height : panel.top;
        // (Not clamped to the text's box: a clip that passes its far edge keeps going, so the reveal follows the panel's edge all the way.)
        const clip = at => below ? `inset(${at}px 0 0 0)` : `inset(0 0 ${height - at}px 0)`;
        animations.push(el.animate([{ clipPath: clip(edge(was.panel) - (top + dy)) }, { clipPath: clip(edge(now_panel) - top) }], timing));
    }
    // Between Steps and Slots the old copy (morphView) is whole and under the panel: what the panel will not cover fades at once; the text it will
    // cover (In words, the one-line caption) stays until it has, and fades at the end if some is left.
    if (!now_panel) was.restoreRow(); // an anvil panel with no new one to become goes with the rest of the old card (fading in the copy)
    if (same) {
        // What only the old view has inside the panel is not faded: it is shown only where the panel still is, so it goes as the panel shrinks past it.
        if (!now_panel) for (const { el } of was.parts) animations.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: timing.duration * 0.35, easing: "ease-out", fill: "forwards" }));
        if (now_panel) {
            const inset = insetAround;
            for (const { el, rect, icon } of was.parts) {
                // Each goes with its item's icon (the clip goes with it), and is cut by the panel's edges as the panel shrinks past it.
                const follows = follow.old.get(icon) || { dx: 0, dy: 0 };
                const end = { ...rect, left: rect.left + follows.dx, top: rect.top + follows.dy };
                animations.push(el.animate([{ transform: "none" }, { transform: `translate(${follows.dx}px, ${follows.dy}px)` }], { ...timing, fill: "forwards" }));
                animations.push(el.animate([{ clipPath: inset(was.panel, rect) }, { clipPath: inset(now_panel, end) }], { ...timing, fill: "forwards" }));
                // ...and they fade as they go, slowly at first so they are whole while the panel still holds them.
                animations.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: timing.duration, easing: "ease-in", fill: "forwards" }));
            }
        }
        for (const part of was.twin.children) {
            if (now_panel && part.matches(".anvil-row")) continue;
            const late = now_panel && part.matches(".step-words, .step-caption");
            animations.push(late
                ? part.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: timing.duration, easing: "linear", fill: "forwards" })
                : part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: timing.duration * 0.35, easing: "ease-out", fill: "forwards" }));
        }
    }
    // The anvil panel grows, shrinks and moves to its new place as a frame of its own (the row itself is drawn clear meanwhile).
    let panel_frame = null;
    if (now_panel) {
        panel_frame = frameOf("-1");
        // The current step's ring (an outline on the panel) is drawn by the frame, so it grows with it instead of standing at the new size from the start.
        const ring = getComputedStyle(row);
        if (ring.outlineStyle !== "none" && parseFloat(ring.outlineWidth) > 0) Object.assign(panel_frame.style, { outline: `${ring.outlineWidth} ${ring.outlineStyle} ${ring.outlineColor}`, outlineOffset: ring.outlineOffset });
        row.classList.add("morphing");
        animations.push(panel_frame.animate([looks(was.panel, was.panel.chrome), looks(now_panel, now_panel.chrome)], { ...timing, fill: "forwards" }));
    }
    // The old contents (the copy) stay exactly where they were while they fade out.
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        frame.remove();
        box.classList.remove("morphing");
        if (panel_frame) { panel_frame.remove(); row.classList.remove("morphing"); }
        for (const slot of moving.keys()) slot.style.zIndex = "";
    };
    Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    setTimeout(finish, timing.duration + 150);
    return finish;
}

// Called after the redraw with what viewSnapshot took. `container` holds the copy (position: relative).
export function morphView(scroller, container, old) {
    if (!motionOk()) return;
    const { copy, rect, top, items } = old;
    // Steps and Slots share the rail, the round labels, the cards and the finished item: those stay as they are (no fading out and in);
    // only what one view has and the other lacks fades.
    const same = old.timeline && Boolean(scroller.querySelector(".rounds.timeline"));
    // The steps scroll with the page (they have no scroll bar of their own): while the height eases below, what overflows is clipped, never given a bar
    // (one that came and went narrowed and widened every card).
    scroller.style.overflowY = "hidden";
    // The scroller is made the container of everything laid over it before anything is: an absolute child of a scroller that is not positioned belongs
    // to something above it, and a flyer put there can lengthen the page and bring a scroll bar, narrowing everything by its width while the rest is measured.
    scroller.classList.add("morphing-view");
    const timing = { duration: MORPH_MS, easing: MORPH_EASING };
    if (same) {
        for (const part of copy.querySelectorAll(".round-label, .current-bar")) part.style.visibility = "hidden";
        copy.querySelector(".rounds.timeline").classList.add("no-rail");
    }
    growSmoothly(scroller, rect.height, timing); // first, so the boxes below are measured in the layout they are animated in
    const origin = scroller.getBoundingClientRect();
    const finishers = [];
    // One layer holds every flyer (and nothing else is put among the page's own parts).
    const layer = h("div", { class: "view-overlay", "aria-hidden": "true" });
    // (The layer is the scroller's visible box, clipped, and positions in it are the scroller's own, a `rect` relative to its box: it is as big as the scroller, so a clone
    // laid in it takes the percentages and max-widths of a real container, and what is laid in it can never add to the scroller's length or width or to the page's, so putting
    // the overlay up changes nothing the rest of the switch measures.)
    // (Its size is a percentage of the scroller's, not a number taken now: the scroller's height eases during the switch, and a layer fixed at the height it had when the
    // overlay went up would cut off, for the whole flight, everything below that: the tooltips at the bottom of a taller tree.)
    layer.style.cssText = `position: absolute; left: 0; top: ${scroller.scrollTop}px; width: 100%; height: 100%; overflow: hidden; pointer-events: none`;
    scroller.append(layer);
    const follow = { old: new Map(), new: new Map() }; // how far each icon travels, by the old icon's index and by the new icon: what sits beside it goes with it
    // Each item icon flies from where it was to where it is, in a layer above everything: a clone of the new icon, so it is never faded, only moved
    // (and scaled to the new icon's size). An item shown twice in one view (an input made by an earlier step) flies from both places to its one place
    // (and back); the real icons wait, hidden, and the old ones in the copy are hidden, until they land.
    {
        const news = real(scroller, "[data-node]").map(el => {
            const r = el.getBoundingClientRect();
            const rect = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
            const shown = rect.width >= 1 && rect.height >= 1;
            return { el, id: el.dataset.node, rect, shown, point: shown ? null : hostPoint(el, origin) };
        });
        const group = list => { const by = new Map(); for (const icon of list) by.set(icon.id, [...(by.get(icon.id) || []), icon]); return by; };
        const olds_by = group(old.slot_list);
        const flyers = [];
        const hidden = new Set();
        const animations = [];
        const centre = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        for (const [id, here] of group(news)) {
            const olds = olds_by.get(id);
            if (!olds) continue;
            const pairs = here.map((n, k) => [olds[Math.min(k, olds.length - 1)], n]);
            for (let k = here.length; k < olds.length; k++) pairs.push([olds[k], here[0]]);
            for (const [o, n] of pairs) {
                // An icon a view hides (inside a folded step) goes into, or comes out of, the card that holds it, small, and is not faded: it only moves.
                if (!o.shown && !n.shown) continue;
                if (o.shown && !n.shown && !n.point) continue;
                if (!o.shown && n.shown && !o.point) continue;
                const natural = n.shown ? n.rect : o.rect;
                const fly = n.el.cloneNode(true);
                fly.removeAttribute("data-node");
                // (A step's result icon: what its arrow aims at while it travels, morphStep. The same item is also the next step's input, so by step.)
                if (n.el.closest(".anvil-cell.result")) fly.dataset.flyResult = n.el.closest("[data-step-card]")?.dataset.stepCard || "";
                fly.setAttribute("aria-hidden", "true");
                Object.assign(fly.style, {
                    position: "absolute", left: natural.left + "px", top: natural.top + "px", width: natural.width + "px", height: natural.height + "px",
                    margin: "0", zIndex: "3", pointerEvents: "none", visibility: "visible", transformOrigin: o.shown && n.shown ? "0 0" : "50% 50%",
                    maxWidth: "none", maxHeight: "none", minWidth: "0", minHeight: "0", flex: "none"
                });
                layer.append(fly);
                flyers.push(fly);
                if (o.shown && n.shown) {
                    animations.push(fly.animate([{ transform: `translate(${o.rect.left - n.rect.left}px, ${o.rect.top - n.rect.top}px) scale(${o.rect.width / n.rect.width}, ${o.rect.height / n.rect.height})` }, { transform: "none" }], timing));
                    fly.arc = { from: o.rect, to: n.rect, index: o.index }; // (a step's result icon may instead circle its arrow: morphStep)
                    follow.old.set(o.index, { dx: n.rect.left - o.rect.left, dy: n.rect.top - o.rect.top });
                    follow.new.set(n.el, { dx: o.rect.left - n.rect.left, dy: o.rect.top - n.rect.top });
                } else if (o.shown) {
                    const c = centre(o.rect);
                    animations.push(fly.animate([{ transform: "none" }, { transform: `translate(${n.point.left - c.x}px, ${n.point.top - c.y}px) scale(0.3)` }], { ...timing, fill: "forwards" }));
                    follow.old.set(o.index, { dx: n.point.left - c.x, dy: n.point.top - c.y });
                } else {
                    const c = centre(n.rect);
                    animations.push(fly.animate([{ transform: `translate(${o.point.left - c.x}px, ${o.point.top - c.y}px) scale(0.3)` }, { transform: "none" }], timing));
                    follow.new.set(n.el, { dx: o.point.left - c.x, dy: o.point.top - c.y });
                }
                if (o.shown && o.twin) o.twin.style.visibility = "hidden";
                if (n.shown) hidden.add(n.el);
            }
        }
        // Between the Tree and the other views the tooltips and step badges travel too: each box goes from its old place and size to its new one while the
        // text in it stays as it is (the old text over the new, the old fading, so nothing dips), a tooltip a view hides (Slots) grows out of its icon or is
        // taken into it, and a badge becomes the step's tick label and back. (Between Steps and Slots the panel clips them, above.)
        if (!same) {
            const strip = el => {
                const clone = inertCopy(el);
                for (const node of [clone, ...clone.querySelectorAll("*")]) for (const name of ["data-step", "data-step-card", "data-entry-link", "data-view", "data-node", "data-fly"]) node.removeAttribute(name);
                return clone;
            };
            const place = (clone, rect) => {
                Object.assign(clone.style, {
                    position: "absolute", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px",
                    boxSizing: "border-box", margin: "0", zIndex: "2", pointerEvents: "none", visibility: "visible", overflow: "hidden",
                    // Its size is the one given, whatever its container: no limit of the page's own layout (a max-width, a flex share) is left on a clone.
                    maxWidth: "none", maxHeight: "none", minWidth: "0", minHeight: "0", flex: "none"
                });
                layer.append(clone);
                flyers.push(clone);
            };
            const icons_new = group(news.filter(icon => icon.shown));
            const icons_old = group(old.slot_list.filter(icon => icon.shown));
            // A tooltip a view hides collapses to its icon, or, if that is hidden too (a folded step), to the card that holds it.
            const collapsed = (entry, icons, id, k) => {
                const list = id.startsWith("step:") ? null : icons.get(id.split(":")[1]);
                if (list) {
                    const rect = list[Math.min(k, list.length - 1)].rect;
                    return { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2, width: 0, height: 0 };
                }
                return entry.point ? { left: entry.point.left, top: entry.point.top, width: 0, height: 0 } : null;
            };
            const boxes_new = real(scroller, "[data-fly]").map(el => {
                const r = el.getBoundingClientRect();
                const rect = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
                const shown = rect.width >= 1 && rect.height >= 1;
                return { el, id: el.dataset.fly, rect, shown, point: shown ? null : hostPoint(el, origin) };
            });
            const boxes_old = group(old.fly_list);
            for (const [key, here] of group(boxes_new)) {
                const olds = boxes_old.get(key);
                if (!olds) continue;
                const pairs = here.map((n, k) => [olds[Math.min(k, olds.length - 1)], n, k]);
                for (let k = here.length; k < olds.length; k++) pairs.push([olds[k], here[0], 0]);
                for (const [o, n, k] of pairs) {
                    if (!o.shown && !n.shown) continue;
                    const from = o.shown ? o.rect : collapsed(o, icons_old, key, k);
                    const to = n.shown ? n.rect : collapsed(n, icons_new, key, k);
                    if (!from || !to) continue;
                    if (n.shown) {
                        const fly = strip(n.el);
                        place(fly, to);
                        animations.push(fly.animate([
                            { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, clipPath: `inset(0 ${to.width - from.width}px ${to.height - from.height}px 0)` },
                            { transform: "none", clipPath: "inset(0 0 0 0)" }], timing));
                        hidden.add(n.el);
                    }
                    if (o.shown && o.twin) {
                        const gone = strip(o.twin);
                        place(gone, from);
                        animations.push(gone.animate([
                            { transform: "none", clipPath: "inset(0 0 0 0)" },
                            { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px)`, clipPath: `inset(0 ${from.width - to.width}px ${from.height - to.height}px 0)` }], { ...timing, fill: "forwards" }));
                        animations.push(fadeOutCover(gone, timing.duration));
                        o.twin.style.visibility = "hidden";
                    }
                }
            }
            // Compact Tree's captions (the text beside each icon) follow their icon: an old one travels with it as far as the icon goes, and fades; a new
            // one starts where its icon starts and fades in.
            // (A caption is only drawn inside the compact Tree, by a rule of the tree's, so its clone, laid in the overlay, gets that look itself.)
            const captionLook = clone => Object.assign(clone.style, { display: "block", fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap", textOverflow: "ellipsis" });
            for (const caption of old.caption_list) {
                const moved = follow.old.get(caption.icon);
                if (!moved || !caption.twin) continue;
                const gone = strip(caption.twin);
                captionLook(gone);
                place(gone, caption.rect);
                animations.push(gone.animate([{ transform: "none" }, { transform: `translate(${moved.dx}px, ${moved.dy}px)` }], { ...timing, fill: "forwards" }));
                animations.push(fadeOutCover(gone, timing.duration));
                caption.twin.style.visibility = "hidden";
            }
            for (const el of real(scroller, ".tree-caption")) {
                const r = el.getBoundingClientRect();
                const rect = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
                const moved = follow.new.get(el.parentElement.querySelector("[data-node]"));
                if (!moved || rect.width < 1 || rect.height < 1) continue;
                const fly = strip(el);
                captionLook(fly);
                place(fly, rect);
                animations.push(fly.animate([{ transform: `translate(${moved.dx}px, ${moved.dy}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { ...timing, easing: "ease-out" }));
                hidden.add(el);
            }
        }
        for (const el of hidden) el.style.visibility = "hidden";
        let landed = false;
        const land = () => {
            if (landed) return;
            landed = true;
            layer.remove();
            for (const el of hidden) el.style.visibility = "";
        };
        finishers.push(land);
        Promise.allSettled(animations.map(animation => animation.finished)).then(land);
        setTimeout(land, MORPH_MS + 150);
    }
    for (const box of real(scroller, "[data-step-card]")) {
        const r = box.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const was = items.get(box.dataset.stepCard);
        if (was) finishers.push(morphStep(box, was, { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height, chrome: chromeOf(getComputedStyle(box)) }, origin, timing, same, follow, layer));
    }
    // Nothing new is faded in over the old copy (see COVER_FADE): the rail, the labels and the tree's branches and starting items are simply there under it.
    const labels = real(scroller, ".round-label");
    // Between Steps and Slots the round labels and the finished item move to their new places (the old copy's are hidden).
    if (same) labels.forEach((label, index) => {
        const was = old.shared[index];
        const now = label.getBoundingClientRect();
        if (!was || Math.abs(was.top - (now.top - origin.top)) < 1 && Math.abs(was.left - (now.left - origin.left)) < 1) return;
        label.animate([{ transform: `translate(${was.left - (now.left - origin.left)}px, ${was.top - (now.top - origin.top)}px)` }, { transform: "none" }], timing);
    });
    // The old view's copy goes inside the scroller. Between Steps and Slots it is on the layer between the cards' boxes (-3) and the anvil panels (-1), so a
    // panel covers the old text it passes over, and it lays out as the old view did (the old width, bar excluded); between other views it is above
    // the new view and fades out.
    Object.assign(copy.style, {
        position: "absolute", top: scroller.scrollTop + "px", left: "0", width: old.client[0] + "px", height: old.client[1] + "px",
        // (The scroller's own padding comes from a rule for a direct child of the results box, so the copy, inside it, is given it.)
        boxSizing: "border-box", padding: old.padding, overflow: "hidden", margin: "0", pointerEvents: "none", zIndex: same ? "-2" : "2"
    });
    scroller.append(copy);
    copy.scrollTop = top;
    // Between Steps and Slots the second copy goes first in the scroller, above the panels' frames and under the cards' own contents.
    if (same) {
        Object.assign(old.held_copy.style, { position: "absolute", top: scroller.scrollTop + "px", left: "0", width: old.client[0] + "px", height: old.client[1] + "px", boxSizing: "border-box", padding: old.padding, overflow: "hidden", margin: "0", pointerEvents: "none" });
        scroller.prepend(old.held_copy);
        old.held_copy.scrollTop = top;
    }
    // (Between Steps and Slots each part of the copy fades by itself, in morphStep, and the copy goes at the end.)
    afterAnimation(same
        ? copy.animate([{ opacity: 1 }, { opacity: 1 }], { duration: MORPH_MS, fill: "forwards" })
        : fadeOutCover(copy, MORPH_MS), () => { copy.remove(); old.held_copy.remove(); }, MORPH_MS + 600);
    const end = () => {
        for (const animation of scroller.getAnimations({ subtree: true })) if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.cancel();
        for (const finish of finishers) finish();
        copy.remove();
        old.held_copy.remove();
        layer.remove();
        scroller.classList.remove("morphing-view", "resizing");
        scroller.style.height = "";
        scroller.style.overflowY = "";
    };
    settling = end;
    setTimeout(() => { scroller.classList.remove("morphing-view"); scroller.style.overflowY = ""; if (settling === end) settling = null; }, MORPH_MS + 300);
}

