// Section 3 settings: level limit, rename and "Your level".
import { EDITIONS, MAX_NAME_LENGTH, MAX_STEP_LEVELS, MOD_IDS, clampStepLimit, cleanName } from "./Logic.js";
import { TEXT } from "./Text.js";
import { logic, mod_data, state } from "./Store.js";
import { $, glintsOn, h, motionIgnored, setGlintsOn, readStorage, setMotionIgnored, writeStorage } from "./Dom.js";
import { loadChecklist, orderKey, renderResults } from "./Results.js";
import { last_result, scheduleCalculation } from "./Calc.js";
import { saveToUrl } from "./Link.js";
import { floatBubble, infoTip } from "./Tips.js";
import { closeRow, inertCopy, openRow } from "./Motion.js";
import { applyMods, commit, setAllowIncompatible, setEdition, setMod, setupMenuClosing } from "./App.js";

// Kept in this browser only (not in share links): they are about the viewer, not the setup.
const LEVEL_STORAGE_KEY = "enchantment-calculator-level";
const LEVEL_ON_STORAGE_KEY = "enchantment-calculator-level-on";
const MAX_PLAYER_LEVEL = 24791; // the highest level in either edition
let player_level = readStorage(LEVEL_STORAGE_KEY, null); // "Your level", or null when blank
// Whether the steps follow "Your level". Off keeps the number for when it is turned on again.
let level_on = readStorage(LEVEL_ON_STORAGE_KEY, player_level != null) === true;
// The step limit in effect, or Infinity when it is turned off.
export function stepLimit() {
    return state.no_step_limit ? Infinity : state.max_step;
}

// A mod's name before its data file has loaded (the switch shows it, and loads the file when pressed).
const MOD_LABELS = { fancy_enchantments: "Fancy Enchantments", spellbound: "Spellbound" };

const ENCHANTING_TABLE_LEVEL = 30; // the enchanting table's top offer
const HOLD_DELAY_MS = 400;          // holding − / +: wait this long, then repeat
const HOLD_REPEAT_MS = 70;

// Under the tiles, one grid so the labels share a column: Rename and Your level (tracking it shows
// the number, what the order needs and how far it falls short). The game rules (the level limit and
// Allow conflicts) are in the Game rules menu in the page header.
export function renderRanking() {
    const box = $("#ranking");
    const panel = $("#limit-panel");
    const active = document.activeElement;
    const focused = active && (box.contains(active) || panel.contains(active)) ? active.dataset.focus : null;

    // The settings menu: the game rules (the level limit, whether conflicting enchantments may go together, the edition and the
    // mods: they apply everywhere) as a subsection, then the display settings. The menu stays open while they change.
    panel.replaceChildren(
        h("div", { class: "options-panel-head" }, h("div", { class: "options-panel-title" }, TEXT.ranking.settings)),
        h("section", { class: "settings-section" },
            h("div", { class: "settings-section-head" },
                h("div", { class: "settings-section-title" }, TEXT.ranking.options),
                h("button", {
                    type: "button", class: "btn small", "data-focus": "rules-reset", title: TEXT.ranking.rules_reset_help,
                    disabled: rulesAreVanilla(), onclick: resetRules
                }, TEXT.ranking.rules_reset)),
            h("div", { class: "options" },
                optionRow(TEXT.ranking.edition, null, editionControl()),
                // No hover titles on these labels: the "?" beside each says what it is for.
                optionRow([TEXT.ranking.level_limit, helpTip("limit-help", TEXT.ranking.level_limit_help_label, TEXT.ranking.level_limit_help)], null, limitControl()),
                optionRow([TEXT.ranking.allow_conflicts, helpTip("conflicts-help", TEXT.ranking.allow_conflicts_help_label, TEXT.ranking.allow_conflicts_help)], null, conflictsSwitch()),
                optionRow([TEXT.ranking.mods, helpTip("mods-help", TEXT.ranking.mods_help_label, TEXT.ranking.mods_help)], null, modsControl()))),
        h("section", { class: "settings-section" },
            h("div", { class: "settings-section-head" }, h("div", { class: "settings-section-title" }, TEXT.ranking.display)),
            h("div", { class: "options" },
                optionRow([TEXT.ranking.no_motion, helpTip("motion-help", TEXT.ranking.no_motion_help_label, TEXT.ranking.no_motion_help)], null, motionSwitch()),
                optionRow([TEXT.ranking.glints, helpTip("glint-help", TEXT.ranking.glints_help_label, TEXT.ranking.glints_help)], null, glintSwitch())))
    );
    const summary = TEXT.ranking.settings + ": " + optionsSummary();
    $("#options-summary").textContent = TEXT.ranking.settings;
    // A dot on the button says a game rule isn't the game's own (on phones the button is the gear alone);
    // its label says how they are set.
    const button = $("#options-menu > summary");
    button.classList.toggle("changed", !rulesAreVanilla());
    button.setAttribute("aria-label", summary);
    button.title = summary;

    // Under the tiles: one grid, so the labels share a column.
    box.replaceChildren(h("div", { class: "options" },
        optionRow(TEXT.ranking.rename, TEXT.ranking.rename_help, nameField()),
        optionRow(TEXT.ranking.your_level, TEXT.ranking.your_level_help, levelControl())
    ));

    if (focused) {
        const again = document.querySelector(`#ranking [data-focus="${focused}"], #limit-panel [data-focus="${focused}"]`);
        if (again) again.focus();
    }
    updateLevelMeter();
}

