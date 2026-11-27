// Share links: saving the setup to the address and loading it (with optional progress).
import { logic, mod_data, nextBookId, setState, state } from "./Store.js";
import { linkEdition, linkMods } from "./Logic.js";
import { syncRename } from "./Options.js";
import { loadChecklist, orderKey, saveChecklist } from "./Results.js";
import { last_result } from "./Calc.js";
import { useEdition } from "./App.js";

// The address keeps a link's progress (see carried_progress) until the first result has used it,
// so a reload before then still has it; after that, the ticks live in this browser, and a
// reload must not bring back the link's older ones.
export function saveToUrl() {
    const url = state.item ? "#" + linkText() : location.pathname + location.search;
    history.replaceState(null, "", url);
}

// The link text the address holds for the setup on screen.
export function linkText() {
    return logic.serialize(state, carried_progress);
}

export function loadFromUrl() {
    const hash = location.hash.slice(1);
    const loaded = hash ? readLink(hash) : null;
    if (loaded) useLink(loaded);
}

// Puts a read link's setup on screen (the caller rebuilds the helpers for its edition and redraws).
export function useLink(loaded) {
    carried_progress = loaded.progress;
    delete loaded.progress;
    setState(loaded);
    syncRename();
}

// Ticked steps from a "link with progress", held until the order is calculated: they are
// kept only if it is the same order (its key matches), else dropped. Read once.
let carried_progress = null;

// A short stand-in for an order key, so a link doesn't carry the whole of it.
function orderHash(order_key) {
    let hash = 2166136261;
    for (let index = 0; index < order_key.length; index++) hash = Math.imul(hash ^ order_key.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
}

export function applyCarriedProgress(node) {
    const carried = carried_progress;
    if (!carried) return;
    carried_progress = null;
    saveToUrl(); // the progress is used (or dropped): the address no longer carries it
    if (!node) return;
    const steps = logic.collectSteps(node);
    const order_key = orderKey(steps);
    if (orderHash(order_key) !== carried.key) return;
    saveChecklist(order_key, new Set(carried.done.filter(number => steps.some(step => step.number === number))));
}

// What "Copy link" copies: this page's address, plus the ticked steps of the order on
// screen when there are any (so the link carries on from where you stopped).
export function currentLink() {
    const node = last_result && last_result.status === "ok" ? last_result.node : null;
    if (!node || !state.item) return location.href;
    const order_key = orderKey(logic.collectSteps(node));
    const done = loadChecklist(order_key);
    if (!done.size) return location.href;
    const link = logic.serialize(state, { key: orderHash(order_key), done: [...done].sort((a, b) => a - b) });
    return location.href.split("#")[0] + "#" + link;
}

// The state in a share link's text, or null if it is not valid. Read with the helpers of the
// link's own edition and mods (Bedrock offers enchantments Java does not); the caller then
// switches to them.
// A saved setup as it was saved: its item and enchantments read with its own edition and mods, and each enchantment's name and mod (its label)
// from those, so one this page can't offer now (a mod that is off, the other edition's) can still be named. Null if the link can't be read.
export function readSetup(text) {
    try {
        useEdition(linkEdition(text), linkMods(text).filter(id => mod_data[id]));
        const loaded = logic.deserialize(text, () => 0);
        if (!loaded) return null;
        const names = {}, mods = {};
        for (const [ns, level] of Object.entries(loaded.wanted)) {
            names[ns] = logic.displayName(ns, level);
            if (logic.modOf(ns)) mods[ns] = logic.modOf(ns);
        }
        return { item: loaded.item, wanted: loaded.wanted, names, mods, edition: loaded.edition, allow_incompatible: loaded.allow_incompatible, mods_on: loaded.mods };
    } catch {
        return null;
    } finally {
        useEdition(state.edition);
    }
}

export function readLink(text) {
    try {
        useEdition(linkEdition(text), linkMods(text).filter(id => mod_data[id]));
        return logic.deserialize(text, () => nextBookId());
    } catch (error) {
        console.warn("Ignoring invalid link", error);
        return null;
    } finally {
        useEdition(state.edition);
    }
}
