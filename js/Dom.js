// Small DOM and storage helpers used everywhere: h(), $, icon, guarded localStorage, the copy button, motion check.
import { TEXT } from "./Text.js";

const COPIED_MS = 1500; // how long "Copied" shows on a copy button

export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : String(child));
    }
    return el;
}

// An SVG element (`h` for the SVG namespace).
export function svg(tag, attrs = {}, ...children) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) if (child != null) el.append(child);
    return el;
}

// The class of a tooltip's name line (`mc-name`, coloured by `rarity`: "common", "uncommon"...), and a tooltip line with an
// enchantment's text (`extra`: more classes with a leading space, e.g. " changed").
export const nameClass = (rarity, extra = "") => "mc-name rarity-" + rarity + extra;
export const enchLine = (text, curse, extra = "") => h("div", { class: "mc-ench" + (curse ? " curse" : "") + extra }, text);

// Text for searching: trimmed, lower case, without accents.
export const plain = text => text.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Restarts the "flash" highlight on `el`.
export function flash(el) {
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
}

// Scrolls `el` into view (smoothly unless animations are off).
export function scrollToView(el, block = "nearest") {
    el.scrollIntoView({ block, behavior: motionOk() ? "smooth" : "auto" });
}

export const $ = selector => document.querySelector(selector);

export function icon(item_ns, small = false) {
    return h("img", {
        class: "item-icon" + (small ? " small" : ""),
        src: `img/${item_ns}.svg`,
        alt: "",
        draggable: "false", // so a drag that starts on it is ours, not the browser's picture drag
        "aria-hidden": "true"
    });
}

// A group of toggle buttons where one is `selected` (a highlight pill slides between them: Motion.js pillRects). `options`:
// [{ selected, content, onclick, attrs }].
export function segmented(extra_class, label, options) {
    return h("div", { class: "segmented" + (extra_class ? " " + extra_class : ""), role: "group", "aria-label": label },
        options.map(option => h("button", {
            type: "button", class: option.selected ? "selected" : "", "aria-pressed": String(Boolean(option.selected)), onclick: option.onclick, ...option.attrs
        }, option.content)));
}

// Something open (a menu, popover or tip) closes on a click outside it and on Escape. `open()`: whether anything is open;
// `inside(event)`: whether a click belongs to it (it stays open); `close(event)` closes it (`event` is the click, or undefined for
// Escape); `escape()` can differ (to put the focus back).
export function closeOnOutside({ open, inside = () => false, close, escape = close }) {
    document.addEventListener("click", event => { if (open() && !inside(event)) close(event); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && open()) escape(); });
}

// Runs `fn` once when `animation` finishes or is cancelled; with `fallback_ms`, also after that long (a hidden tab never finishes animations).
export function afterAnimation(animation, fn, fallback_ms) {
    let done = false;
    const once = () => { if (!done) { done = true; fn(); } };
    animation.finished.then(once, once);
    if (fallback_ms != null) setTimeout(once, fallback_ms);
}

// Storage can be unavailable (private windows, blocked site data), so every access is
// guarded and falls back to `fallback`.
export function readStorage(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value == null ? fallback : value;
    } catch {
        return fallback;
    }
}

export function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // No storage: the value lasts until the page reloads.
    }
}

// Copies `text`, showing "Copied" in `target` for a moment, then `label` again.
// `button` gets the class "copied" meanwhile (an icon-only button shows its text then).
export async function copyText(target, text, label, button = target) {
    try {
        await navigator.clipboard.writeText(text);
        target.textContent = TEXT.results.copied;
    } catch {
        target.textContent = TEXT.results.copy_failed;
    }
    button.classList.add("copied");
    setTimeout(() => { target.textContent = label; button.classList.remove("copied"); }, COPIED_MS);
}

// Whether animations may run: not when the device asks for reduced motion, nor when "Show animations" (Settings) is off.
// That setting is kept in this browser; <html data-motion="off"> (also set early by index.html) turns the CSS ones off too.
const MOTION_STORAGE_KEY = "enchantment-calculator-no-motion";
let motion_ignored = readStorage(MOTION_STORAGE_KEY, false) === true;
export const motionOk = () => !motion_ignored && !matchMedia("(prefers-reduced-motion: reduce)").matches;
export const motionIgnored = () => motion_ignored;
// Glints (the enchantment sheen on slots and chosen rows) are their own setting, on by default and independent of the one above.
const GLINT_STORAGE_KEY = "enchantment-calculator-glints";
let glints_on = readStorage(GLINT_STORAGE_KEY, true) !== false;
export const glintsOn = () => glints_on;
export function setGlintsOn(on) {
    glints_on = on;
    writeStorage(GLINT_STORAGE_KEY, on);
    if (on) delete document.documentElement.dataset.glint;
    else document.documentElement.dataset.glint = "off";
}
export function setMotionIgnored(ignored) {
    motion_ignored = ignored;
    writeStorage(MOTION_STORAGE_KEY, ignored);
    if (ignored) document.documentElement.dataset.motion = "off";
    else delete document.documentElement.dataset.motion;
}