// The game's own rules: the level limit 39, no conflicting enchantments together and no mods.
function rulesAreVanilla() {
    return !state.no_step_limit && state.max_step === MAX_STEP_LEVELS && !state.allow_incompatible && !state.mods.length;
}

// Back to the game's own rules, in one step (the menu stays open).
function resetRules() {
    state.max_step = MAX_STEP_LEVELS;
    state.no_step_limit = false;
    if (state.mods.length) {
        state.mods = [];
        applyMods();
    }
    if (state.allow_incompatible) setAllowIncompatible(false);
    else commit();
}

// "Level limit 39" (or "No level limit"), plus " · Conflicts allowed" when they are and the mods that are
// on: what the game rules button says (as its hover title and label) so a rule that isn't the game's own
// is known with the menu closed.
function optionsSummary() {
    const limit = state.no_step_limit ? TEXT.ranking.options_no_limit : TEXT.ranking.options_limit({ limit: state.max_step });
    const parts = [limit];
    if (state.allow_incompatible) parts.push(TEXT.ranking.options_conflicts);
    for (const id of state.mods) if (mod_data[id]) parts.push(mod_data[id].label);
    return TEXT.ranking.options + ": " + parts.join(" · ");
}

// What a game rule is for, in a "?" tip beside its label (tap on phones). Its bubble
// floats over the page, like the Best order one.
function helpTip(id, label, text) {
    const tip = infoTip(id, "?", label, text, "option-help");
    floatBubble(tip);
    return tip;
}

// Java or Bedrock: their anvil rules differ. Not a rule "Reset to vanilla" changes (both are the game).
function editionControl() {
    return h("div", { class: "segmented edition-switch", role: "group", "aria-label": TEXT.page.edition_label },
        EDITIONS.map(edition => h("button", {
            type: "button", class: state.edition === edition ? "selected" : "", "aria-pressed": String(state.edition === edition),
            "data-focus": "edition-" + edition, title: TEXT.page.editions[edition].help, onclick: () => setEdition(edition)
        }, TEXT.page.editions[edition].label)));
}

// Ignore all animations: an on/off switch, kept in this browser (Dom.js). On, nothing on the page moves, fades or slides (the glints have their own switch).
function motionSwitch() {
    const on = motionIgnored();
    return h("div", { class: "rule-control" },
        h("button", {
            type: "button", class: "rule-switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on),
            "data-focus": "motion-off", "aria-label": TEXT.ranking.no_motion,
            onclick: () => { setMotionIgnored(!on); renderRanking(); }
        }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
            h("span", {}, on ? TEXT.ranking.switch_on : TEXT.ranking.switch_off))
    );
}

