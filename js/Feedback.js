// The header's Feedback button: a dialog (type, title, description) that opens a prefilled GitHub issue, or copies the same report.
// The report ends with what the page is set to (language, edition, item, enchantments...) as plain text, shown under the description and never editable.
// Nothing is sent from the page: GitHub's own form is where the user presses Submit. A translation correction goes straight to the language's file in GitHub's editor.
import { CONFIDENCE, LANGUAGES, TEXT } from "./Text.js";
import { h } from "./Dom.js";
import { language, state } from "./Store.js";
import { roman } from "./Logic.js";

const REPO = "jmarcinik3/MinecraftEnchantmentCalculator";
// Per type: its label on GitHub, and its name in the title and in the issue form's Type dropdown (.github/ISSUE_TEMPLATE/feedback.yml; the reports are in English).
const TYPES = {
    correction: { name: "Correction", labels: "correction" },
    suggestion: { name: "Suggestion", labels: "enhancement" },
    bug: { name: "Bug", labels: "bug" },
    comment: { name: "Comment", labels: "feedback" }
};
const CRITERIA_NAMES = { levels: "Levels", xp: "XP", max_step: "Max level", prior_work: "Prior work" };

let type = "suggestion", about = "";
let dialog, typeButtons, titleInput, message, added, ack, open_link, copy_button, language_select, edit_link, tier_note, copy_timer;

// "depth_strider" or "fancyenchantments:air_attack" -> "Depth Strider", "Air Attack": the reports are in English whatever the page's language.
const words = key => key.split(":").pop().split("_").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
const enchantmentList = levels => Object.entries(levels).map(([key, level]) => words(key) + " " + roman(level)).join(", ");

// The setup as lines of text: what the share link holds, readable.
function setupLines() {
    const lines = ["Language: " + language, "Edition: " + words(state.edition)];
    lines.push("Item: " + (state.item ? words(state.item) : "None"));
    lines.push("Enchantments: " + (Object.keys(state.wanted).length ? enchantmentList(state.wanted) : "None"));
    lines.push("Books: " + (state.auto_books ? "Automatic" : state.books.length
        ? state.books.map(book => (book.type === "item" ? "item" : "book") + " (" + (Object.keys(book.enchantments).length ? enchantmentList(book.enchantments) : "empty")
            + (book.prior_work ? ", prior work " + book.prior_work : "") + ")" + (book.copies > 1 ? " x" + book.copies : "")).join("; ") : "None"));
    lines.push("Ranked by: " + state.priority.map(criterion => CRITERIA_NAMES[criterion] || criterion).join(", "));
    lines.push("Level limit: " + (state.no_step_limit ? "None" : state.max_step));
    lines.push("Mods: " + (state.mods.length ? state.mods.join(", ") : "None"));
    if (state.rename && state.rename_to) lines.push("Rename: " + state.rename_to);
    return lines;
}

function report() {
    const description = message.value.trim();
    const extra = [...(about ? ["About: " + about] : []), ...setupLines()];
    return {
        title: ("[" + TYPES[type].name + "] " + (titleInput.value.trim() || about)).trim(),
        body: [...(description ? [description, ""] : []), ...extra].join("\n"),
        extra: extra.join("\n")
    };
}

// An issue form fills a field by its id (type, description); a plain issue reads `body`. Both are sent, so either works.
function issueUrl(r) {
    const t = TYPES[type];
    return "https://github.com/" + REPO + "/issues/new?" + new URLSearchParams({ template: "feedback.yml", type: t.name, title: r.title, labels: t.labels, description: r.body, body: r.body });
}

function refresh() {
    const r = report();
    message.placeholder = TEXT.page["feedback_ask_" + type];
    titleInput.placeholder = TEXT.page["feedback_title_" + type];
    for (const button of typeButtons) button.setAttribute("aria-pressed", String(button.dataset.type === type));
    added.textContent = r.extra;
    const agreed = ack.checked;
    if (agreed) open_link.href = issueUrl(r); else open_link.removeAttribute("href");
    open_link.setAttribute("aria-disabled", String(!agreed));
    copy_button.disabled = !agreed;
}

function correctionLink() {
    const code = language_select.value;
    edit_link.href = "https://github.com/" + REPO + "/edit/main/json/text/" + code + ".json";
    tier_note.textContent = TEXT.page["feedback_tier_" + CONFIDENCE[code]];
}