// The enchantment glints (the slots' and the rows' sheen) all run on the page's clock: every one
// starts at the animation timeline's zero, so a redraw that rebuilds a slot or a row doesn't start
// its sheen over, and slots that appear later are already in step with the others.
const GLINTS = new Set(["glint", "row-glint"]);

function syncGlints() {
    for (const animation of document.getAnimations()) {
        // (one paused off screen, `.glint-paused`, is left alone; it is put in step when it comes back)
        if (GLINTS.has(animation.animationName) && animation.playState !== "paused" && animation.startTime !== 0) animation.startTime = 0;
    }
}

// A glint that is off screen (or in a folded part of the page) pauses (CSS `.glint-paused`), so it costs nothing until it is seen again.
const glint_watch = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(entries => { for (const entry of entries) entry.target.classList.toggle("glint-paused", !entry.isIntersecting); })
    : null;
const watched_glints = new WeakSet();
function watchGlints() {
    if (!glint_watch) return;
    for (const el of document.querySelectorAll(".mc-slot.glint, .tree-slot.glint, .hotbar-slot.glint, .mini-slot.glint, .ench-row.chosen")) {
        if (watched_glints.has(el)) continue;
        watched_glints.add(el);
        glint_watch.observe(el);
    }
}

export function keepGlintsInStep() {
    let queued = false;
    // Before the next paint, so a rebuilt slot never shows a frame of its sheen from the start.
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; watchGlints(); syncGlints(); });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] }); // a section opening starts its glints too
    watchGlints();
    syncGlints();
}

// Press and drag across a row of values (the level bar, the prior-work anvils): `at(event)` is the value under the pointer, `show(value)`
// previews it while dragging, `done(start, value, moved)` makes the choice on release (a redraw mid-drag would end it), `cancel()` undoes
// the preview. `press_class` is on `el` while pressed; `prevent` stops the browser's own drag from starting.
export function scrubber(el, { at, show, done, cancel, press_class = null, prevent = false }) {
    let drag = null;
    const end = () => { drag = null; if (press_class) el.classList.remove(press_class); };
    el.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        if (prevent) event.preventDefault();
        const value = at(event);
        drag = { id: event.pointerId, start: value, value, moved: false };
        try {
            el.setPointerCapture(event.pointerId);
        } catch {
            // Some browsers refuse capture for synthetic pointers; moves over the row still work.
        }
        if (press_class) el.classList.add(press_class);
        show(value);
    });
    el.addEventListener("pointermove", event => {
        if (!drag || event.pointerId !== drag.id) return;
        const value = at(event);
        if (value !== drag.value) { drag.value = value; drag.moved = true; show(value); }
    });
    el.addEventListener("pointerup", event => {
        if (!drag || event.pointerId !== drag.id) return;
        const { start, value, moved } = drag;
        end();
        done(start, value, moved);
    });
    el.addEventListener("pointercancel", () => { end(); cancel(); });
}

// Hold-to-repeat, from a button's pointerdown `event`: `act` runs now and again every 70ms after a short wait, until the pointer is
// let go (or, with `stop_on_leave`, leaves the button); then `done` runs (if given).
export function holdRepeat(event, act, { done, stop_on_leave = false } = {}) {
    let repeat = null;
    act();
    const delay = setTimeout(() => { repeat = setInterval(act, 70); }, 400);
    const target = event.currentTarget;
    const end = () => {
        clearTimeout(delay);
        clearInterval(repeat);
        removeEventListener("pointerup", end);
        removeEventListener("pointercancel", end);
        if (stop_on_leave) target.removeEventListener("pointerleave", end);
        if (done) done();
    };
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    if (stop_on_leave) target.addEventListener("pointerleave", end);
}

// A row of controls that is one tab stop (roving tabindex): `active` (an index) is the one Tab reaches, the arrow keys in `keys`
// ({ prev, next }, lists of key names) and Home/End move the focus along the row (wrapping), and the one with focus becomes the stop.
// Returns `items`.
export function roving(items, active = 0, keys = { prev: ["ArrowLeft", "ArrowUp"], next: ["ArrowRight", "ArrowDown"] }) {
    const set = index => items.forEach((item, at) => { item.tabIndex = at === index ? 0 : -1; });
    set(Math.max(0, active));
    items.forEach((item, index) => {
        item.addEventListener("focus", () => set(index));
        item.addEventListener("keydown", event => {
            const step = keys.next.includes(event.key) ? 1 : keys.prev.includes(event.key) ? -1 : 0;
            const to = step ? (index + step + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
            if (to < 0) return;
            event.preventDefault();
            items[to].focus();
        });
    });
    return items;
}