// Glints: an on/off switch, kept in this browser (Dom.js). Off, the slots' and chosen rows' sheen stops (slots keep a still band).
function glintSwitch() {
    const on = glintsOn();
    return h("div", { class: "rule-control" },
        h("button", {
            type: "button", class: "rule-switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on),
            "data-focus": "glints", "aria-label": TEXT.ranking.glints,
            onclick: () => { setGlintsOn(!on); renderRanking(); }
        }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
            h("span", {}, on ? TEXT.ranking.switch_on : TEXT.ranking.switch_off))
    );
}

// Allow conflicts: an on/off switch.
function conflictsSwitch() {
    const on = state.allow_incompatible;
    return h("div", { class: "rule-control" },
        h("button", {
            type: "button", class: "rule-switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on),
            "data-focus": "allow-conflicts", "aria-label": TEXT.ranking.allow_conflicts,
            onclick: () => setAllowIncompatible(!on)
        }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
            h("span", {}, on ? TEXT.ranking.switch_on : TEXT.ranking.switch_off))
    );
}

// Mods: a switch for each mod whose enchantments can be added, with where its numbers come from. Mods are
// Java only, so on Bedrock the switches are off and disabled. The data loads when first needed.
function modsControl() {
    const java = state.edition === "java";
    return h("div", { class: "mods-control" }, MOD_IDS.map(id => {
        const on = java && state.mods.includes(id) && Boolean(mod_data[id]);
        const mod = mod_data[id];
        return h("div", { class: "mod-row" },
            h("button", {
                type: "button", class: "rule-switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), disabled: !java,
                "data-focus": "mod-" + id, "aria-label": mod ? mod.label : id, onclick: () => setMod(id, !on)
            }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
                h("span", {}, mod ? mod.label : MOD_LABELS[id])),
            java ? (on && mod ? h("span", { class: "mod-note" }, mod.note) : null) : h("span", { class: "mod-note" }, TEXT.ranking.mods_java_only));
    }));
}

// The panel is position: fixed, placed under the button whenever it opens and as the
// page or the right column scrolls: inside the right column it would count as the
// column's content, and stick out of (or add a scrollbar to) a short column, such as
// with Best order closed. It ends at the button's right edge, kept on screen.
export function setupOptionsMenu() {
    const menu = $("#options-menu");
    const panel = $("#limit-panel");
    setupMenuClosing(menu); // its title and label come from renderRanking
    const place = () => {
        if (!menu.open) return;
        const button = menu.querySelector("summary").getBoundingClientRect();
        const width = panel.offsetWidth;
        panel.style.top = button.bottom + 6 + "px";
        panel.style.left = Math.max(8, Math.min(button.right - width, innerWidth - width - 8)) + "px";
    };
    menu.addEventListener("toggle", place);
    menu.querySelector("summary").addEventListener("click", () => requestAnimationFrame(place));
    document.addEventListener("scroll", place, { capture: true, passive: true });
    addEventListener("resize", place);
}

function optionRow(label, help, control) {
    return [
        h("span", { class: "option-label", title: help }, label),
        h("div", { class: "option-control" }, control)
    ];
}

