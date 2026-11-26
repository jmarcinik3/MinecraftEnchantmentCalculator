// Small DOM and storage helpers used everywhere: h(), $, icon, guarded localStorage, the copy button, motion check.
import { TEXT } from "./Text.js";

export const COPIED_MS = 1500; // how long "Copied" shows on a copy button

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
        if (GLINTS.has(animation.animationName) && animation.startTime !== 0) animation.startTime = 0;
    }
}

export function keepGlintsInStep() {
    let queued = false;
    // Before the next paint, so a rebuilt slot never shows a frame of its sheen from the start.
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; syncGlints(); });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] }); // a section opening starts its glints too
    syncGlints();
}
