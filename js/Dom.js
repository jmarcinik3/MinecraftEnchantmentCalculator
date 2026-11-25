// Small DOM and storage helpers used everywhere: h(), $, icon, guarded localStorage, the copy button, motion check.
import { TEXT } from "./Text.js";
import { meta } from "./Store.js";

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
        src: "img/" + ((meta.icons && meta.icons[item_ns]) || `${item_ns}.png`),
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

// ---------- State changes ----------

// Section 1's preview changes height as enchantments come and go, and its conflict
// groups as "Allow conflicts" changes: each slides from its old height to the new one,
// so what is below moves smoothly instead of jumping. A redraw mid-slide starts from
// wherever it had got to.
export const motion_ok = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    }).observe(document.body, { childList: true, subtree: true });
    syncGlints();
}