// Level limit: a slider from 1 to 39 that ends in an ∞ stop (no limit, for mods that
// remove "Too Expensive!"). The number on the right can be tapped to type a value.
// Dragging only redraws the number; the new limit is used when the slider is let go.
function limitControl() {
    const unlimited = state.no_step_limit;
    const shown = value => (unlimited && value === state.max_step ? TEXT.ranking.unlimited : String(value));
    const value_button = h("button", {
        type: "button", class: "limit-value" + (unlimited ? " unlimited" : ""), "data-focus": "limit-value",
        title: TEXT.ranking.level_limit_edit_label, "aria-label": TEXT.ranking.level_limit_edit_label,
        onclick: () => editLimit(value_button)
    }, shown(state.max_step));
    const slider = h("input", {
        type: "range", class: "limit-slider" + (unlimited ? " off" : ""), min: 1, max: MAX_STEP_LEVELS, step: 1,
        value: state.max_step, "data-focus": "limit-slider", "aria-label": TEXT.ranking.level_limit_label,
        oninput: event => {
            value_button.textContent = event.target.value;
            value_button.classList.remove("unlimited");
            event.target.classList.remove("off");
            paintSlider(event.target);
        },
        onchange: event => setLimit(event.target.value)
    });
    paintSlider(slider);
    return h("div", { class: "limit" },
        h("span", { class: "limit-end", "aria-hidden": "true" }, "1"),
        slider,
        h("button", {
            type: "button", class: "limit-infinity" + (unlimited ? " on" : ""), "data-focus": "limit-infinity",
            "aria-pressed": String(unlimited), "aria-label": TEXT.ranking.no_limit, title: TEXT.ranking.no_limit_help,
            onclick: () => { state.no_step_limit = !state.no_step_limit; commit(); }
        }, TEXT.ranking.unlimited),
        value_button
    );
}

// The filled part of the track, up to the handle.
function paintSlider(slider) {
    const share = (slider.value - slider.min) / (slider.max - slider.min);
    slider.style.setProperty("--fill", (share * 100).toFixed(1) + "%");
}

// Moving the slider or typing a number always means "use this limit".
function setLimit(value) {
    state.max_step = clampStepLimit(value);
    state.no_step_limit = false;
    commit();
}

// Whether a mouse button or finger is down. Leaving the typed limit by pressing another
// control in the panel (∞, Allow conflicts) must not redraw the panel before that press
// becomes a click, or the click lands on a removed button and is lost.
let pointer_down = false;
addEventListener("pointerdown", () => { pointer_down = true; }, true);
for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => { pointer_down = false; }, true);

// Runs `redraw` now, or once the press that is under way has become its click.
function afterPress(redraw) {
    if (!pointer_down) { redraw(); return; }
    addEventListener("pointerup", () => setTimeout(redraw), { once: true });
}

// Swaps the number for a box to type in: Enter or leaving it uses the value, Escape
// puts the number back.
function editLimit(button) {
    let done = false;
    const finish = use => {
        if (done) return;
        done = true;
        if (use && input.value.trim() !== "") {
            // The limit applies at once, so a click on ∞ that follows builds on it.
            state.max_step = clampStepLimit(input.value);
            state.no_step_limit = false;
            afterPress(commit);
        } else afterPress(renderRanking);
    };
    const input = h("input", {
        type: "number", class: "limit-edit", min: 1, max: MAX_STEP_LEVELS, inputmode: "numeric",
        value: state.max_step, "data-focus": "limit-value", "aria-label": TEXT.ranking.level_limit_label,
        onkeydown: event => {
            if (event.key === "Enter") finish(true);
            if (event.key === "Escape") { event.stopPropagation(); finish(false); }
        },
        onblur: () => finish(true)
    });
    button.replaceWith(input);
    input.focus();
    input.select();
}