async function copyReport() {
    if (!ack.checked) return;
    const r = report();
    let said = TEXT.results.copied;
    try { await navigator.clipboard.writeText(r.title + "\n\n" + r.body); } catch { said = TEXT.results.copy_failed; }
    copy_button.textContent = said;
    clearTimeout(copy_timer);
    copy_timer = setTimeout(() => { copy_button.textContent = TEXT.page.feedback_copy; }, 1500);
}

// Opens the dialog on a type (and, from a place that knows it, what the feedback is about: a line in the report).
export function openFeedback(kind = "suggestion", subject = "") {
    type = kind; about = subject;
    titleInput.value = ""; message.value = ""; ack.checked = true;
    language_select.value = language;
    correctionLink();
    refresh();
    dialog.showModal();
    titleInput.focus();
}

// Builds the dialog once; the labels are filled again by `renderFeedback` when the page's language changes.
export function setupFeedback(button) {
    typeButtons = Object.keys(TYPES).map(key => h("button", { type: "button", class: "feedback-type", "data-type": key, onclick: () => { type = key; refresh(); } }));
    titleInput = h("input", { id: "feedback-title", type: "text", maxlength: "120", autocomplete: "off", oninput: refresh });
    message = h("textarea", { id: "feedback-message", oninput: refresh });
    added = h("pre", { class: "feedback-added", tabindex: "0" });
    ack = h("input", { type: "checkbox", id: "feedback-ack", checked: true, onchange: refresh });
    open_link = h("a", { class: "feedback-button primary", target: "_blank", rel: "noopener" });
    copy_button = h("button", { class: "feedback-button", type: "button", onclick: copyReport });
    language_select = h("select", { id: "feedback-language", onchange: correctionLink }, Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code }, name + " (" + code + ")")));
    edit_link = h("a", { class: "feedback-button", target: "_blank", rel: "noopener" });
    tier_note = h("div", { class: "feedback-note" });
    const heading = h("span", { id: "feedback-heading" });
    const close = h("button", { class: "feedback-button feedback-close", value: "cancel" }, "✕");
    const labels = {
        title: h("label", { for: "feedback-title" }), message: h("label", { for: "feedback-message" }),
        ack: h("span"), no_account: h("div", { class: "feedback-note" }),
        translation: h("h4", { id: "feedback-translation" }), translation_note: h("p", { class: "feedback-note" })
    };
    const types = h("div", { class: "feedback-types", role: "group" }, typeButtons);
    dialog = h("dialog", { class: "feedback-dialog", "aria-labelledby": "feedback-heading", onclick: event => { if (event.target === dialog) dialog.close(); } },
        h("form", { method: "dialog", class: "feedback-form" },
            h("h3", {}, heading, close),
            types,
            h("div", { class: "feedback-field" }, labels.title, titleInput),
            h("div", { class: "feedback-field" }, labels.message, h("div", { class: "feedback-desc" }, message, added)),
            h("label", { class: "feedback-check" }, ack, labels.ack),
            h("div", { class: "feedback-actions" }, open_link, copy_button),
            labels.no_account,
            h("section", { class: "feedback-translation", "aria-labelledby": "feedback-translation" },
                labels.translation, labels.translation_note,
                h("div", { class: "feedback-row" }, language_select, edit_link), tier_note)));
    document.body.append(dialog);
    button.addEventListener("click", () => openFeedback("suggestion"));

    // Redraws the labels (the page's language changed).
    return function renderFeedback() {
        const page = TEXT.page;
        heading.textContent = page.feedback_title;
        close.setAttribute("aria-label", page.feedback_close);
        types.setAttribute("aria-label", page.feedback_type);
        for (const b of typeButtons) b.textContent = page["feedback_" + b.dataset.type];
        labels.title.textContent = page.feedback_field_title;
        labels.message.textContent = page.feedback_field_description;
        added.setAttribute("aria-label", page.feedback_added);
        labels.ack.textContent = page.feedback_ack;
        open_link.textContent = page.feedback_open;
        copy_button.textContent = page.feedback_copy;
        labels.no_account.textContent = page.feedback_no_account;
        labels.translation.textContent = page.feedback_translation;
        labels.translation_note.textContent = page.feedback_translation_note;
        language_select.setAttribute("aria-label", page.feedback_translation_language);
        edit_link.textContent = "✎ " + page.feedback_edit;
        button.querySelector(".feedback-label").textContent = page.feedback_button;
        button.setAttribute("aria-label", page.feedback_button);
        button.title = page.feedback_button;
        if (dialog.open) refresh();
    };
}
