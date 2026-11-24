// The "?" bubbles.
import { $, h } from "./Dom.js";

// The "?" next to "Best order": shows how the tiles rank on hover or keyboard focus (CSS),
// and on tap for touch screens, where hover tooltips never appear. Tapping elsewhere or
// pressing Escape closes it.
export function setupInfoTip() {
    const button = $("#rank-help");
    button.addEventListener("click", event => toggleTip(event, button.closest(".info-tip")));
    floatBubble(button.closest(".info-tip"));
    // Any open tip closes on a click elsewhere or on Escape.
    document.addEventListener("click", event => {
        for (const tip of document.querySelectorAll(".info-tip.open")) if (!tip.contains(event.target)) setTipOpen(tip, false);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") for (const tip of document.querySelectorAll(".info-tip.open")) setTipOpen(tip, false);
    });
}

// The "?" sits in the right column, which scrolls when its contents are too tall, so a
// bubble positioned inside it would count as content and add a scrollbar. This places the
// bubble against the window instead (position: fixed): under the "?", kept on screen, and
// following the "?" when the page or the column scrolls.
export function floatBubble(tip) {
    const bubble = tip.querySelector(".info-tip-bubble");
    // Only while it shows: a hidden bubble has no width to keep on screen.
    const place = () => {
        if (!bubble.offsetWidth) return;
        const anchor = tip.querySelector("button").getBoundingClientRect();
        bubble.style.top = anchor.bottom + 6 + "px";
        bubble.style.left = Math.max(8, Math.min(anchor.left, innerWidth - bubble.offsetWidth - 8)) + "px";
    };
    tip.classList.add("floating");
    tip.place = place; // setTipOpen calls it once the bubble is open
    for (const type of ["mouseenter", "focusin"]) tip.addEventListener(type, () => requestAnimationFrame(place));
    if (!floating_listeners) {
        // Once for all of them, since tips in redrawn panels are new each time.
        floating_listeners = true;
        const placeAll = () => { for (const other of document.querySelectorAll(".info-tip.floating")) other.place(); };
        document.addEventListener("scroll", placeAll, { capture: true, passive: true });
        addEventListener("resize", placeAll);
    }
}
let floating_listeners = false;

// Tips redrawn while open (the books badge, on every edit) stay open: remembered by id.
export const open_tips = new Set();

function setTipOpen(tip, open) {
    tip.classList.toggle("open", open);
    if (open && tip.place) tip.place();
    tip.querySelector("button").setAttribute("aria-expanded", String(open));
    if (tip.id) open ? open_tips.add(tip.id) : open_tips.delete(tip.id);
}

function toggleTip(event, tip) {
    event.stopPropagation();
    setTipOpen(tip, !tip.classList.contains("open"));
}

// A small button that shows `text` in a bubble on hover, focus or tap.
export function infoTip(id, button_text, label, text, extra_class = "") {
    const tip = h("span", { class: "info-tip " + extra_class, id },
        h("button", {
            type: "button", class: "info-tip-button", "aria-label": label, "aria-expanded": "false",
            onclick: event => toggleTip(event, tip)
        }, button_text),
        h("span", { class: "info-tip-bubble", role: typeof text === "string" ? "tooltip" : "group" }, text)
    );
    if (open_tips.has(id)) setTipOpen(tip, true);
    return tip;
}