// Your level: a switch for following it through the steps ("Track my level"). On, it opens the
// number (− / + around a game-style green number with an XP bar under it, which fills toward the
// levels the current order needs; holding − or + repeats), a button that sets it to exactly what
// is needed, and a line saying whether it is enough or how many levels are missing. It only
// changes what the steps show, so it redraws just the results.
function levelControl() {
    const input = h("input", {
        type: "number", class: "xp-value", id: "player-level", "data-focus": "player-level",
        min: 0, max: MAX_PLAYER_LEVEL, inputmode: "numeric", value: player_level, placeholder: "–",
        "aria-label": TEXT.ranking.your_level_label,
        oninput: event => setPlayerLevel(event.target.value.trim() === "" ? null : Number(event.target.value), false)
    });
    const step = (delta, sign, label) => holdButton({
        class: "xp-step", "data-focus": "level-" + (delta < 0 ? "down" : "up"), "aria-label": label
    }, sign, () => setPlayerLevel((player_level == null ? 0 : player_level) + delta, true));
    const switcher = h("button", {
        type: "button", class: "rule-switch level-toggle" + (level_on ? " on" : ""), role: "switch", "aria-checked": String(level_on),
        "data-focus": "level-toggle", title: TEXT.ranking.use_level_help,
        onclick: () => setLevelOn(!level_on)
    }, h("span", { class: "rule-switch-track", "aria-hidden": "true" }, h("span", { class: "rule-switch-thumb" })),
        h("span", {}, TEXT.ranking.track_level));
    const body = level_on ? h("div", { class: "level-body" },
        h("div", { class: "level-row" },
            h("div", { class: "xp-box" },
                step(-1, "−", TEXT.ranking.level_down_label),
                h("div", { class: "xp-field" }, input, h("div", { class: "xp-bar", id: "xp-bar" }, h("div", { class: "xp-fill" }))),
                step(1, "+", TEXT.ranking.level_up_label)
            ),
            // Exactly the levels the unticked steps still need (filled in by updateLevelMeter, which knows the order).
            h("button", {
                type: "button", class: "btn small level-set", id: "level-set", "data-focus": "level-set",
                title: TEXT.ranking.set_needed_help,
                onclick: () => {
                    const node = resultNode();
                    if (node) setPlayerLevel(remainingLevels(logic.collectSteps(node)).needed, true);
                }
            })
        ),
        h("p", { class: "level-status", id: "level-status", "aria-live": "polite" })
    ) : null;
    return h("div", { class: "level-control" }, switcher, body);
}

// Turning it on with no number yet starts at 30 (the enchanting table's top level).
function setLevelOn(on) {
    level_on = on;
    writeStorage(LEVEL_ON_STORAGE_KEY, level_on);
    if (on && player_level == null) {
        player_level = ENCHANTING_TABLE_LEVEL;
        writeStorage(LEVEL_STORAGE_KEY, player_level);
    }
    // The number, the button and the status open or close under the switch.
    const old_body = document.querySelector("#ranking .level-body");
    const copy = old_body ? inertCopy(old_body) : null;
    renderRanking();
    const body = document.querySelector("#ranking .level-body");
    if (body) openRow(body);
    else if (copy) closeRow(document.querySelector("#ranking .level-control"), copy);
    renderResults();
}

// The level the steps follow, or null when "Your level" is off or blank.
export function activeLevel() {
    return level_on ? player_level : null;
}

// A button that acts once when pressed and keeps acting while held. Keyboard presses
// (Enter, Space) act once through the click.
function holdButton(attrs, text, act) {
    let delay = null, repeat = null;
    const stop = () => { clearTimeout(delay); clearInterval(repeat); };
    return h("button", {
        type: "button", ...attrs,
        onpointerdown: event => {
            if (event.button > 0) return;
            act();
            delay = setTimeout(() => { repeat = setInterval(act, HOLD_REPEAT_MS); }, HOLD_DELAY_MS);
        },
        onpointerup: stop, onpointerleave: stop, onpointercancel: stop,
        onclick: event => { if (event.detail === 0) act(); }
    }, text);
}

// `null` clears it. `update_input`: also show the new value in the box (not while
// typing in it, which would move the cursor).
function setPlayerLevel(value, update_input) {
    player_level = value == null || Number.isNaN(value) ? null : Math.min(MAX_PLAYER_LEVEL, Math.max(0, Math.floor(value)));
    writeStorage(LEVEL_STORAGE_KEY, player_level);
    if (update_input) $("#player-level").value = player_level == null ? "" : player_level;
    renderResults();
}

// What is still to spend, for "Your level": ticked steps are done, so their levels are
// already gone from the player's level and count as 0 here. (The Levels tile keeps the
// whole order's total.) Returns { costs: per step in step order, needed: their sum }.
export function remainingLevels(steps) {
    const done = loadChecklist(orderKey(steps));
    const costs = steps.map(step => (done.has(step.number) ? 0 : step.node.merge_levels));
    return { costs, needed: costs.reduce((total, cost) => total + cost, 0) };
}

// The finished order, or null while there is none.
export function resultNode() {
    const node = last_result && last_result.status === "ok" ? last_result.node : null;
    return node && node.left ? node : null;
}

// The XP bar under "Your level": how far the level goes toward what the order needs.
export function updateLevelMeter() {
    const bar = $("#xp-bar");
    if (!bar) return;
    const node = resultNode();
    const levels = node ? remainingLevels(logic.collectSteps(node)) : null;
    const needed = levels ? levels.needed : 0;
    const active = activeLevel();
    const level = active == null ? 0 : active;
    const share = needed && active != null ? Math.min(1, level / needed) : 0;
    bar.firstChild.style.width = (share * 100).toFixed(1) + "%";
    bar.classList.toggle("enough", Boolean(needed) && active != null && level >= needed);
    bar.title = !needed || active == null ? ""
        : level >= needed ? TEXT.ranking.level_enough({ needed })
            : TEXT.ranking.level_short_of({ short: needed - level, needed });

    const set = $("#level-set");
    set.textContent = levels ? TEXT.ranking.set_needed({ levels: needed }) : TEXT.ranking.set_needed_none;
    set.disabled = !levels;
    // Enough, or how many levels are missing (nothing while there is no order or no number).
    const status = $("#level-status");
    const known = Boolean(needed) && active != null;
    status.textContent = !known ? "" : level >= needed ? TEXT.ranking.level_enough_now : TEXT.ranking.level_need_more({ short: needed - level });
    status.className = "level-status" + (!known ? "" : level >= needed ? " enough" : " short");
}

// Rename: one box drawn like the anvil's name field. Empty means no rename, and shows the
// item's own name in gray as a hint; any typed name (even the item's own) renames the item
// in the last step (+1 level), in white italics as the game shows renamed items. Inside:
// the name tag (lit while renaming), the name, a "+1 level" badge while renaming, and a
// count against the edition's limit.
function nameField() {
    const limit = MAX_NAME_LENGTH[state.edition];
    const original = state.item ? logic.itemName(state.item) : "";
    const count = h("span", { class: "name-count" });
    const input = h("input", {
        type: "text", class: "anvil-name-input", value: state.rename_to, maxlength: limit, "data-focus": "rename-to",
        placeholder: original || TEXT.ranking.rename_placeholder, "aria-label": TEXT.ranking.rename_label,
        oninput: event => {
            state.rename_to = cleanName(event.target.value, state.edition);
            const renaming = syncRename();
            showState();
            saveToUrl();
            // Starting or ending a rename changes the cost (+1 level), so search again;
            // otherwise only the name on the result changes. This box is never redrawn
            // while typing, which would move the cursor.
            if (renaming !== was_renaming) { was_renaming = renaming; scheduleCalculation(); }
            renderResults();
        }
    });
    const box = h("div", { class: "anvil-name" },
        nameTagIcon(),
        input,
        h("span", { class: "rename-cost" }, TEXT.ranking.rename_cost),
        count
    );
    let was_renaming = state.rename;
    const showState = () => {
        const used = input.value.length; // UTF-16 units, as the game and maxlength count
        count.textContent = TEXT.ranking.name_count({ count: used, max: limit });
        count.title = TEXT.ranking.name_count_label({ count: used, max: limit });
        box.classList.toggle("renaming", state.rename);
    };
    showState();
    return box;
}

// The game's name tag (img/name_tag.svg).
function nameTagIcon() {
    return h("img", { class: "name-tag-icon", src: "img/name_tag.svg", alt: "", "aria-hidden": "true" });
}

// Renaming is on exactly when a name is typed. Returns whether it is.
export function syncRename() {
    state.rename = state.rename_to.trim() !== "";
    return state.rename;
}
