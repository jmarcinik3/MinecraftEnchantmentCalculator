"""Browser tests: the page in a real browser (Chromium through Playwright).

Run from the project folder:  python test/Browser.test.py
Needs:  pip install playwright   and   playwright install chromium

It serves the site on a free local port and checks the flows that unit tests can't see:
results, ticking and folding steps, links, hover/keyboard links, the Tree view, animations,
mods. The checks are split into independent `part_...` functions, each in its own Chromium, run
JOBS at a time, each thread keeping one Chromium (`--serial` runs them one by one, for debugging). Parts run with animations
off unless they are in MOTION_PARTS. Waits use `settle(page)` (the
search is idle and no finite animation is running) rather than fixed sleeps.
Skips (exit 0) when Playwright isn't installed, so it never blocks the other tests.
"""
import functools
import http.server
import os
import re
import sys
import threading
import time
import traceback
from queue import Queue

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("skipped: Playwright is not installed (pip install playwright; playwright install chromium)")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TIMEOUT_MS = 6000  # how long a click or wait for an element tries before the check fails
JOBS = int(os.environ.get("TEST_JOBS", 0)) or min(6, os.cpu_count() or 1)  # parts that run side by side (each in its own Chromium); `--serial` runs them one at a time
# Parts that run with "Show animations" off (the app's own setting, kept in localStorage), so no check waits for an easing it does not test.
# Parts in MOTION_PARTS (below PARTS) keep animations on, because they check them.
NO_MOTION_SCRIPT = "try { if (localStorage.getItem('enchantment-calculator-no-motion') === null) localStorage.setItem('enchantment-calculator-no-motion', 'true'); } catch (e) {}"
passed = 0
failed = 0
output_lock = threading.Lock()


def check(name, condition, detail=""):
    global passed, failed
    with output_lock:
        if condition:
            passed += 1
            print("  ok  " + name, flush=True)
        else:
            failed += 1
            print("  FAIL " + name + (" - " + str(detail) if detail else ""), flush=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass  # a page closed mid-download is not an error here


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    server = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def open_page(browser, url, **options):
    context = browser.new_context(**options)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.wait_for_selector("#wanted .item-grid, #item .wanted-preview")
    return context, page, errors


def settle(page, timeout=10000):
    """Waits until the search is idle and no finite animation or transition is still running (instead of sleeping)."""
    page.wait_for_function("""() => document.documentElement.dataset.search !== "pending" && document.documentElement.dataset.search !== "running" &&
        document.getAnimations().every(a => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity)""", timeout=timeout)


def frames(page, count=2):
    """Waits for `count` rendered frames (for what the page does in the next paint, such as an observer's callback)."""
    page.evaluate("count => new Promise(done => { const tick = () => --count > 0 ? requestAnimationFrame(tick) : done(); requestAnimationFrame(tick); })", count)


# Runs `action` (JS source) in the page, then scrubs every finite animation it started: all are paused and stepped through their whole
# length, reading `sample` (a JS expression) at each of `steps` + 1 points, so a check sees the same frames however slow the machine is.
# Returns the readings (`values`), what the action returned, how many animations ran and a last reading once they are finished and gone.
SCRUB = """async ([action, sample, steps]) => {
    const read = new Function("return (" + sample + ")");
    const acted = await new Function("return (async () => { " + action + " })()")();
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const finite = a => a.effect && a.effect.getComputedTiming().iterations !== Infinity && !/glint/.test(a.animationName || "");
    const running = document.getAnimations().filter(finite);
    running.forEach(a => a.pause());
    const end = Math.max(0, ...running.map(a => a.effect.getComputedTiming().endTime));
    const values = [];
    for (let i = 0; i <= steps; i++) {
        running.forEach(a => { a.currentTime = Math.min(end * i / steps, a.effect.getComputedTiming().endTime); });
        values.push(read());
    }
    running.forEach(a => a.finish());
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { values, acted, animations: running.length, after: read() };
}"""


def scrub(page, action, sample, steps=20):
    return page.evaluate(SCRUB, [action, sample, steps])


def fold_all(page, label):
    """Expand all ("Expand steps") or Collapse all ("Collapse steps") in section 4: one button that shows what it would do, so it is
    clicked until it has done the one asked for (twice when it first offers the other)."""
    want = "Expand" if label.startswith("Expand") else "Collapse"
    for _ in range(2):
        button = page.locator("#results .fold-toggle")
        offers = button.get_attribute("aria-label")
        button.click()
        settle(page)
        if offers.startswith(want):
            return


def offer_wanted_fold(page, action):
    """Brings Enchantments' one fold toggle to offer `action` ("expand" or "collapse"): it offers Collapse while anything is open, Expand once all is folded."""
    if page.get_attribute("#wanted .fold-toggle", "data-action") != action:
        page.click("#wanted .fold-toggle")
        settle(page)


def link_data(page):
    """the setup the address holds (the share link's JSON)"""
    return page.evaluate("JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))))")





MARK_JS = "(b => b.querySelector('.mc-mark.check') ? '\u2713' : b.querySelector('.mc-mark.bang') ? '!' : b.textContent)"

def badge_mark(page, selector):
    """A section badge's mark: its pixel check (Dom.js mcMark) as "✓", its "!" as "!", else its text (the number)."""
    return page.evaluate("s => %s(document.querySelector(s))" % MARK_JS, selector)

def clear_all(page):
    """Section 1's Remove all, when anything is chosen (it is disabled otherwise)."""
    button = page.locator('#wanted [data-focus="wanted-clear-all"]')
    button.wait_for(state="visible")
    if button.is_enabled():
        button.click()

def choose_max(page):
    """Every enchantment the item takes at its highest level (what the old "Best" preset gave): the page's own modules, imported by the same
    URLs it loaded them from, so these are the very state and helpers on screen."""
    page.wait_for_selector("#item .wanted-preview")
    page.evaluate("""(async () => {
        const store = await import('/js/Store.js'), app = await import('/js/App.js');
        store.state.wanted = store.logic.maxAll(store.state.item, {}, store.state.allow_incompatible);
        app.commit();
    })()""")

def pick_helmet_max(page):
    page.click('#wanted .item-grid button[data-focus="item-helmet"]')
    choose_max(page)
    page.wait_for_selector("#results .anvil-step", timeout=8000)


def part_steps(browser, base):
    """the helmet flow: ticking, folding, links, phones, Start over"""
    context, page, errors = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page.wait_for_selector("#wanted .item-grid")
    check("the first screen explains the page", page.locator("#wanted .intro").count() == 1)
    page.click("#wanted .example")
    page.wait_for_selector("#results .anvil-step", timeout=8000)
    check("the example picks Depth Strider boots with enchantments", page.locator("#item .wanted-preview .mc-ench").count() >= 3)

    steps = page.locator("#results .anvil-step")
    total = steps.count()
    check("a result with several steps", total >= 3, total)
    bars = page.locator("#results .hotbar-slot")
    check("the hotbar has one slot per step", bars.count() == total, bars.count())

    # Ticking folds the ticked step and fills a segment; the page doesn't jump.
    page.locator('input[data-step="1"]').check()
    check("ticking dims one hotbar slot", page.locator("#results .hotbar-slot.done").count() == 1)
    check("a ticked step is folded", page.locator('.anvil-step[data-step-card="1"].folded').count() == 1)
    # A step folds and unfolds by clicking its head.
    page.locator('.anvil-step[data-step-card="2"] .step-head').click(position={"x": 200, "y": 8})
    check("clicking a step's head folds it", page.locator('.anvil-step[data-step-card="2"].folded').count() == 1)
    page.locator('.anvil-step[data-step-card="2"] .step-fold').click()
    check("its button unfolds it", page.locator('.anvil-step[data-step-card="2"].folded').count() == 0)

    # Starting items: hover lights the card, Tab + Enter shows it.
    link = page.locator(".anvil-step:not(.folded) [data-entry-link]").first
    link.scroll_into_view_if_needed() # (under the sticky item bar the results start lower than they did)
    link.hover()
    check("hovering a starting item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    page.mouse.move(0, 0)
    check("moving away clears the outline", page.locator("#books .entry-card.highlight").count() == 0)
    link.focus()
    check("focusing a starting item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    page.keyboard.press("Enter")
    settle(page)
    check("Enter flashes the card", page.locator("#books .entry-card.flash").count() == 1)
    check("a starting item has an accessible name", "section 3" in (link.get_attribute("aria-label") or ""))

    # Screen readers: ticking is announced.
    check("ticking a step is announced", "done" in page.inner_text("#live"), page.inner_text("#live"))

    # Tree: merges fold and unfold; hovering a starting item lights its card.
    page.click('#results [data-view="tree"]')
    nodes_open = page.locator(".tree-node:visible").count()
    page.locator('.tree-line[data-step-card="3"] .step-fold').click()
    check("folding a merge hides its inputs", page.locator(".tree-node:visible").count() < nodes_open)
    page.locator('.tree-line[data-step-card="3"] .step-fold').click()
    check("unfolding brings them back", page.locator(".tree-node:visible").count() == nodes_open)
    page.evaluate("document.activeElement.blur()") # (the unfold button still has the focus, which lights its cards)
    page.mouse.move(0, 0) # (and the pointer is off the merge line just unfolded)
    page.locator(".tree-line:not(.merge)[data-entry-link]").first.hover()
    check("hovering a tree item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    # Printing shows every merge's inputs, even folded ones.
    page.emulate_media(media="print")
    check("print shows a folded merge's inputs", page.locator(".tree-node:visible").count() == page.locator(".tree-node").count())
    page.emulate_media(media="screen")
    page.click('#results [data-view="steps"]')

    # The link with progress: another device (new context) continues from the same ticks.
    ticked = page.locator("input[data-step]:checked").count()
    page.click("#copy-link")
    copied = page.evaluate("navigator.clipboard.readText()")
    check("the link carries progress", "#" in copied and len(copied) > len(base), copied[:60])
    other, page2, errors2 = open_page(browser, base, viewport={"width": 390, "height": 800})
    page2.goto(copied)
    page2.reload()
    page2.wait_for_selector("#results .anvil-step", timeout=8000)
    check("the second device has the same ticks", page2.locator("input[data-step]:checked").count() == ticked,
          (ticked, page2.locator("input[data-step]:checked").count()))
    settle(page2)
    check("once used, the link's progress leaves the address", "t" not in link_data(page2) and "k" not in link_data(page2), link_data(page2))
    page2.locator("#results .step-node:has(input:checked)").last.click()  # the last one: no ticked step needs it
    settle(page2)
    page2.reload()
    page2.wait_for_selector("#results .anvil-step", timeout=8000)
    check("a reload keeps the newer ticks, not the link's", page2.locator("input[data-step]:checked").count() == ticked - 1,
          (ticked, page2.locator("input[data-step]:checked").count()))

    # Ticking the last step flashes the bar once ("level up").
    for number in range(1, total + 1):
        box = page.locator(f'input[data-step="{number}"]')
        if not box.is_checked():
            box.check()
    check("all steps ticked flashes the hotbar", page.locator(".step-hotbar.level-up").count() == 1)

    # Phones: the icons (Steps | Tree, Compact, fold all, Share) share one row, under the progress.
    tops = page2.evaluate("""[...document.querySelectorAll('.result-tools .result-icons :is(.segmented, .icon-btn)')]
        .filter(el => el.offsetParent !== null).map(el => { const box = el.getBoundingClientRect(); return Math.round(box.top + box.height / 2); })""")
    check("on a phone the tools share one row", len(tops) == 4 and max(tops) - min(tops) <= 2, tops)
    overflow = page2.evaluate("document.documentElement.scrollWidth > innerWidth")
    check("a phone has no sideways scroll", not overflow)

    # Dark theme and 320px width: nothing overflows.
    page2.click("#theme")
    small, page3, errors3 = open_page(browser, base, viewport={"width": 320, "height": 700})
    page3.goto(copied)
    page3.reload()
    page3.wait_for_selector("#results .anvil-step", timeout=8000)
    check("320px has no sideways scroll", not page3.evaluate("document.documentElement.scrollWidth > innerWidth"))

    # Start over: one click clears the setup and bring the first screen back; saved setups stay.
    page.evaluate("localStorage.setItem('enchantment-calculator-saved', JSON.stringify([{name: 'Keep', item: 'sword', link: 'x'}]))")
    # ...and the Settings menu's: a game rule (Bedrock) and a Display one (descriptions Always).
    page.evaluate("window.scrollTo(0, 0)")
    page.click("#options-menu > summary")
    page.click('[data-focus="edition-bedrock"]')
    page.click('[data-focus="descriptions-always"]')
    page.click("#options-menu > summary")
    page.evaluate("localStorage.setItem('enchantment-calculator-theme', JSON.stringify('light'))")
    settle(page)
    page.wait_for_selector("#item .item-foot .reset-button", state="visible")
    with page.expect_navigation():
        page.click("#item .item-foot .reset-button")
    page.wait_for_selector("#wanted .intro")
    check("Start over brings the first screen back", page.locator("#wanted .intro").count() == 1)
    check("Start over keeps saved setups", "Keep" in (page.evaluate("localStorage.getItem('enchantment-calculator-saved')") or ""))
    check("Start over clears the ticks", page.evaluate("localStorage.getItem('enchantment-calculator-checklist')") is None)
    check("Start over keeps the Dark/Light theme", page.evaluate("document.documentElement.dataset.theme") == "light")
    page.click("#options-menu > summary")
    check("Start over keeps the Settings menu: the game rules (Bedrock) and Display (descriptions Always)",
          page.get_attribute('[data-focus="edition-bedrock"]', "aria-pressed") == "true" and page.get_attribute('[data-focus="descriptions-always"]', "aria-pressed") == "true")
    page.click("#options-menu > summary")
    return errors + errors2 + errors3


def part_section1(browser, base):
    """section 1: aligned rows, the item menu, swaps and bar rolls"""
    # Section 1: aligned rows, descriptions, the x on a chosen row, the item menu on the slot.
    sec, page6, errors6 = open_page(browser, base, viewport={"width": 1280, "height": 900})
    page6.click('#wanted .item-grid button[data-focus="item-sword"]')
    choose_max(page6)
    page6.wait_for_selector("#wanted .ench-row.chosen")
    rights = page6.evaluate("[...document.querySelectorAll('#wanted .ench-row .level-bar')].map(b => Math.round(b.getBoundingClientRect().right))")
    check("every level bar ends at the same x", len(set(rights)) == 1, rights)
    check("rows describe their enchantment", page6.locator("#wanted .ench-desc").count() >= 5)
    check("chosen rows glint", page6.evaluate("getComputedStyle(document.querySelector('#wanted .ench-row.chosen'), '::after').animationName") == "row-glint")
    chosen_before = page6.locator("#wanted .ench-row.chosen").count()
    page6.locator("#wanted .ench-row.chosen .ench-clear").first.click()
    settle(page6) # a cleared row closes, as a copy, before it is gone
    check("the × clears one enchantment", page6.locator("#wanted .ench-row.chosen").count() == chosen_before - 1)
    page6.evaluate("scrollTo(0, 0)")  # (scrolled down, the sticky Item bar condenses to one line and hides the presets)
    page6.locator('#wanted [data-focus="wanted-clear-all"]').wait_for(state="visible")
    clear_all(page6)
    settle(page6)
    check("Remove all clears every enchantment", page6.locator("#wanted .ench-row.chosen").count() == 0)
    check("with nothing chosen the Levels line has folded away", page6.locator("#item .wanted-preview .cost-line:not(.idle)").count() == 0 and page6.locator("#item .wanted-preview .cost-line").evaluate("l => l.textContent.trim()") == "")
    check("and is disabled while nothing is chosen", page6.locator('#wanted [data-focus="wanted-clear-all"]').is_disabled())

    # Swapping Protection for Projectile Protection: the old line is covered from the right
    # (a copy, without data-ns) while the new one is uncovered; the copy is gone afterwards.
    page6.click("#item .item-menu-button")
    page6.click('#items button[data-focus="item-helmet"]')
    page6.click('#wanted button[data-focus$="-protection"]')
    settle(page6)
    page6.click('#wanted button[data-focus$="-projectile_protection"]')
    mid_copy = page6.locator("#item .mc-tooltip .mc-ench:not([data-ns])").count()
    settle(page6)
    check("a swapped line leaves a copy while it is covered, then none",
          mid_copy == 1 and page6.locator("#item .mc-tooltip .mc-ench:not([data-ns])").count() == 0, mid_copy)

    # Switching Depth Strider (III) for Frost Walker (II) rolls the bar: a copy of the lost
    # segment is there mid-roll, and gone afterwards.
    page6.click('#item .item-menu-button')
    page6.click('#items button[data-focus="item-boots"]')
    page6.click('#wanted .group-switch button:has-text("Depth Strider")')
    settle(page6)
    page6.click('#wanted .group-switch button:has-text("Frost Walker")')
    mid = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > .level-seg").count()
    settle(page6)
    after = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > .level-seg").count()
    check("a shrinking bar rolls its lost segment away", mid == 3 and after == 2, (mid, after))
    page6.click("#item .item-menu-button")
    check("the slot opens the item menu", page6.locator("#item-menu").count() == 1)
    page6.keyboard.press("Escape")
    check("the item menu closes again", page6.locator("#item-menu").count() == 0)
    return errors6


def part_item_bar(browser, base):
    """the phone's condensed Item bar: Start over at its left, the bar itself back to the top, and Steps down to Anvil uses"""
    _, p, errors = open_page(browser, base, viewport={"width": 390, "height": 800})
    p.click("#wanted .example")
    settle(p)
    p.evaluate("scrollTo(0, 900)")
    p.wait_for_selector("#item-dock.condensed")
    # (Anvil uses closed first: the Steps button opens it before it scrolls there)
    p.evaluate("scrollTo(0, 0)")
    p.click('[data-section="steps"] .collapse-toggle')
    settle(p)
    p.evaluate("scrollTo(0, 900)")
    p.wait_for_selector("#item-dock.condensed")
    check("the condensed bar has a Steps button", p.locator("#item .item-mini-row > .mini-steps").is_visible())
    p.click("#item .item-mini-row > .mini-steps")
    p.wait_for_function("Math.abs(document.querySelector('[data-section=\"steps\"]').getBoundingClientRect().top - document.querySelector('#item .item-mini').getBoundingClientRect().bottom) < 40")
    check("Steps scrolls to Anvil uses, just under the bar", p.locator('[data-section="steps"]').bounding_box()["y"] > 0)
    check("and Anvil uses is open, its steps showing", not p.evaluate("document.querySelector('[data-section=steps]').classList.contains('collapsed')") and p.locator("#results .anvil-step").first.is_visible())
    p.click("#item .item-mini")
    p.wait_for_function("scrollY === 0")
    check("the bar itself goes back to the top", p.evaluate("scrollY") == 0)
    _, n, errs = open_page(browser, base, viewport={"width": 320, "height": 700})
    errors += errs
    n.click("#wanted .example")
    settle(n)
    n.evaluate("scrollTo(0, 900)")
    n.wait_for_selector("#item-dock.condensed")
    overlap = n.evaluate("""(() => { const a = document.querySelector('#item .mini-text').getBoundingClientRect(), b = document.querySelector('#item .item-mini-row > .mini-steps').getBoundingClientRect(); return a.right > b.left + 1; })()""")
    check("at 320px the bar's text never runs into the Steps button", not overlap and not n.evaluate("document.documentElement.scrollWidth > innerWidth"))
    # On paper the item is the full card in the flow, even when the phone's screen was showing the condensed sticky bar.
    n.emulate_media(media="print")
    printed = n.evaluate("(() => { const d = document.querySelector('#item-dock'); return [getComputedStyle(d).position, getComputedStyle(document.querySelector('#item .wanted-head')).display !== 'none', getComputedStyle(document.querySelector('#item .item-mini')).display]; })()")
    check("printing from a phone shows the full Item card, not the sticky condensed bar", printed == ["static", True, "none"], printed)
    n.emulate_media(media="screen")
    # Try an example is under the long item grid: the page is already scrolled when the item appears, so the bar must condense then too.
    _, e, errs = open_page(browser, base, viewport={"width": 1100, "height": 700})
    errors += errs
    e.evaluate("""window.bar_flash = 0; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1)
        for (const bar of [n, ...n.querySelectorAll('.current-bar')]) if (bar.matches('.current-bar') && !bar.classList.contains('tucked')) bar_flash++; }).observe(document.body, { childList: true, subtree: true });""")
    e.locator("#wanted .example").scroll_into_view_if_needed()
    e.click("#wanted .example")
    settle(e)
    shown = e.evaluate("document.querySelector('.dock-sentinel').getBoundingClientRect().bottom > 0")
    check("picking the example while scrolled down condenses the bar", shown or e.locator("#item-dock.condensed").count() == 1, shown)
    check("a finished search never flashes the Next step card (it starts tucked)", e.evaluate("bar_flash") == 0, e.evaluate("bar_flash"))
    return errors


def part_rerun(browser, base):
    """when the search runs again: only when what it is given changes (Automatic -> Custom, reordering cards: no; an edit: yes)"""
    _, p, errors = open_page(browser, base, viewport={"width": 1280, "height": 900})
    p.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p)
    p.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p)
    p.evaluate("""window.__searches = 0; new MutationObserver(() => { if (document.documentElement.dataset.search === 'running') window.__searches++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-search'] })""")
    searches = lambda: p.evaluate("window.__searches")
    levels = p.inner_text("#order-levels")
    p.click("#books .mode-switch >> text=Custom")
    settle(p)
    check("Automatic -> Custom keeps the order without searching (the same books)", searches() == 0 and p.inner_text("#order-levels") == levels, (searches(), levels, p.inner_text("#order-levels")))
    p.locator("#books .entry-card .drag-handle").first.focus()
    p.keyboard.press("ArrowDown")
    settle(p)
    check("reordering the cards doesn't search either", searches() == 0, searches())
    p.locator("#books .entry-card .entry-remove").last.click()
    settle(p)
    check("removing a book searches again", searches() == 1, searches())
    p.click("#books .mode-switch >> text=Automatic")
    settle(p)
    check("Custom (edited) -> Automatic searches again", searches() == 2, searches())
    return errors


def part_books(browser, base):
    """section 2: automatic and Custom cards, coverage chips, copies, prior work, the merge preview"""
    # Everything else once, so a broken import or typo anywhere shows up as a page error.
    wide, page4, errors4 = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page4.click('#wanted .item-grid button[data-focus="item-sword"]')
    choose_max(page4)
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    # Automatic mode: dragging a slot onto another entry previews the merge too.
    page4.locator("#books .entry-card").nth(1).scroll_into_view_if_needed()
    asrc = page4.locator("#books .entry-card").nth(1).locator(".mc-slot").bounding_box()
    adst = page4.locator("#books .entry-card").nth(2).bounding_box()
    page4.mouse.move(asrc["x"] + 10, asrc["y"] + 10)
    page4.mouse.down()
    page4.mouse.move(asrc["x"] + 30, asrc["y"] + 30, steps=4)
    page4.mouse.move(adst["x"] + adst["width"] / 2, adst["y"] + adst["height"] / 2, steps=6)
    page4.wait_for_function("document.querySelector('.merge-chip') && document.querySelector('.merge-chip').textContent.length > 2", timeout=5000)
    check("the merge preview also works in Automatic mode", page4.locator("#books .entry-card.merge-target").count() == 1)
    page4.mouse.up()
    settle(page4)
    page4.click('#books >> text=Custom')
    # Books and items, Custom: copies and prior work show only when set, "+" sits in the name
    # row, the reached enchantments fold into one chip, and the add area spans the grid.
    cards = page4.locator("#books .entry-card").count()
    check("badges are hidden while copies and prior work are the default", page4.locator("#books .entry-badge").count() == 0)
    check("each entry has a quiet more button", page4.locator("#books .entry-more").count() == cards, cards)
    check("an entry with enchantments adds from a + in its name row", page4.locator("#books .entry-add-plus").count() >= 1)
    check("the slot says it switches", page4.locator("#books .entry-slot .swap-glyph").count() == cards)
    check("the reached enchantments fold into one chip", page4.locator("#books .cover-chip.summary").count() == 1 and page4.locator("#books .cover-chip.ok:not(.summary)").count() == 0)
    page4.click("#books .cover-chip.summary")
    check("the folded chip opens the list", page4.locator("#books .cover-chip.ok:not(.summary)").count() >= 3)
    page4.click("#books .cover-chip.summary")
    grid_width = page4.evaluate("document.querySelector('#books .entry-grid').getBoundingClientRect().width")
    add_width = page4.evaluate("document.querySelector('#books .entry-add-card').getBoundingClientRect().width")
    check("the add area spans the whole grid", abs(grid_width - add_width) < 2, (grid_width, add_width))
    slot_box = page4.evaluate("(() => { const c = document.querySelector('#books .entry-card'); const s = c.querySelector('.mc-slot').getBoundingClientRect(); const t = c.querySelector('.mc-tooltip').getBoundingClientRect(); return [s.right <= t.left + 1, s.top]; })()")
    check("the slot sits beside the tooltip", slot_box[0])
    # Copies: − and + on the slot's corner (and the wheel changes it); prior work: the anvil track.
    page4.locator("#books .entry-card").first.hover()
    page4.locator('#books .copies-step[data-focus$="-plus"]').first.click()
    check("a copy count shows on the slot", page4.locator("#books .copies-control.has").count() == 1 and page4.locator("#books .stack-count").first.inner_text() == "2")
    page4.locator('#books .copies-step[data-focus$="-minus"]').first.click()
    settle(page4)
    page4.locator("#books .copies-control").first.hover()
    page4.mouse.wheel(0, -100)
    page4.locator("#books .copies-control.has").first.wait_for(timeout=3000) if page4.locator("#books .copies-control.has").count() == 0 else None  # (the wheel is handled a frame later under load)
    settle(page4)
    check("the wheel over the slot corner adds a copy", page4.locator("#books .copies-control.has").count() == 1)
    page4.locator("#books .copies-control").first.hover()
    page4.mouse.wheel(0, 100)
    settle(page4)
    page4.locator("#books .entry-more").first.click(force=True)
    page4.locator("#books .anvil-pip:not(.zero)").nth(1).click()
    page4.locator("#books .anvil-pip.zero").click()
    pips = page4.locator("#books .anvil-pip:not(.zero)")
    p1, p3 = pips.nth(0).bounding_box(), pips.nth(2).bounding_box()
    page4.mouse.move(p1["x"] + 5, p1["y"] + 5)
    page4.mouse.down()
    page4.mouse.move(p3["x"] + 5, p3["y"] + 5, steps=6)
    page4.mouse.up()
    settle(page4)
    check("dragging across the anvils sets prior work", page4.locator("#books .anvil-pip.on").count() == 3, page4.locator("#books .anvil-pip.on").count())
    check("prior work shows as a badge", page4.locator("#books .entry-badge").count() == 1)
    page4.locator("#books .anvil-pip.zero").click()
    page4.keyboard.press("Escape")
    check("back at the default the badge and stack count go", page4.locator("#books .entry-badge").count() == 0 and page4.locator("#books .copies-control.has").count() == 0)
    # Dragging a slot onto another entry previews the merge.
    src = page4.locator("#books .entry-card").nth(1).locator(".entry-slot")
    dst = page4.locator("#books .entry-card").nth(2)
    dst.scroll_into_view_if_needed()
    page4.evaluate("scrollBy(0, 120)") # the card's centre must be on screen: the order, not the books, is what fills the view now
    sb, db = src.bounding_box(), dst.bounding_box()
    page4.mouse.move(sb["x"] + 10, sb["y"] + 10)
    page4.mouse.down()
    page4.mouse.move(sb["x"] + 30, sb["y"] + 30, steps=4)
    page4.mouse.move(db["x"] + db["width"] / 2, db["y"] + db["height"] / 2, steps=6)
    page4.wait_for_selector("#books .entry-card.merge-target")
    page4.wait_for_function("document.querySelector('.merge-chip') && /level|Too|merge/i.test(document.querySelector('.merge-chip').textContent)", timeout=5000)
    check("dragging a slot over another entry shows the merge", "level" in page4.inner_text(".merge-chip").lower() or "expensive" in page4.inner_text(".merge-chip").lower(), page4.inner_text(".merge-chip"))
    page4.mouse.up()
    settle(page4)
    check("the merge preview changes nothing", page4.locator("#books .entry-card").count() == cards)
    return errors4


def part_books_views(browser, base):
    """section 2's three views: the switch animation, the slots view, reordering slots (motion on)"""
    wide, page4, errors4 = open_page(browser, base, viewport={"width": 1280, "height": 900})
    page4.click('#wanted .item-grid button[data-focus="item-sword"]')
    choose_max(page4)
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    page4.click('#books >> text=Custom')
    settle(page4)
    cards = page4.locator("#books .entry-card").count()
    # Switching views: tooltips that rest hidden never flash, every slot travels on its own, and nothing is left behind.
    page4.mouse.move(0, 0)
    result = scrub(page4, """document.querySelector('#books [data-focus="view-slots"]').click();
        return [...document.querySelectorAll('#books .slotcell .slot-cell-button')].filter(unit => unit.getAnimations().some(a => a.effect.getKeyframes().some(k => k.transform && k.transform !== 'none'))).length;""",
                "Math.max(0, ...[...document.querySelectorAll('#books .slot-tip')].map(tip => +getComputedStyle(tip).opacity))", 30)
    flash = {"worst": max(result["values"]), "moving": result["acted"]}
    check("switching to Slots never flashes the tooltips", flash["worst"] == 0, flash)
    check("each slot travels to its new place", flash["moving"] >= cards - 1, flash)
    check("a view switch leaves no frames or copies behind", page4.locator("#books .card-frame, #books .card-ghost, #books .morphing").count() == 0)
    for view in ("list", "cards", "list", "slots", "cards"):
        page4.click('#books [data-focus="view-%s"]' % view)
        page4.wait_for_timeout(120)  # (on purpose: the next click lands while the last switch is still sliding)
    settle(page4)
    check("switching views quickly lands on the last one cleanly", page4.locator("#books .entry-card:not(.compact):not(.slotcell)").count() >= cards and page4.locator("#books .card-frame, #books .card-ghost").count() == 0)
    # The slots view.
    page4.click('#books [data-focus="view-slots"]')
    settle(page4)
    check("the slots view shows one slot per entry", page4.locator("#books .entry-card.slotcell").count() == cards)
    page4.locator("#books .entry-card.slotcell").nth(1).hover()
    settle(page4)
    check("a slot's tooltip shows on hover", page4.evaluate("getComputedStyle(document.querySelectorAll('#books .slot-tip')[1]).opacity") == "1")
    page4.locator("#books .slot-cell-button").nth(1).click()
    check("a slot opens its picker", page4.locator("#books .entry-popover.enchant").count() == 1)
    page4.click('#books [data-focus^="pick-type-"]')
    check("the slots view can switch a slot between book and item", page4.locator("#books .entry-card.slotcell").nth(1).locator('img[src*="book"]').count() == 0)
    page4.click('#books [data-focus^="pick-type-"]')
    # Reordering in the slots view: the grip of one slot dropped on another.
    page4.keyboard.press("Escape")
    before = page4.locator("#books .slot-tip").nth(1).inner_text()
    page4.locator("#books .entry-card.slotcell").nth(1).hover()
    grip = page4.locator("#books .entry-card.slotcell").nth(1).locator(".drag-handle").bounding_box()
    to = page4.locator("#books .entry-card.slotcell").nth(3).bounding_box()
    page4.mouse.move(grip["x"] + 6, grip["y"] + 6)
    page4.mouse.down()
    page4.mouse.move(to["x"] + 20, to["y"] + 20, steps=8)
    page4.mouse.up()
    settle(page4)
    check("dragging a slot's grip reorders the slots", page4.locator("#books .slot-tip").nth(3).inner_text() == before, before)
    page4.keyboard.press("Escape")
    page4.click('#books [data-focus="view-cards"]')
    settle(page4)
    page4.click('#books [data-focus="view-list"]')
    check("the list view keeps one row per entry", page4.locator("#books .entry-card.compact").count() >= cards)
    # Automatic <-> Custom with motion on (Custom cards to the shelf of slots and back): it settles with every entry visible and nothing left over.
    page4.click("#books .mode-switch >> text=Automatic")
    settle(page4)
    page4.click("#books .mode-switch >> text=Custom")
    settle(page4)
    page4.click("#books .mode-switch >> text=Automatic")
    settle(page4)
    left = page4.evaluate("[document.querySelectorAll('#books .card-ghost, #books .card-frame, #books .view-overlay').length, [...document.querySelectorAll('#books .shelf .slotcell')].filter(card => getComputedStyle(card).opacity !== '1').length]")
    check("Automatic <-> Custom settles on the shelf with every slot shown and no copies left behind", left == [0, 0] and page4.locator("#books .shelf .slotcell").count() == cards, left)
    return errors4


def part_books_tail(browser, base):
    """section 2's add area and the page's menus: Add book, a typed book, the limit, a saved setup, Bedrock, theme, collapsing, copy, language"""
    wide, page4, errors4 = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page4.click('#wanted .item-grid button[data-focus="item-sword"]')
    choose_max(page4)
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    page4.click('#books >> text=Custom')
    settle(page4)
    page4.click('#books >> text=Add book')
    page4.keyboard.press("Escape")
    page4.fill('#books input[placeholder^="Type a book"]', "unbreaking 3")
    page4.keyboard.press("Enter")
    page4.click('#books button[aria-label^="Remove entry 1"]')
    settle(page4)
    page4.click("#options-menu summary")
    page4.locator("#limit-panel input[type=range]").fill("30")
    page4.keyboard.press("Escape")
    settle(page4)
    levels_before = page4.inner_text("#order-levels")
    page4.evaluate("""window.__searches = 0; new MutationObserver(() => { if (document.documentElement.dataset.search !== 'idle') window.__searches++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-search'] })""")
    page4.fill("#item .anvil-name-input", "Excalibur")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    frames(page4)
    check("starting a rename adds its level to the last step without searching again", page4.evaluate("window.__searches") == 0 and page4.inner_text("#order-levels") != levels_before, (page4.evaluate("window.__searches"), levels_before, page4.inner_text("#order-levels")))
    check("typing a name renames the item's preview at once (in italics), as the results' tooltips", page4.inner_text("#item .wanted-preview .mc-tooltip > :first-child") == "Excalibur" and "renamed" in page4.get_attribute("#item .wanted-preview .mc-tooltip > :first-child", "class"))
    # Saved setups are presets of your own: + Save in the item card's presets row saves under a name, a star chip lists it, × removes it.
    check("a new visitor starts with a God preset for the item, every enchantment at max", page4.locator("#item .saved-chip .preset.mine", has_text="God").count() == 1)
    # Every enchantment at max is what God already holds: saving it again, under any name, is refused and the box names the preset that has it.
    page4.click('#item [data-focus="saved-add"]')
    page4.fill("#item .saved-form input[type=text]", "Smoke")
    page4.click("#item .saved-form button[type=submit]")
    check("saving a setup that is already saved is refused, naming the preset that holds it", "God" in (page4.inner_text("#item .saved-form-error") if page4.locator("#item .saved-form-error:not([hidden])").count() else "") and page4.locator("#item .saved-chip", has_text="Smoke").count() == 0)
    page4.keyboard.press("Escape")
    page4.click('#item .saved-chip-x[aria-label="Remove God"]')
    page4.click('#item [data-focus="saved-add"]')
    page4.fill("#item .saved-form input[type=text]", "Smoke")
    page4.click("#item .saved-form button[type=submit]")
    check("a saved setup shows as a star chip among the presets", page4.locator("#item .saved-chip .preset.mine", has_text="Smoke").count() == 1)
    check("the header has no Saved menu any more", page4.locator("#saved").count() == 0)
    # One item's preset names are all different (ignoring case): the same name again is refused and the box says so; another item may use it.
    page4.click('#item [data-focus="saved-add"]')
    page4.fill("#item .saved-form input[type=text]", "smoke")
    page4.click("#item .saved-form button[type=submit]")
    check("a name this item already has is refused, and the box says so", page4.locator("#item .saved-form-error:not([hidden])").count() == 1 and page4.locator("#item .saved-chip", has_text="Smoke").count() == 1)
    page4.keyboard.press("Escape")
    # The header's Presets menu lists every saved preset, for any item; choosing one loads it and closes the menu.
    clear_all(page4)
    page4.click("#presets-menu > summary")
    check("the Presets menu groups the saved presets by item, each group folded at first", page4.locator("#presets-panel .presets-menu-item").count() >= 1 and page4.locator("#presets-panel .saved-load").count() == 0 and page4.locator('#presets-panel .presets-menu-item[aria-expanded="true"]').count() == 0)
    # Opening a group near the bottom keeps the list where it was scrolled (the menu redraws).
    kept = page4.evaluate("""(() => { const list = document.querySelector('#presets-panel .presets-menu-groups'); list.scrollTop = 1e6; const before = list.scrollTop;
        [...document.querySelectorAll('#presets-panel .presets-menu-item')].pop().click();
        return [before, document.querySelector('#presets-panel .presets-menu-groups').scrollTop]; })()""")
    check("opening a group near the bottom of the Presets menu doesn't send the list back to the top", kept[0] > 0 and kept[1] >= kept[0] - 1, kept)
    page4.evaluate("[...document.querySelectorAll('#presets-panel .presets-menu-item')].pop().click()")
    # Opening a group that runs past the bottom of the list scrolls it just far enough to show the group's last preset.
    shown = page4.evaluate("""(() => { const list = document.querySelector('#presets-panel .presets-menu-groups'); list.scrollTop = 0;
        [...document.querySelectorAll('#presets-panel .presets-menu-item')].pop().click();
        const box = document.querySelector('#presets-panel .presets-menu-groups').getBoundingClientRect();
        const group = [...document.querySelectorAll('#presets-panel .presets-menu-group')].pop().getBoundingClientRect();
        return [Math.round(group.bottom - box.bottom), Math.round(group.top - box.top)]; })()""")
    check("opening a group below the fold scrolls the menu just enough to show its last preset", abs(shown[0]) <= 1 and shown[1] > 0, shown)
    page4.evaluate("[...document.querySelectorAll('#presets-panel .presets-menu-item')].pop().click()")
    page4.evaluate("document.querySelector('#presets-panel .presets-menu-groups').scrollTop = 0")
    check("the Presets menu's groups are in alphabetical order", page4.evaluate("(() => { const names = [...document.querySelectorAll('#presets-panel .presets-menu-item')].map(b => b.textContent.replace(/\\d+$/, '')); return names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'); })()"))
    page4.click('#presets-panel [data-focus="menu-item-%s"]' % link_data(page4)["i"])
    check("opening a group lists its presets", page4.locator("#presets-panel .saved-load", has_text="Smoke").count() == 1)
    page4.click("#presets-panel .saved-load >> text=Smoke")
    check("choosing one there loads it and closes the menu", not page4.evaluate("document.querySelector('#presets-menu').open") and len(link_data(page4).get("w") or {}) > 0)
    page4.click('#item .saved-chip-x[aria-label="Remove Smoke"]')
    check("x removes it", page4.locator("#item .saved-chip", has_text="Smoke").count() == 0)
    page4.click("#order-toggle")
    page4.click("#rank-help")
    page4.click("#options-menu summary")
    page4.click("#limit-panel .edition-switch >> text=Bedrock")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    page4.click("#limit-panel .edition-switch >> text=Java")
    page4.keyboard.press("Escape")
    page4.click("#theme")
    check("the theme button sets a theme", page4.evaluate("document.documentElement.dataset.theme") in ("dark", "light"))
    page4.click('[data-section="wanted"] .collapse-toggle')
    page4.click('[data-section="wanted"] .collapse-toggle')
    page4.click("#copy-link")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(page4) # a result arriving would redraw (and close) the menu
    page4.click("#results .share-menu summary")
    page4.click(".copy-steps")
    page4.click("#language .language-button")
    check("the language panel opens with Suggested first", page4.inner_text("#language .language-heading") == "SUGGESTED" or page4.inner_text("#language .language-heading").lower() == "suggested")
    page4.fill("#language .language-search", "english")
    names = page4.eval_on_selector_all("#language .language-name", "els => els.map(e => e.textContent)")
    check("searching english also finds Pirate Speak and the variants", "Pirate Speak" in names and "English (UK)" in names and "Anglish" in names, names)
    page4.fill("#language .language-search", "spanish")
    check("an English name finds the language's own", "Español" in page4.eval_on_selector_all("#language .language-name", "els => els.map(e => e.textContent)"))
    page4.fill("#language .language-search", "")
    page4.click("#language .language-chip.confidence-1")
    check("a chip keeps the panel open and lists only that confidence", page4.is_visible("#language .language-panel") and page4.eval_on_selector_all("#language .language-row", "els => els.length > 0 && els.every(e => e.classList.contains('confidence-1'))"))
    page4.keyboard.press("Escape")
    check("Escape closes the language panel", not page4.is_visible("#language .language-panel"))
    page4.click("#language .language-button")
    page4.fill("#language .language-search", "es_es")
    page4.click('#language .language-row[data-code="es_es"]')
    page4.wait_for_function("document.documentElement.lang === 'es-ES'")
    check("Spanish changes the heading", "encantamientos" in page4.inner_text("h1").lower(), page4.inner_text("h1"))
    page4.click("#language .language-button")
    page4.click('#language .language-row[data-code="en_us"]')
    page4.wait_for_function("document.documentElement.lang === 'en-US'")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    return errors4


def drag_to(page, source, target, grab=(0.5, 0.5), drop=(0.5, 0.5), release=True):
    """A mouse drag from one box (a Playwright bounding box) to another's `drop` point; the first move past 6px starts the drag.
    With release=False the button stays down (so the target's look can be checked), and the caller ends it with page.mouse.up()."""
    start = (source["x"] + source["width"] * grab[0], source["y"] + source["height"] * grab[1])
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + 14, start[1] + 14, steps=4)
    page.mouse.move(target["x"] + target["width"] * drop[0], target["y"] + target["height"] * drop[1], steps=8)
    if release:
        page.mouse.up()
        settle(page)


def empty_custom_helmet(page, picks):
    """A Helmet with nothing chosen but `picks` (namespace -> level), Custom books, and every entry removed, so the coverage chips are all amber."""
    page.click('#wanted .item-grid button[data-focus="item-helmet"]')
    clear_all(page)
    settle(page)
    for ns, level in picks.items():
        if ns == "protection":  # (one of a Pick one group: its switch chooses it at its top level)
            page.click('#wanted button[data-focus$="-protection"]')
        else:
            page.locator('[data-focus="bar-%s"] .level-seg' % ns).nth(level - 1).click()
    page.click('[data-focus="mode-custom"]')
    settle(page)
    while page.locator("#books .entry-card").count():
        page.click('#books button[aria-label^="Remove entry 1"]')
        settle(page)


LINES_BY_CARD = "cards => cards.map(c => [...c.querySelectorAll('.entry-line')].map(x => x.dataset.ns).sort().join())"


def part_typed_lines(browser, base):
    """section 2's type box (typed books, what it skips) and dragging a tooltip line between cards"""
    _, p, errors = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    empty_custom_helmet(p, {"mending": 1, "unbreaking": 3, "protection": 4})
    box = '#books input[placeholder^="Type a book"]'
    cards = lambda: p.locator("#books .entry-card").count()
    # The type box: one book of every typed enchantment; what it can't use stays in the box with a note.
    p.fill(box, "prot 4, mending")
    p.keyboard.press("Enter")
    settle(p)
    lines = p.eval_on_selector_all("#books .entry-card .entry-line", "e => e.map(x => x.dataset.ns + ' ' + x.dataset.level)")
    check("a typed 'prot 4, mending' is one book with both enchantments", cards() == 1 and sorted(lines) == ["mending 1", "protection 4"], lines)
    check("and the box is empty again", p.input_value(box) == "" and p.locator("#books .type-note").count() == 0)
    p.fill(box, "zzzz")
    p.keyboard.press("Enter")
    settle(p)
    check("a word that is no enchantment adds nothing, stays in the box and says so", cards() == 1 and p.input_value(box) == "zzzz" and p.locator("#books .type-note").count() == 1, p.locator("#books .type-note").all_inner_texts())
    p.fill(box, "fire protection 4")
    p.keyboard.press("Enter")
    settle(p)
    check("an enchantment that conflicts with one already on the books is refused with a note", cards() == 1 and p.input_value(box) == "fire protection 4" and "Fire Protection" in p.inner_text("#books .type-note"), p.locator("#books .type-note").all_inner_texts())
    p.fill(box, "unbreaking 3")
    p.keyboard.press("Enter")
    settle(p)
    check("a second typed book is a second card", cards() == 2)
    # Dragging a tooltip line onto another card moves the enchantment.
    line = p.locator("#books .entry-card").nth(0).locator('.entry-line[data-ns="mending"]')
    drag_to(p, line.bounding_box(), p.locator("#books .entry-card").nth(1).bounding_box(), release=False)
    check("dragging a line over a card that can take it outlines the card", p.locator("#books .entry-card.drop-ok").count() == 1 and p.locator("body > .line-ghost").count() == 1)
    p.mouse.up()
    settle(p)
    moved = p.eval_on_selector_all("#books .entry-card", LINES_BY_CARD)
    check("dropping it moves the enchantment and leaves the other card as it was", moved == ["protection", "mending,unbreaking"], moved)
    check("a drag leaves no ghost or outline behind", p.locator(".line-ghost, #books .drop-ok, #books .drop-no, #books .drag-source").count() == 0)
    # Escape in the middle of a drag moves nothing.
    line = p.locator("#books .entry-card").nth(1).locator('.entry-line[data-ns="mending"]')
    drag_to(p, line.bounding_box(), p.locator("#books .entry-card").nth(0).bounding_box(), release=False)
    p.keyboard.press("Escape")
    p.mouse.up()
    settle(p)
    moved = p.eval_on_selector_all("#books .entry-card", LINES_BY_CARD)
    check("Escape ends a line drag with nothing moved", moved == ["protection", "mending,unbreaking"], moved)
    # Copies: "x3" in the type box, and the add bar's copies box.
    stacks = lambda: p.eval_on_selector_all("#books .entry-card .stack-count", "e => e.map(x => x.textContent)")
    p.fill(box, "respiration 3, x3")
    p.keyboard.press("Enter")
    settle(p)
    check("'x3' in the type box makes the typed book three copies", cards() == 3 and stacks() == ["3"] and p.input_value(box) == "", stacks())
    p.fill(box, "4x aqua affinity")
    p.keyboard.press("Enter")
    settle(p)
    check("'4x' before a name works too", cards() == 4 and sorted(stacks()) == ["3", "4"], stacks())
    p.fill(box, "aqua affinity x2")
    p.keyboard.press("Enter")
    settle(p)
    check("a typed book identical to one on the books adds its copies to that one", cards() == 4 and sorted(stacks()) == ["3", "6"], stacks())

    return errors


def part_chip_drag(browser, base):
    """dragging a coverage chip onto a card, a card that conflicts, and the add bar"""
    _, q, errors = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    box = '#books input[placeholder^="Type a book"]'
    empty_custom_helmet(q, {"mending": 1, "unbreaking": 3, "protection": 4})
    for text in ("fire protection 4", "thorns 1"):
        q.fill(box, text)
        q.keyboard.press("Enter")
        settle(q)
    chip = lambda ns: q.locator('#books .cover-chip.short[data-ns="%s"]' % ns)
    card_with = lambda ns: q.locator("#books .entry-card", has=q.locator('.entry-line[data-ns="%s"]' % ns))
    lines_of = lambda ns: q.eval_on_selector_all('#books .entry-card:has(.entry-line[data-ns="%s"]) .entry-line' % ns, "e => e.map(x => x.dataset.ns + ' ' + x.dataset.level).sort()")
    check("with a fire protection and a thorns book, Mending, Unbreaking and Protection are amber chips", chip("mending").count() == 1 and chip("unbreaking").count() == 1 and chip("protection").count() == 1)
    drag_to(q, chip("protection").bounding_box(), card_with("thorns").bounding_box(), release=False)
    check("a chip over a card is outlined as refused when another card holds a conflict", q.locator("#books .entry-card.drop-no").count() == 1 and q.locator("#books .entry-card.drop-ok").count() == 0)
    q.mouse.up()
    settle(q)
    check("and dropping it there adds nothing", lines_of("thorns") == ["thorns 1"] and chip("protection").count() == 1)
    drag_to(q, chip("protection").bounding_box(), card_with("fire_protection").bounding_box(), release=False)
    check("over the card that holds the conflict it is outlined as fine", q.locator("#books .entry-card.drop-ok").count() == 1)
    q.mouse.up()
    settle(q)
    check("and dropping it there replaces the conflicting enchantment", lines_of("protection") == ["protection 4"] and chip("protection").count() == 0)
    drag_to(q, chip("mending").bounding_box(), q.locator("#books .entry-add-card").bounding_box(), release=False)
    check("a chip over the add bar outlines it", q.locator("#books .entry-add-card.drop-ok").count() == 1)
    q.mouse.up()
    settle(q)
    check("dropping it there makes a new book with that enchantment", q.locator("#books .entry-card").count() == 3 and lines_of("mending") == ["mending 1"] and chip("mending").count() == 0)
    drag_to(q, chip("unbreaking").bounding_box(), card_with("thorns").bounding_box())
    check("dropping a chip on a card puts that enchantment on it, at the chosen level", q.locator("#books .entry-card").count() == 3 and lines_of("thorns") == ["thorns 1", "unbreaking 3"] and chip("unbreaking").count() == 0, lines_of("thorns"))
    return errors


def part_controls(browser, base):
    """the preset compare tooltip, the rename field (badge, count, cut length per edition), the typed level limit and the infinity button"""
    _, p, errors = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p.click('#wanted .item-grid button[data-focus="item-helmet"]')
    # (the starter God preset: every enchantment at max)
    settle(p)
    preset = p.locator("#item .preset.mine", has_text="God").first
    preset.hover()
    added = p.locator(".compare-tip .mc-ench.changed").count()
    check("hovering a preset shows what it adds, as a tooltip", p.locator(".compare-tip").count() == 1 and added >= 3 and p.locator(".compare-tip .mc-ench.removed").count() == 0, added)
    p.mouse.move(0, 0)
    check("it goes when the pointer leaves", p.locator(".compare-tip").count() == 0)
    preset.focus()
    check("focusing a preset shows it too", p.locator(".compare-tip").count() == 1)
    p.keyboard.press("Enter")
    settle(p)
    p.mouse.move(0, 0)
    preset.hover()
    check("a preset that is already chosen says so", "Already chosen" in p.inner_text(".compare-tip"), p.inner_text(".compare-tip"))
    p.mouse.move(0, 0)
    p.wait_for_selector("#results .anvil-step", timeout=8000)

    # Rename: the name box, the +1 level badge, the count and the edition's cut length (Java 50, Bedrock 30, counted in UTF-16 units).
    name = "#item .anvil-name-input"
    check("the name box shows the item's name as a hint and no badge", bool(p.get_attribute(name, "placeholder")) and p.locator("#item .anvil-name.renaming").count() == 0 and not p.locator("#item .rename-cost").is_visible())
    check("the name box sits above the item's slot (narrow card) or beside it (wide card)", p.evaluate("(() => { const n = document.querySelector('#item .anvil-name').getBoundingClientRect(), s = document.querySelector('#item .item-menu-button').getBoundingClientRect(); return document.querySelector('#item').offsetWidth >= 640 ? n.left >= s.right : n.bottom <= s.top + 1; })()"))
    p.locator(name).press_sequentially("x" * 55, delay=0)
    settle(p)
    check("a Java name is cut at 50 characters", len(p.input_value(name)) == 50 and p.get_attribute(name, "maxlength") == "50", len(p.input_value(name)))
    check("typing a name shows the +1 level badge and the count", p.locator("#item .anvil-name.renaming").count() == 1 and p.locator("#item .rename-cost").is_visible() and p.inner_text("#item .name-count") == "50 / 50", p.inner_text("#item .name-count"))
    check("the item card's preview carries the name", "x" * 50 in p.inner_text("#item .wanted-preview"))
    p.click("#options-menu summary")
    p.click('#limit-panel [data-focus="edition-bedrock"]')
    settle(p)
    p.keyboard.press("Escape")
    check("on Bedrock the name is cut at 30", len(p.input_value(name)) == 30 and p.get_attribute(name, "maxlength") == "30" and p.inner_text("#item .name-count") == "30 / 30", (len(p.input_value(name)), p.get_attribute(name, "maxlength")))
    p.click("#options-menu summary")
    p.click('#limit-panel [data-focus="edition-java"]')
    settle(p)
    p.keyboard.press("Escape")
    check("and back on Java the uncut name returns", len(p.input_value(name)) == 50)
    p.fill(name, "\U0001F600\U0001F600\U0001F600")
    settle(p)
    check("an emoji counts as two characters, as the game does", p.inner_text("#item .name-count") == "6 / 50", p.inner_text("#item .name-count"))
    p.fill(name, "")
    settle(p)
    check("an empty name is no rename again", p.locator("#item .anvil-name.renaming").count() == 0 and not p.locator("#item .rename-cost").is_visible())

    # The level limit: type it in, and the infinity button.
    def open_rules():
        if not p.evaluate("document.querySelector('#options-menu').open"):
            p.click("#options-menu summary")

    def type_limit(text, key="Enter"):
        open_rules()
        p.click("#limit-panel .limit-value")
        p.fill("#limit-panel .limit-edit", text)
        p.keyboard.press(key)
        settle(p)
        open_rules()
        return p.input_value("#limit-panel .limit-slider"), p.inner_text("#limit-panel .limit-value")
    check("a typed limit moves the slider", type_limit("20") == ("20", "20"))
    check("a typed limit past the game's is cut to 39", type_limit("99") == ("39", "39"))
    check("Escape puts the old limit back", type_limit("5", "Escape") == ("39", "39"))
    open_rules()
    p.click('#limit-panel [data-focus="limit-infinity"]')
    settle(p)
    open_rules()
    check("the infinity button removes the limit, and the number says so", p.get_attribute('#limit-panel [data-focus="limit-infinity"]', "aria-pressed") == "true" and p.inner_text("#limit-panel .limit-value") == "∞")
    p.click('#limit-panel [data-focus="limit-infinity"]')
    settle(p)
    open_rules()
    check("and pressing it again brings the limit back", p.get_attribute('#limit-panel [data-focus="limit-infinity"]', "aria-pressed") == "false" and p.inner_text("#limit-panel .limit-value") == "39")
    return errors


def part_offline(browser, base):
    """the service worker: registers, saves the site on the first visit, and the page then opens and calculates with no connection"""
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_selector("#wanted .item-grid")
    ready = page.evaluate("navigator.serviceWorker.ready.then(registration => Boolean(registration.active))")
    check("the service worker registers and activates", ready)
    page.evaluate("() => new Promise(done => { const look = () => navigator.serviceWorker.controller ? done() : setTimeout(look, 50); look(); })")  # (it claims the page when it activates)
    cached = page.evaluate("caches.keys().then(async names => { const cache = await caches.open(names[0]); return (await cache.keys()).map(r => new URL(r.url).pathname); })")
    wanted = {"/js/App.js", "/js/Engine.js", "/json/metadata.json", "/json/text/en_us.json", "/css/Style.css", "/font/minecraft.woff"}
    check("the first visit saves the site's files", wanted <= set(cached), sorted(wanted - set(cached)))
    page.reload()
    page.wait_for_selector("#wanted .item-grid")
    context.set_offline(True)
    page.reload()
    page.wait_for_selector("#wanted .item-grid")
    check("with no connection the page still opens", page.locator("#wanted .item-grid .item-button").count() > 5)
    page.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(page)
    page.wait_for_selector("#results .anvil-step", timeout=8000)
    check("and it calculates an order with no connection (the worker and the data come from the copy)", page.locator("#results .anvil-step").count() >= 3)
    context.set_offline(False)
    context.close()
    return errors


def part_anvil_uses(browser, base):
    """section 4: slots, cost, planner, tree, phones"""
    # Anvil uses: focus, slot labels and instruction, cost breakdown, Slots view, planner, final card, tree.
    _, p7, errors7 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p7.wait_for_selector("#wanted .item-grid")
    p7.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p7)
    p7.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p7)
    steps = p7.locator("#results .anvil-step").count()
    check("only the current step is in full at first", p7.locator("#results .anvil-step:not(.folded)").count() == 1, p7.locator("#results .anvil-step:not(.folded)").count())
    check("a step says which slot is which", p7.locator("#results .anvil-step.current .cell-label").count() == 3)
    check("a step says what to do in words", "left slot" in p7.text_content("#results .anvil-step.current .step-instruction"))
    fold_all(p7, "Expand steps")
    check("Expand all shows every step in full", p7.locator("#results .anvil-step.folded").count() == 0)
    fold_all(p7, "Collapse steps")
    check("Collapse all folds every step", p7.locator("#results .anvil-step:not(.folded)").count() == 0)
    p7.locator("#results .anvil-step").nth(2).locator(".step-head").click()
    p7.locator("#results .anvil-step").nth(2).locator(".anvil-cost").scroll_into_view_if_needed()
    p7.locator("#results .anvil-step").nth(2).locator(".anvil-cost").hover()
    check("the cost shows where its levels come from", p7.locator("#results .cost-breakdown").first.is_visible() or p7.locator("#results .has-breakdown.open").count() == 1)
    p7.mouse.move(0, 0)
    check("the hotbar and the icons share one row", p7.evaluate("Math.abs(document.querySelector('.result-tools .step-hotbar').getBoundingClientRect().top - document.querySelector('.result-tools .result-icons').getBoundingClientRect().top) < 12"))
    check("Copy and Print are in the Share menu of the toolbar's icons", p7.locator("#results .result-tools > .result-icons > .share-menu").count() == 1)
    check("the receipt says the uses and the heading does not repeat them while open", "step" in p7.inner_text("#order-uses") and not p7.is_visible("#steps-summary"), p7.inner_text("#order-uses"))
    p7.click("#results .density")
    check("Compact Steps hides the tooltips until hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-step:not(.folded) .anvil-cell .mc-tooltip')).display") == "none")
    p7.locator("#results .anvil-step:not(.folded) .anvil-cell.result").first.hover() # (ticked steps are folded here too)
    check("Compact Steps' result slot shows its tooltip on hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-step:not(.folded) .anvil-cell.result .mc-tooltip')).display") != "none")
    p7.click("#results .density")
    settle(p7) # the old view is laid over the new one while they cross-fade
    p7.locator('#results input[data-step="7"]').check(force=True)
    settle(p7)
    check("ticking the last step ticks every step", p7.locator("#results input[data-step]:not(:checked)").count() == 0)
    p7.click("#results .step-reset")
    settle(p7)
    check("Uncheck all unticks the steps and offers Undo", p7.locator("#results input[data-step]:checked").count() == 0 and "Undo" in p7.inner_text(".toast"))
    p7.click(".toast .link")
    settle(p7)
    check("Undo brings the ticks back", p7.locator("#results input[data-step]:checked").count() >= 1)
    check("done steps can be shown again from under the list", "done step" in p7.inner_text("#results .show-done"))
    p7.click("#results .step-reset")
    settle(p7)
    check("with nothing ticked there is no Uncheck all", p7.locator("#results .step-reset").count() == 0)
    round_steps = p7.locator("#results .round").first.locator(".anvil-step")
    p7.locator("#results .round-toggle").first.click()
    settle(p7)
    first_round_folded = round_steps.evaluate_all("steps => steps.map(step => step.classList.contains('folded'))")
    p7.locator("#results .round-toggle").first.click()
    settle(p7)
    check("a round's label folds or unfolds its steps", len(set(first_round_folded)) == 1 and round_steps.evaluate_all("steps => steps.map(step => step.classList.contains('folded'))") != first_round_folded, first_round_folded)
    p7.click('#results [data-view="tree"]')
    p7.click("#results .density")
    check("the compact tree shows captions", p7.locator("#results .merge-tree.compact").count() == 1)
    p7.locator("#results .tree-line:not(.merge)").nth(1).hover()
    check("hovering a tree entry lights its path", p7.locator("#results .tree-line.path-up").count() >= 1 and p7.locator("#results .tree-line.path-self").count() == 1)
    p7.click('#results [data-view="steps"]')
    p7.click("#results .step-reset") if p7.locator("#results .step-reset:not([disabled])").count() else None
    # A raised enchantment shows the level it had: two Feather Falling III books make a IV.
    p9 = browser.new_page(viewport={"width": 1280, "height": 1000})
    p9.goto(base)
    p9.click('#wanted .item-grid button[data-focus="item-boots"]')
    clear_all(p9)
    p9.locator('[data-focus="bar-feather_falling"] .level-seg').nth(3).click()
    p9.click('[data-focus="mode-custom"]')
    p9.click('#books button[aria-label^="Remove entry 2"]')
    settle(p9)
    p9.fill('#books input[placeholder^="Type a book"]', "feather falling 3")
    p9.keyboard.press("Enter")
    p9.fill('#books input[placeholder^="Type a book"]', "feather falling 3")
    p9.keyboard.press("Enter")
    p9.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p9)
    check("a raised enchantment shows the level it had", p9.locator("#results .anvil-cell.result .mc-from").count() >= 1, p9.inner_text("#results .anvil-step"))
    p9.close()
    # Phones: the current step and a Done button stay on screen.
    ctx8 = browser.new_context(viewport={"width": 390, "height": 720}, is_mobile=True, has_touch=True)
    p8 = ctx8.new_page()
    errors8 = []
    p8.on("pageerror", lambda error: errors8.append(str(error)))
    p8.goto(base)
    p8.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p8)
    p8.wait_for_selector("#results .anvil-step", timeout=8000)
    p8.locator("#results .anvil-step").first.scroll_into_view_if_needed()
    try:
        p8.locator("#results .current-bar").wait_for(state="hidden", timeout=3000) # an observer tucks it away
    except Exception:
        pass
    check("the current-step bar tucks away while its step is on screen", not p8.locator("#results .current-bar").is_visible())
    p8.set_viewport_size({"width": p8.viewport_size["width"], "height": 520})  # (short, so the current step leaves the window at the bottom)
    p8.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
    try:
        p8.locator("#results .current-bar").wait_for(state="visible", timeout=3000)
    except Exception:
        pass
    check("the current-step bar shows on a phone", p8.locator("#results .current-bar").is_visible())
    p8.click("#results .current-bar .btn.primary")
    settle(p8)
    bar_text = p8.locator("#results .current-bar").text_content()
    check("its Done button ticks the step and moves on", p8.locator('#results input[data-step="1"]').is_checked() and "Step 2" in bar_text, bar_text)
    # Tree on a phone: a tap folds a merge; no tooltip or path highlight is left stuck open.
    p8.click('#results [data-view="tree"]')
    check("the tree starts compact on a phone", p8.get_attribute("#results .density", "aria-pressed") == "true")
    p8.locator("#results .tree-line.merge").first.click()
    settle(p8)
    stuck = p8.evaluate("[...document.querySelectorAll('#results .merge-tree .tree-tooltip')].filter(t => getComputedStyle(t).display !== 'none').length")
    check("a tap in the compact tree leaves no tooltip open", stuck == 0 and p8.locator("#results .tree-line.path-self").count() == 0, stuck)
    p8.click('#results [data-view="steps"]') # (a phone starts Compact in both views, so Steps is compact already)
    p8.locator("#results .slots-mode .anvil-step:not(.folded) .anvil-cell").first.click()
    check("a tap on a slot shows its tooltip", p8.locator("#results .slots-mode .anvil-cell.tip-open").count() == 1)
    p8.locator("#results .slots-mode .anvil-step:not(.folded) .anvil-cell").nth(1).click()
    check("a tap on another slot moves the tooltip", p8.locator("#results .slots-mode .anvil-cell.tip-open").count() == 1)
    return errors7 + errors8


def part_chips(browser, base):
    """section 2's modes and chips, a Pick one going to None, sections sliding, glints"""
    # Automatic <-> Custom, the "All n reached" chips and a "Pick one" group going to None and back: each animates and leaves nothing behind.
    _, p9, errors9 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p9.wait_for_selector("#wanted .item-grid")
    p9.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p9)
    p9.wait_for_selector("#books .entry-card")
    settle(p9)
    left_over = "#books .card-frame, #books .card-ghost, #books .card-leaving, #books .bar-leaving, #books .seg-pill, #books .morphing"
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    check("switching to Custom leaves nothing behind", p9.locator(left_over).count() == 0 and p9.locator("#books .entry-add-card").count() == 1)
    check("the entries keep their cards and gain tools", p9.locator("#books .entry-card .entry-head").count() == p9.locator("#books .entry-card").count())
    p9.click('[data-focus="mode-auto"]')
    settle(p9)
    check("switching back to Automatic leaves nothing behind", p9.locator(left_over).count() == 0 and p9.locator("#books .entry-add-card").count() == 0 and p9.locator("#books .coverage").count() == 0)
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    p9.mouse.move(0, 0)
    gap = scrub(p9, "document.querySelector('#books [data-focus=\"cover-summary\"]').click();",
                "(() => { const a = document.querySelector('#books .coverage').getBoundingClientRect(), b = document.querySelector('#books .entry-grid').getBoundingClientRect(); return [Math.round(a.height), Math.round((b.top - a.bottom) * 10) / 10]; })()")
    gaps = [g for _, g in gap["values"]]
    gap = {"heights": len({h for h, _ in gap["values"]}), "spread": max(gaps) - min(gaps)}
    check("the entries below follow the opening menu at its own rate", gap["heights"] >= 6 and gap["spread"] < 1, gap)
    settle(p9)
    check("the reached chips roll out of the summary chip", p9.locator("#books .cover-chip.ok:not(.summary)").count() >= 3 and p9.get_attribute('#books [data-focus="cover-summary"]', "aria-expanded") == "true")
    ghosts = scrub(p9, "document.querySelector('#books [data-focus=\"cover-summary\"]').click();", "document.querySelectorAll('#books .chip-leaving').length")
    check("closing the menu does not replay the chips fading out", max(ghosts["values"]) == 0, ghosts["values"])
    settle(p9)
    p9.wait_for_function("!document.querySelector('#books .cover-chip.ok:not(.summary)')", timeout=3000)
    check("and roll back in", p9.locator("#books .cover-chip.ok:not(.summary)").count() == 0 and p9.get_attribute('#books [data-focus="cover-summary"]', "aria-expanded") == "false")
    # A chip that changes state (amber to green) fades between the looks.
    p9.click('#books [data-focus="cover-summary"]')
    settle(p9)
    p9.click('#wanted [data-focus="switch-depth_strider-frost_walker"]')
    settle(p9)
    check("a missing enchantment shows an amber chip", p9.locator('#books .cover-chip.short[data-ns="frost_walker"]').count() == 1)
    fades = p9.evaluate("""() => { document.querySelector('#books [data-focus="cover-frost_walker"]').click();
        const chips = [...document.querySelectorAll('#books .cover-chip[data-ns="frost_walker"]')].filter(chip => chip.classList.contains('ok'));
        const keys = chips.flatMap(chip => chip.getAnimations().flatMap(a => a.effect.getKeyframes()));
        return { crosses: keys.some(k => k.opacity !== undefined && k.opacity !== '1') && document.querySelectorAll('#books .chip-leaving').length >= 1, widths: keys.some(k => k.width !== undefined) }; }""")
    check("a chip that turns green crosses over from the amber one", fades["crosses"], fades)
    check("and never animates its width (that would push the other chips off their paths)", not fades["widths"], fades)
    settle(p9)
    return errors9


def part_pick_none(browser, base):
    """the warning badge's menu, and a Pick one going to None and back (Boots with the first preset, Custom)"""
    _, p9, errors9 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p9.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p9)
    p9.wait_for_selector("#books .entry-card")
    settle(p9)
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    # The warning badge's menu can switch to Automatic.
    p9.click('#books button[aria-label^="Remove entry 2"]')
    settle(p9)
    p9.hover("#books-alert .info-tip-button")
    check("the warning menu offers Automatic", p9.locator("#books-alert .fix-option >> text=Switch to Automatic").count() == 1)
    p9.click("#books-alert .fix-option >> text=Switch to Automatic")
    settle(p9)
    check("choosing it switches to Automatic and the warning goes", p9.get_attribute('[data-focus="mode-auto"]', "aria-pressed") == "true" and p9.locator("#books-alert .info-tip").count() == 0)
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    key = p9.locator("#wanted .ench-group.exclusive").first.get_attribute("data-group")
    group = '#wanted .ench-group.exclusive[data-group="%s"]' % key
    check("a Pick one group with a pick shows its row", p9.locator(group + " > .ench-row").count() == 1)
    p9.click('#wanted [data-focus="switch-%s-none"]' % key)
    settle(p9)
    check("None closes the row and leaves no copy", p9.locator(group + " > .ench-row").count() == 0)
    p9.click('#wanted [data-focus^="switch-%s-"]:not([data-focus$="-none"]) >> nth=0' % key)
    settle(p9)
    check("an enchantment opens its row again", p9.locator(group + " > .ench-row").count() == 1 and p9.locator(group + " > .ench-row.chosen").count() == 1)
    return errors9


def part_section1_motion(browser, base):
    """section 1's height easing, sections sliding shut and open, glints (split from part_chips so the two run side by side)"""
    _, p9, errors9 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p9.wait_for_selector("#wanted .item-grid")
    p9.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p9)
    p9.wait_for_selector("#books .entry-card")
    settle(p9)
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    key = p9.locator("#wanted .ench-group.exclusive").first.get_attribute("data-group")
    # The conflict graph eases open and shut from its own summary, as it does from Expand / Collapse groups: both go through foldDetails, which makes the graph
    # before it measures the box (an unmade graph opened by a click grew after the slide had measured it, and appeared at once).
    own = eases(p9, "#wanted .graph-box", "#wanted .graph-box > summary")
    check("the conflict graph eases open from its own summary, drawn (not a jump)", own[0] > 3 and p9.locator(".graph-canvas").count() == 1, own)
    shut = eases(p9, "#wanted .graph-box", "#wanted .graph-box > summary")
    check("and eases shut from its own summary", shut[0] > 3, shut)
    offer_wanted_fold(p9, "expand")
    via = eases(p9, "#wanted .graph-box", '#wanted .fold-toggle[data-action="expand"]')
    check("and eases open from Expand groups, the same way", via[0] > 3, via)
    settle(p9)
    # Section 1 changes ease to a stop: the last change in #wanted's height, frame to frame, is small (a jump at the end is a snap).
    def last_step(action):
        """the size of the last change in #wanted's height as its animations are scrubbed: a jump at the end is a snap"""
        heights = scrub(p9, action, "document.querySelector('#wanted').getBoundingClientRect().height", 40)["values"]
        changes = [abs(b - a) for a, b in zip(heights, heights[1:]) if abs(b - a) > 0.05]
        return changes[-1] if changes else 0
    p9.evaluate("window.scrollTo(0, 0)") # (the item bar is one line while the page is scrolled: no presets in it)
    clear_all(p9)
    settle(p9)
    jump = last_step("document.querySelector('[data-focus=\"bar-feather_falling\"] .level-seg').dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }));")  # (the bar takes digits; its pointer drag is not a click)
    check("adding an enchantment does not jump in height", jump < 4, jump)
    settle(p9)
    jump = last_step("document.querySelector('[data-focus=\"clear-feather_falling\"]').click();")
    check("removing an enchantment does not jump in height", jump < 4, jump)
    settle(p9)
    choose_max(p9)
    settle(p9)
    jump = last_step("document.querySelector('#wanted [data-focus=\"switch-%s-none\"]').click();" % key)
    check("picking None in a group does not jump in height", jump < 4, jump)
    return errors9


def part_sections_motion(browser, base):
    """sections sliding shut and open, glints keeping in step (split from part_section1_motion so the two run side by side)"""
    _, p9, errors9 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p9.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p9)
    p9.wait_for_selector("#books .entry-card")
    settle(p9)
    # A section slides shut and open, and leaves nothing fixed behind.
    for section in ("wanted", "books", "steps"):
        toggle = '.card.collapsible[data-section="%s"] .collapse-toggle' % section
        p9.click(toggle)
        settle(p9)
        closed = p9.evaluate("(s) => { const c = document.querySelector('.card[data-section=' + s + ']'); return c.classList.contains('collapsed') && c.querySelector(':scope > .section-body').hidden && !c.classList.contains('closing') && c.style.flex === ''; }", section)
        p9.click(toggle)
        settle(p9)
        opened = p9.evaluate("(s) => { const c = document.querySelector('.card[data-section=' + s + ']'); const b = c.querySelector(':scope > .section-body'); return !c.classList.contains('collapsed') && !b.hidden && c.style.flex === '' && b.style.flex === '' && b.style.overflow === ''; }", section)
        check("the %s section slides shut and open cleanly" % section, closed and opened, (closed, opened))
    # The glints share the page's clock: a redraw does not start a sheen over.
    phase = lambda: p9.evaluate("[...document.getAnimations()].filter(a => (a.animationName === 'glint' || a.animationName === 'row-glint') && a.playState !== 'paused').map(a => a.startTime)")
    check("every glint starts at the timeline's zero", len(phase()) > 0 and set(phase()) == {0}, phase())
    p9.click('#wanted .level-bar:visible .level-seg >> nth=0')
    settle(p9)
    check("a change in section 1 does not restart the glints", len(phase()) > 0 and set(phase()) == {0}, phase())
    return errors9


def part_ranking(browser, base):
    """sections 3 and 4: ranking, Your level, the limit, copy menu, highlights, game rules"""
    # Section 3: the ranking tiles and presets, Your level, the limit, and where merging breaks.
    _, p10, errors10 = open_page(browser, base, viewport={"width": 1280, "height": 1100})
    p10.wait_for_selector("#wanted .item-grid")
    p10.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p10)
    p10.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p10)
    check("the game rules menu is among the header buttons", p10.locator(".header-actions #options-menu").count() == 1 and p10.locator("#metrics #options-menu, .section-head #options-menu").count() == 0)
    check("the receipt shows the levels, the uses and the wear, and the tiles are closed", p10.is_visible("#order-toggle") and "Level" in p10.inner_text("#order-levels") and "step" in p10.inner_text("#order-uses") and p10.is_visible("#anvil-risk .anvil-risk-label") and not p10.is_visible("#metrics") and p10.get_attribute("#order-toggle", "aria-expanded") == "false")
    p10.click("#order-toggle")
    settle(p10)
    check("the receipt opens the tiles and says so", p10.is_visible("#metrics .rank-tile") and p10.get_attribute("#order-toggle", "aria-expanded") == "true" and p10.evaluate("JSON.parse(localStorage.getItem('enchantment-calculator-order-open'))") is True)
    p10.reload()
    p10.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p10)
    check("the open panel is remembered across a reload", p10.is_visible("#metrics .rank-tile") and p10.get_attribute("#order-toggle", "aria-expanded") == "true")
    check("every ranking tile has a grip, a unit and a note", p10.locator(".rank-tile .rank-grip").count() == 4 and all(p10.locator(".rank-tile .metric-unit").nth(i).inner_text() for i in range(4)) and all(p10.locator(".rank-tile .metric-note").nth(i).inner_text() for i in range(4)))
    p10.click(".rank-tile >> nth=1 >> .rank-move >> nth=0")
    check("an arrow ranks a tile higher", p10.locator(".rank-tile").first.get_attribute("data-criterion") == "xp" and "XP" in p10.inner_text(".rank-caption"))
    p10.click(".rank-tile >> nth=1 >> .rank-move >> nth=0")
    check("and back", p10.locator(".rank-tile").first.get_attribute("data-criterion") == "levels")
    p10.click("#results .level-chip")
    check("not tracking, the chip says to set the level and the popover opens", p10.inner_text("#results .level-chip") == "Set level" and p10.is_visible("#level-pop") and p10.get_attribute("#results .level-chip", "aria-expanded") == "true")
    p10.keyboard.press("Escape")
    check("Escape closes it and the focus goes back to the chip", not p10.is_visible("#level-pop") and p10.evaluate("document.activeElement.classList.contains('level-chip')"))
    p10.click("#results .level-chip")
    p10.click('[data-focus="level-toggle"]')
    settle(p10)
    check("tracking your level says how many levels are missing", "more" in p10.inner_text("#level-status"), p10.inner_text("#level-status"))
    p10.click("#level-set")
    settle(p10)
    check("setting it to what the order needs says it is enough", "enough" in p10.get_attribute("#level-status", "class") or "Enough" in p10.inner_text("#level-status"))
    # Ticking a step spends its levels from the tracked level; unticking gives them back; Uncheck all and its Undo too.
    p10.keyboard.press("Escape")
    level = lambda: int(p10.input_value("#player-level"))
    start = level()
    cost = int(p10.evaluate("""(() => { const step = document.querySelector('#results [data-step-card="1"]'); return step.querySelector('.anvil-cost').textContent.match(/[0-9]+/)[0]; })()"""))
    p10.locator('#results input[data-step="1"]').check(force=True)
    settle(p10)
    check("ticking a step spends its levels from the tracked level", level() == start - cost, (start, cost, level()))
    p10.locator('#results input[data-step="1"]').uncheck(force=True)
    settle(p10)
    check("unticking it gives them back", level() == start, (start, level()))
    p10.locator('#results input[data-step="1"]').check(force=True)
    settle(p10)
    p10.click("#results .step-reset")
    settle(p10)
    check("Uncheck all gives back every ticked step's levels", level() == start, (start, level()))
    p10.click(".toast .link")
    settle(p10)
    check("and Undo spends them again", level() == start - cost, (start, level()))
    p10.click("#results .step-reset")
    settle(p10)
    check("the chip shows the level and sits beside the hotbar", p10.inner_text("#results .level-chip").startswith("Lv ") and p10.evaluate("Math.abs(document.querySelector('#results .level-chip').getBoundingClientRect().top - document.querySelector('#results .step-hotbar').getBoundingClientRect().top) < 40"))
    p10.click("#options-menu summary")
    p10.locator("#limit-panel input[type=range]").fill("18")
    p10.keyboard.press("Escape")
    settle(p10)
    check("the biggest step close to the limit turns amber", p10.locator(".rank-tile.near").count() == 1)
    p10.click("#options-menu summary")
    p10.locator("#limit-panel input[type=range]").fill("9")
    p10.keyboard.press("Escape")
    p10.wait_for_selector("#results .break-down .anvil-cell.result", timeout=8000)
    check("with no order the breaking step is shown", p10.locator("#results .break-step .anvil-cell").count() == 3)
    p10.click("#results .break-down .btn.primary")
    p10.wait_for_selector("#results .anvil-step", timeout=8000)
    check("raising the limit from there gives an order", p10.locator("#results .break-down").count() == 0)
    # Section 4: the goal line, "In words", the wear label, jumping, the keyboard, the copy menu and source highlighting.
    check("the anvil wear badge is labelled", p10.locator("#anvil-risk .anvil-risk-label").is_visible())
    check("the sentence is behind an In words line", not p10.locator("#results .anvil-step.current .step-instruction").is_visible())
    p10.click("#results .anvil-step.current .step-words summary")
    check("opening it shows the sentence", p10.locator("#results .anvil-step.current .step-instruction").is_visible())
    p10.click("#results .anvil-step.current .step-words summary")
    p10.locator("#results .hotbar-slot").nth(4).click()
    settle(p10)
    check("a hotbar slot jumps to its step", p10.evaluate("document.activeElement.dataset.step") == "5", p10.evaluate("document.activeElement.dataset.step"))
    p10.keyboard.press("ArrowDown")
    check("Down moves to the next step", p10.evaluate("document.activeElement.dataset.step") == "6")
    p10.keyboard.press("ArrowUp")
    check("Up moves back", p10.evaluate("document.activeElement.dataset.step") == "5")
    p10.click("#results .share-menu summary")
    check("Share is a menu of steps, checklist, link and Print", all(p10.locator(".share-menu .copy-panel " + part).is_visible() for part in (".copy-steps", ".copy-checklist", ".copy-link", ".print-button")))
    p10.keyboard.press("Escape")
    p10.locator("#results .hotbar-slot").nth(6).click()
    settle(p10)
    p10.locator('#results .anvil-step[data-step-card="7"] .anvil-cell.result').hover()
    sources = p10.locator("#books .entry-card.highlight").count()
    check("hovering a merged item lights every entry that went into it", sources >= 5, sources)
    p10.mouse.move(0, 0)
    check("moving away clears them", p10.locator("#books .entry-card.highlight").count() == 0)
    # Compact Steps folds like Steps: every step starts open, Collapse all folds each to its head, Expand all opens them again.
    folded_steps = lambda: p10.eval_on_selector_all("#results .anvil-step", "e => e.map(x => x.classList.contains('folded'))")
    in_steps = folded_steps()
    p10.click("#results .density")
    settle(p10)
    steps_n = p10.locator("#results .anvil-step").count()
    check("the Slots view's steps have a fold arrow and start with the same steps open as Steps", p10.locator("#results .step-fold").count() == steps_n and folded_steps() == in_steps and p10.locator("#results .fold-toggle").count() == 1, (in_steps, folded_steps()))
    fold_all(p10, "Collapse steps")
    settle(p10)
    check("Collapse all folds every Slots step to its head (the row and caption go, the one-line summary shows)", p10.locator("#results .anvil-step.folded").count() == steps_n and p10.locator("#results .anvil-row:visible").count() == 0 and p10.locator("#results .step-caption:visible").count() == 0 and "+" in p10.locator("#results .anvil-step.folded .step-summary").first.inner_text())
    p10.locator("#results .anvil-step").nth(1).locator(".step-head").click(position={"x": 200, "y": 8})
    settle(p10)
    check("a click on a folded Slots step's head opens it", p10.locator("#results .anvil-step.folded").count() == steps_n - 1 and p10.locator("#results .anvil-row:visible").count() == 1)
    in_slots = folded_steps()
    p10.click("#results .density")
    settle(p10)
    check("the steps folded or opened in Compact are the same in the full Steps (one fold state for both views)", folded_steps() == in_slots, (in_slots, folded_steps()))
    p10.click("#results .density")
    settle(p10)
    fold_all(p10, "Expand steps")
    settle(p10)
    check("Expand all opens every Compact step", p10.locator("#results .anvil-step.folded").count() == 0 and p10.locator("#results .anvil-row:visible").count() == steps_n)
    p10.click("#results .density")
    # Game rules reset to the game's own.
    p10.click("#options-menu summary")
    p10.locator("#limit-panel input[type=range]").fill("12")
    p10.click('#limit-panel [data-focus="allow-conflicts"]')
    settle(p10)
    check("changed rules put a dot on the button", "changed" in p10.get_attribute("#options-menu summary", "class"))
    p10.click('#limit-panel [data-focus="rules-reset"]')
    settle(p10)
    vanilla = p10.evaluate("() => ({ limit: document.querySelector('#limit-panel .limit-slider').value, on: document.querySelector('#limit-panel .rule-switch').getAttribute('aria-checked'), dot: document.querySelector('#options-menu summary').classList.contains('changed'), disabled: document.querySelector('#limit-panel [data-focus=\"rules-reset\"]').disabled })")
    check("Reset to vanilla brings back limit 39 with conflicts off", vanilla == {"limit": "39", "on": "false", "dot": False, "disabled": True}, vanilla)
    return errors10


def part_settings_motion(browser, base):
    """Settings: its sections, Show animations and Show glints (motion on, since the switches are what is tested)"""
    _, p10, errors10 = open_page(browser, base, viewport={"width": 1280, "height": 1100})
    p10.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(p10)
    p10.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p10)
    p10.click("#options-menu summary")
    # Settings: the game rules are a subsection beside a Display one, and "Show animations" off stops every animation.
    titles = p10.eval_on_selector_all("#limit-panel .settings-section-title", "e => e.map(x => x.textContent.trim())")
    check("the menu is Settings, with Game rules and Display as subsections", titles == ["Game rules", "Display"] and p10.inner_text("#options-menu summary").strip() == "Settings", titles)
    check("animations are shown to begin with", p10.get_attribute("html", "data-motion") is None and p10.get_attribute('#limit-panel [data-focus="motion-on"]', "aria-checked") == "true")
    p10.click('#limit-panel [data-focus="motion-on"]')
    kept = p10.evaluate("() => document.getAnimations().map(a => a.animationName || a.constructor.name)")
    check("Show animations off leaves the glints running (they have their own switch)", kept and all("glint" in n for n in kept), kept)
    p10.click('#limit-panel [data-focus="glints"]')
    check("Glints off stops them and is kept", p10.get_attribute("html", "data-glint") == "off" and p10.evaluate("document.getAnimations().length") == 0 and p10.evaluate("localStorage.getItem('enchantment-calculator-glints')") == "false")
    p10.keyboard.press("Escape")
    p10.click('#results [data-view="tree"]')
    leftover = p10.evaluate("() => [document.documentElement.dataset.motion, document.getAnimations().length, document.querySelectorAll('#results .steps-scroll').length]")
    check("with Show animations off, a view switch animates nothing (no cross-fade copy, no animation running, not even the glints)", leftover == ["off", 0, 1], leftover)
    p10.click('#results [data-view="steps"]')
    p10.click("#options-menu summary")
    p10.click('#limit-panel [data-focus="motion-on"]')
    p10.click('#limit-panel [data-focus="glints"]')
    check("and turning it off brings them back", p10.get_attribute("html", "data-motion") is None and p10.evaluate("localStorage.getItem('enchantment-calculator-no-motion')") == "false")
    p10.keyboard.press("Escape")
    return errors10


def part_elytra(browser, base):
    """an item with no conflicts"""
    # An item whose enchantments never conflict (Elytra) has no conflict graph, and no stray text where it would be.
    _, p13, errors13 = open_page(browser, base, viewport={"width": 1280, "height": 1100})
    p13.wait_for_selector("#wanted .item-grid")
    p13.click('#wanted .item-button:has-text("Elytra")')
    p13.wait_for_selector("#item .wanted-preview")
    check("an item with no conflicts has no conflict graph and no stray text", p13.locator("#wanted .graph-box").count() == 0 and "null" not in p13.inner_text("#wanted"), p13.inner_text("#wanted")[:200])
    p13.click("#books >> text=Custom")
    p13.click("#books >> text=Add book")
    p13.wait_for_selector(".picker-search")
    p13.fill(".picker-search", "MEND")
    settle(p13)
    check("the add-enchantment menu has a search box, with no mod on", p13.eval_on_selector_all(".entry-popover .picker-row", "e => e.map(x => x.dataset.ns)") == ["mending"])
    # Flint & Steel in the game's own list has one group only (its lone enchantments), so no subsection is made around it.
    p13.click("#item .item-menu-button")
    p13.click('#items button[data-focus="item-flint_and_steel"]')
    p13.wait_for_selector("#wanted .ench-row")
    check("a section with one group shows it without a subsection", p13.locator('#wanted .group-fold:not([data-fold="curses"])').count() == 0 and p13.locator("#wanted .wanted-list > .ench-row").count() >= 1)
    return errors13


def part_fancy(browser, base):
    """a mod: switch, its section, the search, the picker, links, Bedrock, reset (a small made-up mod stands in for the real ones)"""
    # Mod Looter conflicts with vanilla Looting (so the search and the graph meet across the mod); Mod C is a lone enchantment of 3 levels.
    mod = mock_mod(vanilla={"looter": ["looting"]}, singles=["c", "looter"], levels={"c": 3})
    mod["enchantments"]["spellbound:looter"]["incompatible"] = ["looting"]
    mod["names"]["en"]["spellbound:looter"] = "Mod Looting"
    context = mocked_context(browser, mod)
    p11 = context.new_page()
    errors11 = []
    p11.on("pageerror", lambda e: errors11.append(str(e)))
    p11.goto(base)
    p11.wait_for_selector("#wanted .item-grid")
    p11.click('#wanted .item-button:has-text("Sword")')
    p11.wait_for_selector("#item .wanted-preview")
    vanilla_rows = p11.locator("#wanted .ench-row").count()
    p11.click("#options-menu summary")
    check("the Mods row offers the mod, off", p11.get_attribute('#limit-panel [data-focus="mod-spellbound"]', "aria-checked") == "false")
    p11.click('#limit-panel [data-focus="mod-spellbound"]')
    p11.wait_for_selector("#wanted .mod-section")
    check("turning it on adds its enchantments, folded under its name", p11.locator("#wanted .mod-section").count() == 1 and p11.locator("#wanted .mod-section[open]").count() == 0 and "(1)" in p11.inner_text("#wanted .mod-section > summary"))
    check("the Game rules button names the mod and shows the changed dot", "Spellbound" in p11.get_attribute("#options-menu summary", "title") and "changed" in p11.get_attribute("#options-menu summary", "class"))
    p11.keyboard.press("Escape")
    p11.click("#wanted .graph-box > summary")
    p11.wait_for_selector(".graph-canvas")
    order = p11.evaluate("[...document.querySelector('#wanted').children].map(el => el.classList.contains('wanted-head') ? 'head' : el.classList.contains('search-row') ? 'search' : el.classList.contains('wanted-list') ? 'list' : el.classList.contains('mod-section') ? 'mod' : el.classList.contains('graph-box') ? 'graph' : '?')")
    check("section 1 has the search (the item is its own card now), then the enchantment list, each mod's list and the conflict graph as boxes of their own", order == ["search", "list", "mod", "graph"], order)
    p11.click("#wanted .graph-box > summary")
    p11.click("#wanted .mod-section > summary")
    # The search meets the mod's enchantments, and opens their section.
    p11.fill(".wanted-search", "loot")
    settle(p11)
    shown = p11.inner_text("#wanted .wanted-list")
    check("the search shows only matching enchantments, in mods too", "Looting" in shown and "Mod Looting" in shown and "Sharpness" not in shown, shown[:200])
    check("typing in the search keeps the focus", p11.evaluate("document.activeElement.classList.contains('wanted-search')"))
    p11.fill(".wanted-search", "zzzz")
    settle(p11)
    check("a search with no match says so", p11.locator("#wanted .ench-row").count() == 0 and "No enchantment matches" in p11.inner_text("#wanted .wanted-list"))
    p11.fill(".wanted-search", "")
    settle(p11)
    check("clearing the search brings back the whole list", p11.locator("#wanted .ench-row").count() >= vanilla_rows)
    p11.keyboard.press("Escape")
    if not p11.evaluate("document.querySelector('#wanted .mod-section').open"):  # (whether the box stays open after a search is not what this checks)
        p11.click("#wanted .mod-section > summary")
    p11.click('#wanted .ench-row[data-ns="spellbound:c"] .level-seg[data-level="2"]')
    p11.click("#wanted .group-switch >> text=Sharpness")
    p11.wait_for_selector("#results .anvil-step")
    check("a mod's enchantment goes through the search", "Mod C" in p11.inner_text("#results"), p11.inner_text("#results")[:200])
    check("its link names the mod", "spellbound" not in p11.evaluate("location.hash") and len(p11.evaluate("location.hash")) > 40)
    link = p11.evaluate("location.href")
    p11.click("#books >> text=Custom")
    p11.click("#books >> text=Add book")
    p11.wait_for_selector(".picker-search")
    p11.fill(".picker-search", "mod c")
    settle(p11)
    check("the picker searches every enchantment, mods included", p11.eval_on_selector_all(".entry-popover .picker-row", "e => e.map(x => x.dataset.ns)") == ["spellbound:c"])
    check("typing in the picker keeps the focus", p11.evaluate("document.activeElement.classList.contains('picker-search')"))
    context12 = mocked_context(browser, mod)
    p12 = context12.new_page()
    errors12 = []
    p12.on("pageerror", lambda e: errors12.append(str(e)))
    p12.goto(link)
    p12.wait_for_selector("#results .anvil-step")
    check("opening the link loads the mod and its choices", "spellbound:c" in p12.eval_on_selector_all("#wanted .ench-row.chosen", "e => e.map(x => x.dataset.ns)"))
    p12.click("#options-menu summary")
    p12.click('#limit-panel [data-focus="edition-bedrock"]')
    settle(p12)
    check("on Bedrock the mod is off and its switch disabled", p12.is_disabled('#limit-panel [data-focus="mod-spellbound"]') and p12.locator("#wanted .mod-section").count() == 0)
    check("on Bedrock a Java mod is not a changed rule", p12.is_disabled('#limit-panel [data-focus="rules-reset"]') and "changed" not in p12.get_attribute("#options-menu summary", "class")
          and "Spellbound" not in p12.get_attribute("#options-menu summary", "title"))
    p12.click('#limit-panel [data-focus="edition-java"]')
    p12.click('#limit-panel [data-focus="rules-reset"]')
    settle(p12)
    check("Reset to vanilla turns the mod off", p12.locator("#wanted .mod-section").count() == 0 and p12.get_attribute('#limit-panel [data-focus="mod-spellbound"]', "aria-checked") == "false")
    context.close()
    context12.close()
    return errors11 + errors12


def part_two_mods(browser, base):
    """both real mods together: the Mods row, a section each, the presets, a link (one end-to-end check of the real data)"""
    _, p14, errors14 = open_page(browser, base, viewport={"width": 1280, "height": 1100})
    p14.wait_for_selector("#wanted .item-grid")
    p14.click('#wanted .item-button:has-text("Sword")')
    p14.wait_for_selector("#item .wanted-preview")
    preset_names = lambda: p14.eval_on_selector_all("#item .preset-chips button, #item .presets button, #wanted .chip", "e => e.map(x => x.textContent.trim())")
    names_off = preset_names()
    p14.click("#options-menu summary")
    check("the Mods row offers both mods", p14.locator('#limit-panel [data-focus^="mod-"]').count() == 2)
    p14.click('#limit-panel [data-focus="mod-spellbound"]')
    p14.wait_for_selector('#wanted .mod-section[data-mod="Spellbound"]')
    check("a mod's note (loader and Minecraft version) is its row's hover tooltip once loaded", p14.locator("#limit-panel .mod-row[title]").count() == 1 and "Fabric, Minecraft 1.20.1" in p14.locator("#limit-panel .mod-row[title]").get_attribute("title"), p14.locator("#limit-panel .mod-row[title]").count())
    check("Spellbound alone adds its own folded section", p14.locator("#wanted .mod-section").count() == 1)
    p14.click('#limit-panel [data-focus="mod-fancy_enchantments"]')
    p14.wait_for_selector('#wanted .mod-section[data-mod="Fancy Enchantments"]')
    check("with both on, each mod has its own section", p14.locator("#wanted .mod-section").count() == 2)
    p14.keyboard.press("Escape")
    check("turning mods on does not rename the presets", names_off and preset_names() == names_off, (names_off, preset_names()))
    p14.locator('#wanted .switch-option[data-opt="spellbound:dullness"]').first.click()
    settle(p14)
    spellbound = lambda: p14.locator('#wanted .mod-section[data-mod="Spellbound"]')
    if not spellbound().evaluate("d => d.open"):
        spellbound().locator(":scope > summary").click()
        settle(p14)
    pick = spellbound().locator(".ench-row .level-seg, .switch-option").first
    pick.click()
    settle(p14)
    check("a mod's box stays open once one of its enchantments is chosen", spellbound().evaluate("d => d.open"))
    spellbound().locator(":scope > summary").click()
    settle(p14)
    curse = lambda: p14.locator("#wanted .ench-row", has_text="Curse of Vanishing").locator(".level-seg").first
    curse().click()
    settle(p14)
    check("a mod box the user closed stays closed when another pick (a curse) redraws the list", not spellbound().evaluate("d => d.open"))
    curse().click()  # (unchosen again)
    settle(p14)
    link14 = p14.evaluate("location.href")
    _, p15, errors15 = open_page(browser, link14, viewport={"width": 1280, "height": 1100})
    p15.wait_for_selector("#wanted .ench-row.chosen")
    check("a link with two mods loads both", p15.locator("#wanted .mod-section").count() == 2)
    return errors14 + errors15


def part_level_rows(browser, base):
    """two-row level bars and their animation (a made-up ten-level enchantment that conflicts with the damage ones)"""
    # Switching between a five-level and a ten-level pick: the bar's height eases (28px -> 56px) instead of jumping.
    context, p16, errors16, _ = mocked_mod_page(browser, base, vanilla={"d": ["sharpness", "smite", "bane_of_arthropods"]}, levels={"d": 10})
    p16.click("#wanted .group-switch >> text=Sharpness")
    settle(p16)
    check("a Pick one with a ten-level pick replaces the other (same category)", p16.locator("#wanted .ench-row.chosen").count() == 1)
    bar_height = "Math.round(document.querySelector('#wanted .ench-group.exclusive .ench-row .level-bar').getBoundingClientRect().height)"
    heights = scrub(p16, "[...document.querySelectorAll('#wanted .group-switch button')].find(b => b.textContent.includes('Mod D')).click();", bar_height)["values"]
    check("a bar gaining a second row grows smoothly", 28 <= heights[0] < 40 and heights[-1] == 56 and any(40 <= x <= 52 for x in heights), heights)
    dull = p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-bar')
    box = dull.bounding_box()
    check("a level bar past V wraps onto a second row of five (to X)", p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-seg').count() == 10 and box["height"] > 50 and box["width"] < 160, box)
    p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-seg[data-level="8"]').click()
    settle(p16)
    check("a level in the second row can be chosen", p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-bar').get_attribute("aria-valuetext") == "Mod D VIII")
    # And back: the ten-level bar's extra row leaves with the height, not after it (one animation, not two).
    # One animation, not two: the lost segments' copies roll away over the same time as the bar's height shrinks, and they are gone once it has.
    result = scrub(p16, """document.querySelectorAll('#wanted .group-switch button').forEach(b => { if (b.textContent.includes('Sharpness')) b.click(); });
        await new Promise(done => requestAnimationFrame(done));
        const timing = a => a.effect.getComputedTiming().endTime;
        const bar = [...document.getAnimations()].filter(a => a.effect.target && a.effect.target.classList.contains('level-bar') && a.effect.getKeyframes().some(k => k.height));
        const lost = [...document.getAnimations()].filter(a => a.effect.target && a.effect.target.classList.contains('level-seg') && a.effect.target.style.position === 'absolute');
        return { bar: bar.map(timing), lost: lost.map(timing) };""",
                "[Math.round(document.querySelector('#wanted .ench-group.exclusive .ench-row .level-bar').getBoundingClientRect().height), document.querySelectorAll('#wanted .ench-group.exclusive .ench-row .level-bar .level-seg').length]", 30)
    timing = result["acted"]
    check("losing a row: the extra levels roll away over the same time as the height shrinks, and are gone after",
          len(timing["bar"]) == 1 and len(timing["lost"]) >= 5 and max(timing["lost"]) <= timing["bar"][0] + 1 and result["values"][0][0] == 56 and result["after"] == [28, 5], (timing, result["values"][0], result["after"]))
    context.close()
    return errors16


def part_mod_off(browser, base):
    """turning a mod off with its enchantments chosen (a one-enchantment made-up mod)"""
    # Turning a mod off while one of its enchantments is chosen: the pick is dropped, and the tooltip, the cost
    # and the results follow (no error from the result still on screen, no "Missing" message).
    context, p17, errors17, _ = mocked_mod_page(browser, base, singles=["c"], levels={"c": 2})
    p17.click('#wanted .ench-row[data-ns="spellbound:c"] .level-seg[data-level="2"]')
    p17.click("#wanted .group-switch >> text=Sharpness")
    p17.wait_for_selector("#results .anvil-step")
    p17.wait_for_function("document.querySelector('#item .wanted-preview .cost-line') && document.querySelector('#item .wanted-preview').textContent.includes('Mod C')")
    p17.click("#options-menu summary")
    p17.click('#limit-panel [data-focus="mod-spellbound"]')
    p17.keyboard.press("Escape")
    p17.wait_for_function("document.querySelector('#item .wanted-preview .cost-line') && document.querySelector('#item .wanted-preview .cost-line').textContent.includes('5 ')", timeout=5000)
    settle(p17) # the removed tooltip line fades out first
    tip, results = p17.inner_text("#item .wanted-preview"), p17.inner_text("#results")
    check("turning a mod off drops its picks everywhere, with no error", "Mod C" not in tip and "5 Levels" in tip and "Mod C" not in results and "issing" not in results, (tip, results[:200]))
    context.close()
    return errors17


def part_shelf(browser, base):
    """Automatic mode's shelf of slots, the switch to Custom, the phone order, and the conflict graph as the last box of Enchantments on wide windows"""
    def pick_boots(page):
        page.click('#wanted .item-grid button[data-focus="item-boots"]')
        choose_max(page)
        page.wait_for_selector("#results .anvil-step", timeout=8000)
        settle(page)
    no_overflow = lambda page: page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")

    # Desktop (1440): the shelf, then the graph under the item card.
    _, d, errors = open_page(browser, base, viewport={"width": 1440, "height": 900})
    pick_boots(d)
    entries = d.evaluate("document.querySelectorAll('#books .entry-grid.shelf .entry-card.slotcell').length")
    check("Automatic draws a shelf: one slot per book or item, each with a tooltip", entries >= 3 and d.locator("#books .shelf .slotcell .slot-tip").count() == entries, entries)
    check("the shelf has no Cards | Slots | List switch", d.locator("#books .view-switch").count() == 0)
    check("the shelf is slots only, no enchantment cards", d.locator("#books .entry-grid.shelf .entry-tooltip").count() == 0)
    d.hover("#books .shelf .slotcell >> nth=1")
    check("hovering a slot shows its tooltip, inside the section", d.evaluate("""() => { const tip = document.querySelector('#books .shelf .slotcell:hover .slot-tip'), area = document.querySelector('#books').getBoundingClientRect(); if (!tip) return false; const box = tip.getBoundingClientRect(); return box.width > 0 && box.right <= area.right + 1 && tip.textContent.includes('Enchanted Book'); }"""))
    d.hover("#books .shelf .slotcell >> nth=-1")
    check("the last slot's tooltip does not leave the section either", d.evaluate("""() => { const tip = document.querySelector('#books .shelf .slotcell:hover .slot-tip'); return Boolean(tip) && tip.getBoundingClientRect().right <= document.querySelector('#books').getBoundingClientRect().right + 1; }"""))
    d.mouse.move(5, 5)
    d.focus("#books .shelf .slot-cell-button >> nth=0")
    check("focusing a slot shows its tooltip too", d.locator("#books .shelf .slotcell:focus-within .slot-tip").first.is_visible())
    check("the shelf's slots are one tab stop", d.locator("#books .shelf .slot-cell-button[tabindex='0']").count() == 1)
    check("at 1440 the graph is the last box inside Enchantments", d.locator("#wanted > .graph-box").count() == 1 and d.evaluate("document.querySelector('#wanted').lastElementChild.classList.contains('graph-box')"))
    d.click("#wanted .graph-box > summary")
    d.wait_for_selector("#wanted .graph-canvas")
    settle(d)
    canvas = d.locator("#wanted .graph-canvas").bounding_box()
    section = d.locator("#wanted").bounding_box()
    check("the opened graph lays out inside the section", canvas["width"] <= section["width"] + 1 and canvas["width"] > 250 and canvas["height"] <= 421 and no_overflow(d), (canvas, section))
    d.hover('#wanted .graph-node[data-ns="blast_protection"]')
    check("hovering a node lights its conflicts", d.locator(".graph-node.near").count() >= 2 and "Fire Protection" in d.inner_text(".graph-caption"))
    d.click('#wanted .graph-node[data-ns="blast_protection"]')
    settle(d)
    check("clicking a node chooses it and the graph stays open", d.locator('.graph-node.chosen[data-ns="blast_protection"]').count() == 1 and d.locator("#wanted .graph-canvas").is_visible())
    d.click('#wanted .graph-node[data-ns="blast_protection"]')
    settle(d)
    d.fill(".wanted-search", "protect")
    settle(d)
    check("the graph rings the matches and fades the rest, and stays open", d.locator(".graph-node.match").count() > 0 and d.locator(".graph-node.unmatched").count() > 0 and d.locator("#wanted .graph-box[open]").count() == 1)
    d.fill(".wanted-search", "")
    settle(d)
    d.set_viewport_size({"width": 1100, "height": 900})
    d.wait_for_function("document.querySelector('#wanted .graph-box')")
    check("at 1100 it is still the last box of Enchantments, open and visible", d.locator("#wanted .graph-box[open]").count() == 1 and d.locator("#wanted .graph-canvas").is_visible() and no_overflow(d))
    d.set_viewport_size({"width": 1440, "height": 900})
    check("back at 1440 it has not moved", d.locator("#wanted > .graph-box[open]").count() == 1)

    # Custom (the mode switch; the shelf has no Customize button).
    entries = d.locator("#books .shelf .slotcell").count()
    d.click("#books .mode-switch >> text=Custom")
    settle(d)
    check("Custom switches to: editable cards, the view switch, the add bar", d.locator("#books .mode-switch button.selected").inner_text() == "Custom" and d.locator("#books .view-switch").count() == 1 and d.locator("#books .entry-add-card").count() == 1 and d.locator("#books .shelf").count() == 0)
    d.click("#books .mode-switch >> text=Automatic")
    settle(d)
    check("Automatic brings the shelf back", d.locator("#books .shelf .slotcell").count() == entries and d.locator("#books .view-switch").count() == 0)
    check("no sideways overflow on desktop", no_overflow(d))

    # Phone (390): Item, Enchantments, Books and items, then Anvil uses.
    _, m, errors_m = open_page(browser, base, viewport={"width": 390, "height": 844})
    pick_boots(m)
    tops = m.evaluate("Object.fromEntries([...document.querySelectorAll('.layout [data-section]')].map(el => [el.dataset.section, el.getBoundingClientRect().top + scrollY]))")
    check("on a phone the sections keep their numbered order: Enchantments, Books and items, Anvil uses", tops["wanted"] < tops["books"] < tops["steps"], tops)
    check("the item card still comes first", m.evaluate("document.querySelector('#item-dock').getBoundingClientRect().top + scrollY") < tops["wanted"])
    check("the section badges are checks once their stage is done", badge_mark(m, '[data-section="wanted"] .step-badge') == "\u2713" and badge_mark(m, '[data-section="books"] .step-badge') == "\u2713" and badge_mark(m, '[data-section="steps"] .step-badge') == "\u2713")
    check("the phone shelf stays inside the screen", no_overflow(m) and m.evaluate("[...document.querySelectorAll('#books .shelf .slotcell')].every(el => el.getBoundingClientRect().right <= innerWidth)"))
    m.click('[data-section="books"] .collapse-toggle')
    settle(m)
    check("Books and items still collapses", m.locator("#books-body").is_hidden())
    return errors + errors_m


def part_cost_width(browser, base):
    """the tooltip is wide enough for its cost line when the enchantment's name is shorter (vanilla Lure on a fishing rod)"""
    _, p19, errors19 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p19.click('#wanted .item-button:has-text("Fishing Rod")')
    p19.click('#wanted .ench-row[data-ns="lure"] .level-seg[data-level="1"]')
    p19.wait_for_selector("#results .anvil-step")
    p19.wait_for_function("document.querySelector('#item .wanted-preview .cost-line:not(.idle) .cost-line-text') && document.querySelector('#item .wanted-preview .cost-line-text').textContent.includes('Levels')")
    settle(p19)
    fits = p19.evaluate("""() => { const tip = document.querySelector('#item .wanted-preview .mc-tooltip').getBoundingClientRect(); const text = document.querySelector('#item .wanted-preview .cost-line-text').getBoundingClientRect(); return [Math.round(text.right), Math.round(tip.right)]; }""")
    check("a tooltip with one short enchantment still fits its cost line", fits[0] <= fits[1], fits)
    return errors19


def part_pick_each(browser, base):
    """Pick one in each, as nested sections (made up: Mod H conflicts with everything, Mod A1/A2 and Mod B1/B2 are two Pick ones)"""
    edges = {"h": ["a1", "a2", "b1", "b2"], "a1": ["a2"], "b1": ["b2"]}
    context, p20, errors20, _ = mocked_mod_page(browser, base, edges)
    section = p20.locator("#wanted .pick-groups")
    check("the hub is a side of its own, and the two groups it joins are Pick one sections in the other side",
          [t.lower() for t in section.locator(".side-badge").all_inner_texts()] == ["side 1", "side 2"] and [t.lower() for t in section.locator(".label-title").all_inner_texts()] == ["pick one", "pick one"]
          and section.locator('.switch-option[data-opt="spellbound:h"]').count() == 1, section.inner_text())
    tip = section.locator(".switch-option", has_text="Mod H").first.get_attribute("title")
    check("a chip's tooltip is the enchantment's description, with no Replaces note", tip == "Test enchantment h", tip)
    pick = lambda text: section.locator(".switch-option", has_text=text).first
    pick("Mod A1").click()
    pick("Mod B1").click()
    settle(p20)
    chosen = p20.eval_on_selector_all("#wanted .ench-row.chosen", "e => e.map(x => x.dataset.ns)")
    check("one pick in each group stays together, the chosen rows shown once under the sections", sorted(chosen) == ["spellbound:a1", "spellbound:b1"] and section.locator(".each-rows > .ench-row.chosen").count() == 2, chosen)
    pick("Mod H").click()
    settle(p20)
    check("the hub replaces the picks of both groups", p20.eval_on_selector_all("#wanted .ench-row.chosen", "e => e.map(x => x.dataset.ns)") == ["spellbound:h"])
    pick("Mod A2").click()
    settle(p20)
    check("a pick in a group replaces the hub", p20.eval_on_selector_all("#wanted .ench-row.chosen", "e => e.map(x => x.dataset.ns)") == ["spellbound:a2"])
    pick("Mod A1").click()
    settle(p20)
    check("a pick in the same group replaces its pick", p20.eval_on_selector_all("#wanted .ench-row.chosen", "e => e.map(x => x.dataset.ns)") == ["spellbound:a1"])
    pick("Mod A1").click()
    settle(p20)
    p20.fill(".wanted-search", "mod h")
    settle(p20)
    check("a search that hits one option shows the whole section", p20.locator("#wanted .pick-groups").count() == 1 and p20.locator("#wanted .pick-groups .switch-option").count() == 5)
    p20.fill(".wanted-search", "")
    settle(p20)
    check("no page errors in Pick one in each", not errors20, errors20)
    context.close()
    return errors20


def part_pick_side(browser, base):
    """Pick a side, as nested sections (made up: Mod A1-A3 against Mod B1-B2, every pair across conflicting)"""
    edges = {a: ["b1", "b2"] for a in ("a1", "a2", "a3")}
    context, p21, errors21, _ = mocked_mod_page(browser, base, edges, singles=["z"])  # (Mod Z gives the mod's section a second group, so each is a subsection)
    section = p21.locator("#wanted .pick-groups")
    check("each side is a Pick any lane marked by a badge, and no list of names is a title",
          [t.lower() for t in section.locator(".label-title").all_inner_texts()] == ["pick any", "pick any"] and section.locator(".side-badge").count() == 2 and "Any of" not in section.inner_text())
    check("the group is named Pick a side, with its size", section.locator("xpath=ancestor::details[contains(@class, 'group-fold')]/summary").inner_text().lower() == "pick a side (5)")
    lane = lambda number: section.locator(".side-lane").nth(number)
    lane(0).locator(".switch-option").nth(0).click()
    lane(0).locator(".switch-option").nth(1).click()
    settle(p21)
    check("any number can be picked inside one side, and that side is outlined", section.locator(".each-rows > .ench-row.chosen").count() == 2 and section.locator(".side-lane.active").count() == 1)
    lane(1).locator(".switch-option").nth(0).click()
    settle(p21)
    check("a pick from the other side replaces them all", section.locator(".each-rows > .ench-row.chosen").count() == 1 and section.locator(".side-lane.active").count() == 1)
    section.locator(".switch-option.selected").first.click()
    settle(p21)
    p21.fill(".wanted-search", "mod a2")
    settle(p21)
    check("searching for one option shows the whole section, and nothing loose beside it", p21.locator("#wanted .pick-groups .switch-option").count() == 5 and p21.locator("#wanted .ench-row").count() == 0)
    p21.fill(".wanted-search", "")
    settle(p21)
    check("no page errors in Pick a side", not errors21, errors21)
    context.close()
    return errors21


def mock_mod(edges=None, item="sword", levels=None, vanilla=None, singles=(), label="Spellbound"):
    """a made-up mod (it replaces Spellbound's file): `edges` conflicts among its enchantments, `vanilla` conflicts with the game's, `levels`
    max levels, `singles` enchantments with no conflicts; names are Mod A, Mod B..."""
    edges, levels, vanilla = edges or {}, levels or {}, vanilla or {}
    keys = sorted(set(edges) | {x for v in edges.values() for x in v} | set(vanilla) | set(singles))
    def rivals(k):
        return ["spellbound:" + o for o in keys if k in edges.get(o, []) or o in edges.get(k, [])] + list(vanilla.get(k, []))
    return {"id": "spellbound", "label": label, "note": "test", "source": "https://example.test",
            "enchantments": {"spellbound:" + k: {"incompatible": rivals(k), "items": [item], "max_level": levels.get(k, 1), "weight": 1} for k in keys},
            "names": {"en": {"spellbound:" + k: "Mod " + k.upper() for k in keys}}, "descriptions": {"en": {"spellbound:" + k: "Test enchantment " + k for k in keys}}}


def mocked_context(browser, mod, **options):
    """a context where the Spellbound file is the made-up mod (the service worker is blocked, or it would answer from its cache)"""
    import json as json_module
    options.setdefault("viewport", {"width": 1280, "height": 1100})
    context = browser.new_context(service_workers="block", **options)
    context.set_default_timeout(DEFAULT_TIMEOUT_MS)
    context.route("**/json/mods/spellbound.json*", lambda route: route.fulfill(content_type="application/json", body=json_module.dumps(mod)))
    return context


def mocked_mod_page(browser, base, edges=None, item="sword", open_section=True, **kinds):
    """a page with a made-up mod (see mock_mod) switched on and the item picked; returns context, page, errors, the mod"""
    mod = mock_mod(edges, item, **kinds)
    context = mocked_context(browser, mod)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#wanted .item-grid")
    page.click('#wanted .item-button:has-text("' + item.replace("_", " ").title() + '")')
    page.click("#options-menu summary")
    page.click('#limit-panel [data-focus="mod-spellbound"]')
    page.wait_for_selector('#limit-panel [data-focus="mod-spellbound"][aria-checked="true"]')
    page.keyboard.press("Escape")
    settle(page)
    if open_section and page.locator("#wanted .mod-section").count():
        page.click('#wanted .mod-section[data-mod="Spellbound"] > summary')
    return context, page, errors, mod


def part_plain_bracket(browser, base):
    """a bracket that cannot be split even with three strays stays a plain Some conflict bracket: folding and the Conflicts with chip"""
    letters = "abcdefghijklmnop"
    edges = {letters[i]: [letters[i + 1]] for i in range(15)}  # a path of sixteen: it needs four strays
    context, p, errors, _ = mocked_mod_page(browser, base, edges)
    check("a path of sixteen is a plain bracket", p.locator("#wanted .ench-group:not(.exclusive)").count() == 1 and p.locator("#wanted .pick-groups").count() == 0)
    toggle = p.locator("#wanted .ench-group:not(.exclusive) > .group-toggle").first
    before = p.locator("#wanted .ench-group:not(.exclusive) >> nth=0 >> .ench-row:visible").count()
    toggle.click()
    check("a conflict bracket folds from its label, hiding rows that are not chosen", p.locator("#wanted .ench-group.folded").count() == 1 and p.locator("#wanted .ench-group.folded .ench-row:visible").count() < before)
    settle(p)
    above = p.evaluate("""() => { const bars = [...document.querySelectorAll('#wanted .level-bar')]; const i = bars.findIndex(b => !b.checkVisibility());
        if (i < 1) return false; bars[i - 1].focus(); return true; }""")
    p.keyboard.press("ArrowDown")
    check("Down skips the level bars of a folded group", above and p.evaluate("document.activeElement.classList.contains('level-bar') && document.activeElement.checkVisibility()"))
    toggle.click()
    check("and unfolds again", p.locator("#wanted .ench-group.folded").count() == 0 and p.locator("#wanted .ench-group:not(.exclusive) >> nth=0 >> .ench-row:visible").count() == before)
    chip = p.locator("#wanted .ench-group:not(.exclusive) .conflict-chip").nth(1)
    check("rows in a conflict bracket have a chip with how many they conflict with", "Conflicts with" in chip.inner_text(), chip.inner_text())
    p.locator("#wanted .ench-group:not(.exclusive) .ench-row").first.hover()
    check("hovering a row alone shows no tooltip and no highlight", p.locator(".conflict-tip").count() == 0 and p.locator("#wanted .rival").count() == 0)
    chip.hover()
    p.wait_for_selector(".conflict-tip")
    lit = p.locator("#wanted .rival").count()
    check("hovering the chip lights the rows it conflicts with and lists them", "Conflicts with" in p.inner_text(".conflict-tip") and lit >= 1, (lit, p.inner_text(".conflict-tip")))
    p.mouse.move(0, 0)
    settle(p)
    check("both go when the pointer leaves", p.locator(".conflict-tip").count() == 0 and p.locator("#wanted .rival").count() == 0)
    chip.click()
    p.mouse.move(0, 0)
    settle(p)
    check("clicking the chip keeps the tooltip and the highlights", p.locator(".conflict-tip").count() == 1 and p.locator("#wanted .rival").count() == lit and chip.get_attribute("aria-pressed") == "true")
    p.click("#wanted .wanted-search")
    check("a click elsewhere lets go of them", p.locator(".conflict-tip").count() == 0 and p.locator("#wanted .rival").count() == 0)
    chip.click()
    p.keyboard.press("Escape")
    check("Escape lets go of them too", p.locator(".conflict-tip").count() == 0 and p.locator("#wanted .rival").count() == 0)
    check("no page errors in the plain bracket", not errors, errors)
    context.close()


def part_several_groups(browser, base):
    """Several groups: a bracket that splits again and again (a stand-in mod gives the shape: the real mods now need strays)"""
    # h conflicts with everything; {p, q} and {r, s, t} are each every-pair-conflicting but never conflict with each other; u and v conflict with all of those but not each other.
    names = "hpqrstuv"
    pairs = {"h": "pqrstuv", "p": "quv", "q": "uv", "r": "stuv", "s": "tuv", "t": "uv", "u": "", "v": ""}
    # u and v conflict with p, q, r, s, t and h (listed from the lower side only)
    edges = {k: list(v) for k, v in pairs.items()}
    context, p, errors, _ = mocked_mod_page(browser, base, edges)
    section = p.locator("#wanted .pick-groups")
    check("the bracket is one Several groups card, with the sides of its Pick a side marked",
          section.count() == 1 and [t.lower() for t in section.locator(".side-badge").all_inner_texts()] == ["side 1", "side 2", "side 3"], section.locator(".side-badge").all_inner_texts())
    check("Pick one and Pick any are labels inside the sides, and no side repeats a list of names as a title",
          [t.lower() for t in section.locator(".label-title").all_inner_texts()] == ["pick one", "pick one", "pick any"] and "One of" not in section.inner_text() and "Any of" not in section.inner_text(), section.locator(".label-title").all_inner_texts())
    headers = [h.lower() for h in p.eval_on_selector_all("#wanted .group-fold > summary", "e => e.map(x => x.textContent.trim())")]
    check("the game's list has a No conflicts (lone enchantments) and a Pick one subsection, named by type and size", len(headers) == 3 and headers[0].startswith("no conflicts (") and headers[1].startswith("pick one (") and headers[2].startswith("curses ("), headers)
    # Round 2: the curses fold like the other groups, and every fold marker is the one chevron.
    curses = p.locator('#wanted .group-fold[data-fold="curses"]')
    curses.locator("> summary").click(); settle(p)
    check("Curses is a fold-away group of its own, closed by its header", not p.evaluate("document.querySelector('#wanted .group-fold[data-fold=\"curses\"]').open"))
    check("the fold markers are one chevron (no text arrows), turning with the state", p.evaluate("""() => { const t = el => getComputedStyle(el, '::before').content; const summary = document.querySelector('#wanted .group-fold > summary'); const closed = document.querySelector('#wanted .group-fold[data-fold="curses"] > summary'); return t(summary) === '""' && t(document.querySelector('#steps .collapse-toggle, .collapse-toggle')) === '""' && getComputedStyle(summary, '::before').transform !== getComputedStyle(closed, '::before').transform; }"""))
    curses.locator("> summary").click(); settle(p)
    check("a section with a single group (the mod's) shows it without a subsection or a second header", section.locator("xpath=ancestor::details[contains(@class, 'group-fold')]").count() == 0 and p.locator("#wanted .ench-group-label").count() == 0)
    first = p.locator("#wanted .group-fold > summary").nth(1)
    first.click()
    settle(p)
    check("a group folds away from its header, and opens again", not p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    first.click()
    settle(p)
    check("and it opens again", p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    section.locator(".switch-option", has_text="Mod P").click()
    section.locator(".switch-option", has_text="Mod R").click()
    settle(p)
    check("one pick in each nested Pick one stays together", section.locator(".each-rows > .ench-row.chosen").count() == 2)
    section.locator(".switch-option", has_text="Mod Q").click()
    settle(p)
    check("a pick in the same Pick one replaces its pick", section.locator(".each-rows > .ench-row.chosen").count() == 2 and section.locator(".switch-option.selected", has_text="Mod P").count() == 0)
    section.locator(".switch-option", has_text="Mod U").click()
    settle(p)
    check("a pick from another side replaces everything", section.locator(".each-rows > .ench-row.chosen").count() == 1)
    check("no page errors in Several groups", not errors, errors)
    context.close()


def part_fold_all(browser, base):
    """Expand all / Collapse all, the list's order and folding, the conflict graph (vanilla boots and sword: no mod needed)"""
    _, p, errors = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p.click('#wanted .item-button:has-text("Boots")')
    p.wait_for_selector("#wanted .ench-group.exclusive")
    heads = p.evaluate("""() => [...document.querySelectorAll('#wanted .wanted-list > .group-fold > summary')].map(el => el.textContent.trim().toLowerCase())""")
    check("the list starts with the lone enchantments in a No conflicts subsection, then the groups", heads and heads[0].startswith("no conflicts (") and len(heads) > 1 and not any(h.startswith("no conflicts") for h in heads[1:]), heads)
    check("the No conflicts subsection holds plain rows", p.locator("#wanted .wanted-list > .group-fold >> nth=0 >> .ench-row").count() == int(heads[0].split("(")[1].rstrip(")")))
    check("the fold buttons sit to the right of the search box", p.evaluate("""() => { const input = document.querySelector('#wanted .wanted-search').getBoundingClientRect(), buttons = document.querySelector('#wanted .search-row .fold-buttons').getBoundingClientRect(); return buttons.left >= input.right - 1 && Math.abs(buttons.top - input.top) < 40; }"""))
    # The presets are the same whether or not conflicts are allowed.
    preset_row = lambda: p.eval_on_selector_all("#item .presets button, #item .preset-chips button", "e => e.map(x => x.textContent.trim())")
    presets_before = preset_row()
    p.click("#options-menu summary")
    p.click("#limit-panel .rule-switch")
    p.keyboard.press("Escape")
    settle(p)
    check("Allow conflicts keeps the same presets", presets_before and preset_row() == presets_before, (presets_before, preset_row()))
    titles = p.eval_on_selector_all("#wanted .wanted-list > .group-fold > summary", "e => e.map(x => x.textContent)")
    names = p.eval_on_selector_all("#wanted .pick-any-list .ench-title", "e => e.map(x => x.firstChild.textContent)")
    check("with conflicts allowed every enchantment is in one No conflicts group, alphabetical, with no conflict marks or graph",
          len(titles) >= 1 and titles[0].startswith("No conflicts") and all(not t.startswith("Pick") for t in titles) and names == sorted(names) and len(names) > 3
          and p.locator("#wanted .conflict-chip, #wanted .ench-group, #wanted .graph-box").count() == 0, (titles, names))
    p.click("#options-menu summary")
    p.click("#limit-panel .rule-switch")
    p.keyboard.press("Escape")
    settle(p)
    p.click("#wanted .graph-box > summary")
    p.wait_for_selector(".graph-canvas")
    check("the fold toggle starts as Collapse (the list is open)", p.get_attribute("#wanted .fold-toggle", "data-action") == "collapse")
    offer_wanted_fold(p, "expand")
    p.click('#wanted .fold-toggle[data-action="expand"]')
    settle(p)
    open_count = lambda: p.evaluate("[...document.querySelectorAll('#wanted details')].filter(d => d.open).length")
    total = p.evaluate("document.querySelectorAll('#wanted details').length")
    check("Expand all opens every fold-away box and group", open_count() == total and total >= 4, (open_count(), total))
    settle(p)
    offer_wanted_fold(p, "collapse")
    p.click('#wanted .fold-toggle[data-action="collapse"]')
    settle(p)
    check("Collapse all closes them all", open_count() == 0)
    offer_wanted_fold(p, "expand")
    p.click('#wanted .fold-toggle[data-action="expand"]')
    settle(p)
    check("and Expand all opens them again", open_count() == total)
    # The groups sit directly in the section (no box around them); a group folds from its own heading.
    check("the groups sit directly in the section", p.locator("#wanted > .wanted-list > .group-fold").count() > 0)
    first = p.locator("#wanted .group-fold > summary").nth(1)
    first.click()
    settle(p)
    check("a group folds away from its header", not p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    first.click()
    settle(p)
    check("and opens again", p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    # The conflict graph: a node per conflicting enchantment, a line per conflict, hover and click.
    check("the conflict graph draws a node per conflicting enchantment and a line per conflict", p.locator(".graph-node").count() >= 6 and p.locator(".graph-edge").count() >= 6)
    p.locator('.graph-node[data-ns="blast_protection"]').scroll_into_view_if_needed()
    settle(p)  # (the item bar condensing eases the page's length: hover once it has settled)
    p.hover('.graph-node[data-ns="blast_protection"]')
    check("hovering a node lights its conflicts and names them", p.locator(".graph-node.near").count() >= 3 and "Fire Protection" in p.inner_text(".graph-caption"))
    p.click('.graph-node[data-ns="blast_protection"]')
    settle(p)
    check("clicking a node chooses it, and the graph stays open", p.locator(".graph-node.chosen").count() == 1 and p.locator('#wanted .ench-row.chosen[data-ns="blast_protection"]').count() == 1 and p.locator(".graph-canvas").is_visible())
    p.click('.graph-node[data-ns="blast_protection"]')
    settle(p)
    p.fill(".wanted-search", "protect")
    settle(p)
    check("the graph rings the nodes that match and fades the rest", p.locator(".graph-node.match").count() > 0 and p.locator(".graph-node.unmatched").count() > 0)
    p.fill(".wanted-search", "")
    settle(p)
    p.set_viewport_size({"width": 360, "height": 900})
    check("on a narrow screen the icons stay inside the card, beside or below the search box", p.evaluate("""() => { const input = document.querySelector('#wanted .wanted-search').getBoundingClientRect(), buttons = document.querySelector('#wanted .search-row .fold-buttons').getBoundingClientRect(), card = document.querySelector('#wanted').getBoundingClientRect(); return buttons.right <= card.right + 1 && (buttons.left >= input.right - 1 || buttons.top >= input.bottom - 1); }"""))
    check("no page errors with the fold buttons", not errors, errors)


def part_stray_groups(browser, base):
    """a stray and a first level of parts (made up: Mod A1-A2 and Mod B1-B2 are two Pick ones, and Mod S conflicts with Mod A1 and Mod B1 only)"""
    edges = {"a1": ["a2", "s"], "b1": ["b2", "s"]}
    context, p, errors, _ = mocked_mod_page(browser, base, edges, singles=["z"])  # (Mod Z gives the mod's section a second group, so each is a subsection)
    section = p.locator("#wanted .pick-groups")
    summary = section.locator("xpath=ancestor::details[contains(@class, 'group-fold')]/summary")
    check("a group whose first level is parts that never conflict is named Pick any part, with its size", summary.inner_text().lower() == "pick any part (5)", summary.inner_text())
    badges = [t.lower() for t in section.locator(".part-badge").all_inner_texts()]
    check("its parts are marked Part 1, Part 2", badges == ["part 1", "part 2"], badges)
    bridges = section.locator(".switch-option.bridge")
    stray_ns = bridges.first.get_attribute("data-opt")  # (which of the equally small choices is set apart is up to the grouping)
    stray = section.locator('.switch-option.bridge[data-opt="%s"]' % stray_ns)
    check("the stray shows in each lane it conflicts with, marked with an arrow pair, and nowhere else", stray.count() >= 2 and bridges.count() == stray.count(), (stray_ns, stray.count(), bridges.count()))
    title = stray.first.get_attribute("title")
    rivals = re.split(r", | and ", title.split("Also conflicts with: ")[1])  # (the names read as a list: "A, B and C")
    check("its tooltip is its description, then everything it conflicts with", title.startswith("Test enchantment") and len(rivals) >= 2, title)
    check("a stray does not fade while what it conflicts with is not chosen", section.locator(".switch-option.blocked").count() == 0)
    section.locator(".switch-option:not(.bridge)", has_text=rivals[0]).first.click()
    settle(p)
    check("it fades while something it conflicts with is chosen", section.locator(".switch-option.blocked").count() == stray.count())
    stray.first.click()
    settle(p)
    check("choosing the stray replaces everything it conflicts with, in every lane", section.locator(".each-rows > .ench-row.chosen").count() == 1 and section.locator(".switch-option.selected").count() == stray.count())
    check("no page errors with a stray", not errors, errors)
    context.close()
    return errors


def part_links(browser, base):
    """loading setups: a saved setup and a pasted link with a mod (the workers learn its data), a Bedrock link, corrupt storage"""
    import base64
    import json as json_module
    mod = mock_mod(singles=["c"], levels={"c": 2})
    context = mocked_context(browser, mod)
    errors = []
    def new_page():
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        return page
    p1 = new_page()
    p1.goto(base)
    p1.wait_for_selector("#wanted .item-grid")
    p1.click('#wanted .item-button:has-text("Sword")')
    p1.click("#options-menu summary")
    p1.click('#limit-panel [data-focus="mod-spellbound"]')
    p1.wait_for_selector('#limit-panel [data-focus="mod-spellbound"][aria-checked="true"]')
    p1.keyboard.press("Escape")
    p1.click('#wanted .mod-section[data-mod="Spellbound"] > summary')
    p1.click('#wanted .ench-row[data-ns="spellbound:c"] .level-seg[data-level="2"]')
    p1.wait_for_selector("#results .anvil-step")
    settle(p1)
    link = p1.evaluate("location.hash")
    p1.click('#item [data-focus="saved-add"]')
    p1.fill("#item .saved-form input[type=text]", "Modded")
    p1.click("#item .saved-form button[type=submit]")

    # A link pasted into the open page loads, mod and all, and the search knows the mod's enchantments.
    p2 = new_page()
    p2.goto(base)
    p2.click("#wanted .example")
    p2.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p2)
    p2.evaluate("hash => { location.hash = hash; }", link)
    p2.wait_for_selector('#wanted .ench-row.chosen[data-ns="spellbound:c"]')
    p2.wait_for_function("document.querySelector('#results').textContent.includes('Mod C')", timeout=8000)
    check("a link pasted into the open page loads, with its mod", link_data(p2)["i"] == "sword" and "nknown" not in p2.inner_text("#results"), p2.inner_text("#results")[:200])

    # A saved setup with a mod, loaded (from the first screen's list) in a page that started without it: its mod comes on with it (as do its edition and
    # Allow conflicts), its enchantment is chosen, the search knows it, and the item card says which rule it changed.
    p3 = new_page()
    p3.goto(base)
    p3.wait_for_selector("#wanted .saved-first .saved-load")
    check("the first screen lists your saved setups", p3.locator("#wanted .saved-first li", has_text="Modded").count() == 1)
    p3.click("#wanted .saved-first .saved-load")
    p3.wait_for_selector('#wanted .ench-row.chosen[data-ns="spellbound:c"]')
    p3.wait_for_function("document.querySelector('#results').textContent.includes('Mod C')", timeout=8000)
    note = p3.inner_text("#item .saved-warning")
    check("loading it turns its mod on, gets a result, and says the mod was switched on", "nknown" not in p3.inner_text("#results") and "Spellbound" in note and link_data(p3).get("d") == ["spellbound"], (note, p3.inner_text("#results")[:120]))

    # A Bedrock link keeps what only Bedrock offers (Curse of Vanishing on a recovery compass).
    bedrock = base64.urlsafe_b64encode(json_module.dumps({"i": "recovery_compass", "w": {"vanishing_curse": 1}, "a": 1, "b": [], "e": 1}).encode()).decode().rstrip("=")
    p4 = new_page()
    p4.goto(base + "#" + bedrock)
    p4.wait_for_selector("#item .wanted-preview")
    check("a Bedrock link keeps Bedrock's own enchantments", p4.locator('#wanted .ench-row.chosen[data-ns="vanishing_curse"]').count() == 1)

    # Corrupt values in storage are ignored.
    p4.evaluate("""() => { localStorage.setItem('enchantment-calculator-collapsed', '5'); localStorage.setItem('enchantment-calculator-level', '"x"');
        localStorage.setItem('enchantment-calculator-language', '{"a": 1}'); localStorage.setItem('enchantment-calculator-checklist', '{"key": "k", "done": 5}'); }""")
    p4.goto(base)
    p4.wait_for_selector("#wanted .item-grid")
    check("corrupt values in storage don't stop the page", p4.locator(".card.collapsible.collapsed").count() == 0)
    context.close()
    return errors


def part_narrow_results(browser, base):
    """section 4 on a narrow window: tree lines, view cross-fade, Expand all"""
    # Section 4 on a narrow window: the full tree lists each enchantment on its own line; views cross-fade; Expand/Collapse all ease.
    _, p18, errors18 = open_page(browser, base, viewport={"width": 500, "height": 900})
    pick_helmet_max(p18)
    p18.click('#results [data-view="tree"]')
    p18.wait_for_selector("#results .merge-tree")
    if "compact" in p18.get_attribute("#results .merge-tree", "class"):
        p18.click("#results .density")
    p18.wait_for_selector("#results .merge-tree:not(.compact)")
    tops = p18.evaluate("""() => { const tip = [...document.querySelectorAll('#results .tree-tooltip')].find(t => t.querySelectorAll('.mc-ench > .mc-ench').length > 1); return tip ? [...tip.querySelectorAll('.mc-ench > .mc-ench')].map(e => Math.round(e.getBoundingClientRect().top)) : []; }""")
    check("the full tree's tooltip has each enchantment on its own line on a narrow window", len(tops) > 1 and len(set(tops)) == len(tops), tops)
    p18.click('#results [data-view="steps"]')
    p18.wait_for_selector("#results .rounds")
    settle(p18)
    result = scrub(p18, "document.querySelector('#results .density').click();", "document.querySelectorAll('#results .steps-scroll, #results .card-frame').length")
    copies = result["values"]
    check("switching Steps to Compact morphs the cards (frames and a copy of the old view during it) and leaves nothing behind", max(copies) >= 3 and result["after"] == 1 and p18.locator("#results .results-content > .steps-scroll").count() == 1, copies)
    p18.click("#results .density")
    settle(p18)
    # Compact is one setting for both views: turned on in Steps it is on in the Tree, and the other way round.
    p18.click("#results .density")
    settle(p18)
    p18.click('#results [data-view="tree"]')
    settle(p18)
    in_tree = p18.get_attribute("#results .density", "aria-pressed") == "true" and "compact" in (p18.get_attribute("#results .merge-tree", "class") or "")
    p18.click("#results .density")
    settle(p18)
    p18.click('#results [data-view="steps"]')
    settle(p18)
    check("Compact is one setting for Steps and Tree (on in Steps, on in the Tree; off in the Tree, off in Steps)", in_tree and p18.get_attribute("#results .density", "aria-pressed") == "false" and p18.locator("#results .slots-mode").count() == 0)
    travel = p18.evaluate("""async () => {
        document.querySelector('#results [data-view="tree"]').click();
        const during = document.querySelectorAll('#results .steps-scroll > .view-overlay:not(.steps-scroll) > .card-frame').length;
        for (let waited = 0; waited < 6000 && document.querySelector('#results .morphing'); waited += 50) await new Promise(done => setTimeout(done, 50));
        return [during, document.querySelectorAll('#results .card-frame, #results .morphing').length];
    }""")
    check("each step is a travelling box while the view switches, and none is left once it has", travel[0] >= 1 and travel[1] == 0, travel)
    # Each caption of the compact Tree flies once, from where it is: the switch's own flyers are never taken for parts of the new view and flown again.
    p18.click('#results [data-view="tree"]')
    settle(p18)
    if "compact" not in (p18.get_attribute("#results .merge-tree", "class") or ""):
        p18.click("#results .density")
        settle(p18)
    captions = p18.locator("#results .tree-caption:visible").count()
    flown = p18.evaluate("""() => {
        document.querySelector('#results [data-view="steps"]').click();
        const flyers = [...document.querySelectorAll('#results .steps-scroll > .view-overlay:not(.steps-scroll) .tree-caption')];
        return [flyers.length, flyers.filter(f => getComputedStyle(f).visibility === 'visible').length];
    }""")
    check("each caption of the compact Tree flies once, and is seen (a flyer is never taken for part of the view and flown again)", captions > 0 and flown[0] == captions and flown[1] == captions, (captions, flown))
    settle(p18)
    # A flyer is the size it was given: a clone laid in the overlay takes no limit (a percentage max-width, a flex share) from the layer it is in, which cut a tooltip
    # to a sliver of itself for the whole flight.
    p18.click('#results [data-view="tree"]')
    settle(p18)
    p18.click('#results [data-view="steps"]')
    settle(p18)
    wrong = p18.evaluate("""() => {
        document.querySelector('#results [data-view="tree"]').click();
        const flyers = [...document.querySelectorAll('#results .steps-scroll > .view-overlay:not(.steps-scroll) > :not(.card-frame)')];
        return [flyers.length, flyers.map(e => [parseFloat(e.style.width), e.offsetWidth]).filter(([want, got]) => Math.abs(want - got) > 1).length];
    }""")
    check("every flyer is the size it was given", wrong[0] > 0 and wrong[1] == 0, wrong)
    settle(p18)
    p18.click('#results [data-view="steps"]')
    settle(p18)
    # A flyer lands where the real thing will be: laying the overlay over the scroller must not move the page's own parts (a flyer that brought a scroll bar to the page
    # narrowed the tree by its width while the badges were measured, and the real badges then snapped back to the right at the end).
    landing = p18.evaluate("""() => {
        document.querySelector('#results [data-view="tree"]').click();
        return [...document.querySelectorAll('#results .steps-scroll > .view-overlay:not(.steps-scroll) .tree-step')].map(f => [parseFloat(f.style.left), parseFloat(f.style.top)]);
    }""")
    settle(p18)
    real = p18.evaluate("""() => { const box = document.querySelector('#results .steps-scroll').getBoundingClientRect(); return [...document.querySelectorAll('#results .steps-scroll .tree-step')].map(b => { const r = b.getBoundingClientRect(); return [r.left - box.left, r.top - box.top]; }); }""")
    off = [max(abs(a[0] - b[0]), abs(a[1] - b[1])) for a, b in zip(sorted(landing), sorted(real))]
    check("every badge flyer lands exactly where the real badge is", len(landing) > 0 and len(landing) == len(real) and max(off) < 2, (len(landing), len(real), max(off) if off else None))
    # The overlay is always the size of the scroller, which eases its height when the tree gets taller (Compact to the full Tree): a layer fixed at the height it had
    # when the overlay went up cut off the bottom of the taller tree, tooltips and all, for the whole flight.
    if "compact" not in (p18.get_attribute("#results .merge-tree", "class") or ""):
        p18.click("#results .density")
        settle(p18)
    grown = p18.evaluate("""async () => {
        document.querySelector('#results .density').click();
        const box = document.querySelector('#results .steps-scroll');
        const heights = [];
        const gaps = [];
        await new Promise(done => { let left = 24; const tick = () => {
            const layer = box.querySelector(':scope > .view-overlay:not(.steps-scroll)');
            if (layer) { heights.push(box.clientHeight); gaps.push(Math.abs(layer.offsetHeight - box.clientHeight)); }
            if (--left > 0) requestAnimationFrame(tick); else done(); }; tick(); });
        return [Math.max(...heights) - Math.min(...heights), Math.max(...gaps)];
    }""")
    check("the overlay keeps the scroller's size while the scroller grows (the bottom of a taller tree is not cut off)", grown[0] > 10 and grown[1] <= 1, grown)
    settle(p18)
    p18.click('#results [data-view="steps"]')
    settle(p18)
    p18.click('#results [data-view="steps"]')
    settle(p18)
    heights = "[...document.querySelectorAll('#results .anvil-step')].map(e => Math.round(e.getBoundingClientRect().height))"
    result = scrub(p18, "document.querySelector('#results .fold-toggle').click();", heights)
    frames_seen = result["values"]
    first, last = frames_seen[0], result["after"]
    grown = [i for i in range(len(first)) if last[i] > first[i] + 20]
    mid = [f for f in frames_seen if any(first[i] + 10 < f[i] < last[i] - 10 for i in grown)]
    check("Expand all eases each step open instead of jumping", len(grown) > 0 and len(mid) >= 2, (first, last))
    return errors18


def pick_boots(page):
    """Boots with the first preset, until the steps show."""
    page.click('#wanted .item-grid button[data-focus="item-boots"]')
    choose_max(page)
    page.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(page)


def part_stage_hotbar(browser, base):
    """the section badges (checks, the amber Books !, the search's progress ring), the wide item card, the step hotbar (slots, current, jumps, phones) and the Next step card"""
    errors = []
    _, page, errs = open_page(browser, base, viewport={"width": 1280, "height": 760})
    errors += errs
    badges = lambda: page.evaluate("[...document.querySelectorAll('[data-section] > h2 .step-badge')].map(b => [" + MARK_JS + "(b), b.classList.contains('done'), b.classList.contains('warn')])")
    check("before an item the badges are 1, 3 and 4, plain (greyed)", badges() == [["1", False, False], ["3", False, False], ["4", False, False]], badges())
    check("before an item Books and Anvil uses are a heading and one muted line each", page.inner_text("#books") == "Pick an item first" and page.inner_text("#results") == "Pick an item first" and page.locator(".card.idle").count() == 2 and page.locator("#books").evaluate("e => e.closest('.card').getBoundingClientRect().height") < 90)
    pick_boots(page)
    check("with an item, enchantments and an order every badge is a check, and the Item card's too", badges() == [["\u2713", True, False]] * 3 and badge_mark(page, "#item .step-badge") == "\u2713", badges())
    check("a done heading says so to a screen reader", "done" in page.evaluate("(() => { const h = document.querySelector('[data-section=steps] h2'); return h.getAttribute('aria-labelledby').split(' ').map(id => document.getElementById(id).textContent).join(' '); })()"))
    # With nothing chosen, Enchantments' badge is the amber "!" too (there is nothing to calculate yet), and back to a check once one is.
    clear_all(page)
    settle(page)
    check("with no enchantment chosen, the Enchantments badge is an amber !", page.evaluate("[" + MARK_JS + "(document.querySelector('[data-section=wanted] .step-badge')),  document.querySelector('[data-section=wanted] .step-badge').classList.contains('warn')]") == ["!", True])
    choose_max(page)
    settle(page)
    check("and a check again once one is chosen", badge_mark(page, '[data-section="wanted"] .step-badge') == "✓")
    badge_bg = lambda: page.evaluate("getComputedStyle(document.querySelector('[data-section=steps] .step-badge')).backgroundColor")
    idle_bg = badge_bg()
    spin = lambda: page.evaluate("getComputedStyle(document.querySelector('[data-section=steps] .step-badge'), '::after').content")
    page.evaluate("document.documentElement.dataset.search = 'pending'")
    pending = page.evaluate("(() => { const s = getComputedStyle(document.querySelector('[data-section=steps] .step-badge'), '::after'); return [s.backgroundImage.includes('conic-gradient'), s.animationName]; })()")
    check("waiting to start, the badge already shows the (empty) progress ring, no spinner", pending == [True, "none"], pending)
    page.evaluate("document.documentElement.dataset.search = 'running'")
    running_bg, running_spin = badge_bg(), spin()
    ring = page.evaluate("getComputedStyle(document.querySelector('[data-section=steps] .step-badge'), '::after').backgroundImage")
    check("while it runs, the badge's ring is a progress ring filling with the search (Calc.js sets --search-share on it), and Section 4 has no progress bar of its own", "conic-gradient" in ring and page.evaluate("document.querySelector('[data-section=steps] .step-badge').style.getPropertyValue('--search-share') !== ''") and page.locator("#results .progress-track, #progress-fill").count() == 0, ring)
    page.evaluate("document.documentElement.dataset.search = 'idle'")
    check("the Anvil uses badge turns amber and spins while the search runs, and back once idle", running_bg != idle_bg and running_spin != "none" and badge_bg() == idle_bg and spin() == "none", (idle_bg, running_bg, running_spin))
    # The Books badge turns amber "!" while Section 3's alert badge shows, and back once it is fixed.
    page.click('[data-focus="mode-custom"]')
    page.click('#books button[aria-label^="Remove entry 2"]')
    settle(page)
    books_badge = page.locator('[data-section="books"] .step-badge')
    button = page.locator("#books-alert .info-tip-button")
    check("the Books badge is an amber ! while the books fall short, and that ! is the fixes menu's button (no separate triangle)",
          page.locator("#books-alert .info-tip").count() == 1 and "warn" in books_badge.get_attribute("class") and "problem" in page.inner_text("#books-state")
          and button.inner_text() == "!" and button.is_visible() and not books_badge.is_visible() and "⚠" not in page.inner_text('[data-section="books"] > h2')
          and abs(button.bounding_box()["x"] - page.locator('[data-section="wanted"] > h2 .step-badge').bounding_box()["x"]) < 2,
          page.evaluate("(() => { const b = document.querySelector('#books-alert .info-tip-button'); return [document.querySelector('#books-alert').outerHTML.slice(0, 200), b && b.textContent, b && Math.round(b.getBoundingClientRect().x), Math.round(document.querySelector('[data-section=wanted] > h2 .step-badge').getBoundingClientRect().x), getComputedStyle(document.querySelector('[data-section=books] > h2 .step-badge')).display]; })()"))
    button.hover()
    check("hovering the ! opens the menu of fixes, Switch to Automatic first", page.locator("#books-alert .info-tip-bubble").is_visible() and page.locator("#books-alert .fix-option").count() >= 2
          and "Automatic" in page.locator("#books-alert .fix-option").first.inner_text())
    page.mouse.move(0, 0)
    page.click('[data-focus="mode-auto"]')
    settle(page)
    check("fixed, the Books badge is a check again", "warn" not in books_badge.get_attribute("class") and badge_mark(page, '[data-section="books"] .step-badge') == "\u2713" and page.locator("#books-alert .info-tip").count() == 0)
    # The hotbar: in every view, Compact or not.
    steps = page.locator("#results .anvil-step").count()
    hot = page.locator("#results .step-hotbar")
    check("the hotbar shows in the full Steps view too", hot.is_visible() and page.locator("#results .hotbar-slot").count() == steps)
    page.click("#results .density")
    settle(page)
    slots = page.locator("#results .hotbar-slot")
    check("compact Steps shows a hotbar with a slot per step", hot.is_visible() and slots.count() == steps and steps > 3, (slots.count(), steps))
    check("the first step's slot is the selected one", page.locator("#results .hotbar-slot.current").count() == 1 and "current" in slots.nth(0).get_attribute("class"))
    check("enchanted results glint in the hotbar", page.locator("#results .hotbar-slot.glint").count() >= 1)
    check("the hotbar is one tab stop", page.locator('#results .hotbar-slot[tabindex="0"]').count() == 1)
    slots.first.hover()
    first_box = slots.first.locator(".hotbar-tip").bounding_box()
    card_box = page.locator('[data-section="steps"]').bounding_box()
    check("the first slot's tooltip is drawn whole (fixed to the window, so the card can't cut it off)", first_box and first_box["x"] >= 0 and page.evaluate("getComputedStyle(document.querySelector('#results .hotbar-slot .hotbar-tip')).position") == "fixed", (first_box, card_box))
    slots.last.hover()
    tip = slots.last.locator(".hotbar-tip")
    tip_box = tip.bounding_box()
    check("hovering a hotbar slot shows the game's tooltip: the name in its rarity colour, the enchantments, and no Step N line (the slot shows its number)", tip.is_visible() and tip.locator(".mc-name").count() == 1 and tip.locator(".mc-ench").count() >= 1 and "Step " not in tip.inner_text(), tip.inner_text() if tip.is_visible() else None)
    check("and it stays inside the window", tip_box and tip_box["x"] >= 0 and tip_box["x"] + tip_box["width"] <= page.viewport_size["width"], tip_box)
    check("hovering the last step's slot lights every Section 3 card that went into it", page.locator("#books .entry-card.highlight").count() == page.locator("#books .entry-card").count() and page.locator("#books .entry-card").count() > 1)
    slots.first.hover()
    check("and the first step's slot only its own inputs", 0 < page.locator("#books .entry-card.highlight").count() < page.locator("#books .entry-card").count())
    page.mouse.move(0, 0)
    slots.nth(0).focus()
    page.keyboard.press("ArrowRight")
    check("Right moves along the hotbar", page.evaluate("[...document.querySelectorAll('#results .hotbar-slot')].indexOf(document.activeElement)") == 1)
    slots.nth(3).click()
    settle(page)
    check("a click on a slot goes to that step", page.evaluate("document.activeElement.closest('[data-step-card]')?.dataset.stepCard") == "4" and page.locator('#results [data-step-card="4"]:not(.folded)').count() == 1)
    page.locator('#results input[data-step="1"]').check(force=True)
    settle(page)
    check("a done step's slot is dimmed with a check and the selection moves on", "done" in slots.nth(0).get_attribute("class") and slots.nth(0).locator(".hotbar-check").count() == 1 and "current" in slots.nth(1).get_attribute("class"))
    page.locator('#results input[data-step="1"]').uncheck(force=True)
    settle(page)
    # The Next step card: while the current step is scrolled out of the steps' box, then tucked while it shows.
    page.click("#results .density")  # (full Steps again)
    page.click('#results [data-step-card="1"] .step-fold')  # (fold the current step to one short line)
    settle(page)
    # One page scrollbar: the steps scroll with the page, and the card sticks to the window's bottom.
    check("the steps have no scrollbar of their own", page.evaluate("getComputedStyle(document.querySelector('#results .steps-scroll')).overflowY") == "visible")
    page.evaluate("scrollTo(0, 0)")
    frames(page, 3)
    check("the Next step card is tucked while its step shows", page.evaluate("getComputedStyle(document.querySelector('#results .current-bar')).visibility") == "hidden")
    page.set_viewport_size({"width": page.viewport_size["width"], "height": 520})  # (short, so Step 1 leaves the window at the bottom)
    frames(page, 3)
    # (scrolled again on every try: under load the resize can still be settling the page's length when the first scroll lands)
    page.wait_for_function("() => { scrollTo(0, document.documentElement.scrollHeight); return getComputedStyle(document.querySelector('#results .current-bar')).visibility === 'visible'; }", polling=100)
    card = page.locator("#results .current-bar-card")
    inside = page.evaluate("() => { const c = document.querySelector('#results .current-bar-card').getBoundingClientRect(); return c.top >= 0 && c.bottom <= innerHeight + 1; }")
    check("the card shows with the step's three slots and Done once the step is scrolled away", card.is_visible() and page.locator("#results .current-bar .mini-slot").count() == 3 and "Step 1 of" in card.inner_text() and inside, card.inner_text())
    check("the right column ends at the window's bottom", page.evaluate("Math.abs(document.querySelector('.results-column').getBoundingClientRect().bottom - (innerHeight - 16)) < 3 || document.querySelector('.results-column').getBoundingClientRect().bottom <= innerHeight"))
    page.click("#results .current-bar .btn.primary")
    settle(page)
    check("its Done button ticks the step like the step's own circle", page.locator('#results input[data-step="1"]').is_checked() and "Step 2 of" in page.locator("#results .current-bar-card").text_content(), page.locator("#results .current-bar-card").text_content())
    # The header fits one line at 1100px.
    _, tab, errs = open_page(browser, base, viewport={"width": 1100, "height": 800})
    errors += errs
    pick_boots(tab)
    check("at 1100px the header is one line", tab.evaluate("(() => { const h = document.querySelector('.site-header'); return h.getBoundingClientRect().height < 80 && document.querySelector('.header-actions').getBoundingClientRect().top < document.querySelector('h1').getBoundingClientRect().bottom; })()"))
    # The wide item card (900 to 1359px) uses its width: the item on the left, the name box and presets beside it.
    wide = tab.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const p = r('#item .wanted-preview'), n = r('#item .anvil-name'), c = r('#item .wanted-controls'), i = r('#item'); return [n.left >= p.right - 1, c.left >= p.right - 1, n.top < c.top, c.right <= i.right, p.left < i.left + 40]; })()")
    check("at 1100px the item card puts the name box and presets in a column beside the item", all(wide), wide)
    tab.set_viewport_size({"width": 1440, "height": 900})
    settle(tab)
    narrow_card = tab.evaluate("(() => { const r = s => document.querySelector(s).getBoundingClientRect(); return [r('#item .anvil-name').bottom <= r('#item .wanted-controls').top + 1, r('#item .wanted-controls').bottom <= r('#item .wanted-preview').top + 1]; })()")
    check("at 1440 the floating card keeps the stack: name box, presets, item", all(narrow_card), narrow_card)
    # Phones: the hotbar stands in for the XP bar, its text stays.
    _, ph, errs = open_page(browser, base, viewport={"width": 320, "height": 800}, is_mobile=True, has_touch=True)
    errors += errs
    pick_boots(ph)
    check("on a phone the hotbar shows, with no \"3 of 7 done\" text under it", ph.locator("#results .step-hotbar").is_visible() and ph.locator("#results .step-progress-text").count() == 0)
    check("the phone hotbar has a slot per step inside the card", ph.locator("#results .hotbar-slot").count() == ph.locator("#results .anvil-step").count() and ph.evaluate("(() => { const c = document.querySelector('.results-card').getBoundingClientRect(); return [...document.querySelectorAll('#results .hotbar-slot')].every(s => { const r = s.getBoundingClientRect(); return r.right <= c.right && r.left >= c.left; }); })()"))
    check("nothing overflows at 320px", ph.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    ph.locator("#results .hotbar-slot").nth(4).click()
    settle(ph)
    check("a phone's slot jumps to its step", ph.evaluate("document.activeElement.closest('[data-step-card]')?.dataset.stepCard") == "5")
    return errors


def part_layout(browser, base):
    """no sideways scroll on the first screen with a mouse, tooltips kept in the window, phone steps, the settings panel"""
    errors = []
    # The first screen (the item grid) with a mouse: no sideways scroll, and a tooltip near the edge stays inside the window.
    for width in (320, 390, 768):
        _, page, errs = open_page(browser, base, viewport={"width": width, "height": 800})
        errors += errs
        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check("the first screen has no sideways scroll at %dpx" % width, over <= 0, over)
        page.locator("#wanted .item-button").last.hover()
        box = page.evaluate("""() => { const b = document.querySelector('#wanted .item-button:hover .item-tip'); const r = b && b.getBoundingClientRect(); return r && [Math.round(r.left), Math.round(r.right), document.documentElement.clientWidth]; }""")
        check("a tooltip at the grid's edge stays inside the window at %dpx" % width, box is not None and box[0] >= 0 and box[1] <= box[2], box)
        check("a hidden tooltip takes no room", page.evaluate("getComputedStyle(document.querySelector('#wanted .item-button:not(:hover) .item-tip')).display") == "none")
    # The item slot's caret sits on the slot's corner and its menu opens under the slot, in every layout; the round labels are plain subheadings.
    for width in (390, 1100, 1440):
        _, wide, errs = open_page(browser, base, viewport={"width": width, "height": 900})
        errors += errs
        pick_boots(wide)
        wide.evaluate("scrollTo(0, 0)")
        spot = wide.evaluate("""() => { const s = document.querySelector('.item-menu-button').getBoundingClientRect(), c = document.querySelector('.item-menu-caret').getBoundingClientRect(); return [Math.abs(c.right - s.right) <= 8 && Math.abs(c.bottom - s.bottom) <= 8, getComputedStyle(document.querySelector('.item-menu-button')).position]; }""")
        check("the item slot's caret is on the slot's corner at %dpx" % width, spot[0] and spot[1] == "relative", spot)
        wide.click("#item .item-menu-button")
        wide.wait_for_selector("#item .item-menu")
        under = wide.evaluate("""() => { const s = document.querySelector('.item-menu-button').getBoundingClientRect(), m = document.querySelector('#item .item-menu').getBoundingClientRect(); return [Math.round(m.top - s.bottom), Math.round(m.left - s.left)]; }""")
        check("the item menu opens under the slot at %dpx" % width, (-4 <= under[0] <= 24) if width > 600 else under[0] > 0, under)
        wide.keyboard.press("Escape")
        label = wide.evaluate("""() => { const l = document.querySelector('#results .round-label'); const c = getComputedStyle(l); return [c.borderTopWidth, c.textTransform, c.backgroundColor]; }""")
        check("a round's label is plain uppercase text, not a pill, at %dpx" % width, label[0] == "0px" and label[1] == "uppercase", label)
    # A phone: Left, Right and Result one under another, full-width tooltips, no word broken.
    _, ph, errs = open_page(browser, base, viewport={"width": 320, "height": 800})
    errors += errs
    pick_boots(ph)
    ph.click("#results .density") # (a phone starts Compact in both views; this is the full Steps)
    settle(ph)
    cells = ph.evaluate("""() => { const step = document.querySelector('#results .anvil-step.current'); return [...step.querySelectorAll('.anvil-cell')].map(c => { const r = c.getBoundingClientRect(), t = c.querySelector('.mc-tooltip').getBoundingClientRect(); return [Math.round(r.top), Math.round(t.width)]; }); }""")
    check("on a phone the three slots stack with wide tooltips", len(cells) == 3 and cells[0][0] < cells[1][0] < cells[2][0] and min(w for _, w in cells) >= 120, cells)
    broken = ph.evaluate("""() => [...document.querySelectorAll('#results .anvil-step.current .mc-name')].filter(n => { const range = document.createRange(); range.selectNodeContents(n); return range.getClientRects().length > 1; }).map(n => n.textContent)""")
    check("no name in a step is split over lines", not broken, broken)
    menu = ph.locator("#results .share-menu")
    check("on a phone the same icons show", menu.is_visible() and ph.locator("#results .fold-toggle").is_visible())
    menu.locator("summary").click()
    check("Share holds the four actions", menu.locator(".copy-panel button").count() == 4)
    ph.keyboard.press("Escape")
    check("Escape closes the menu", not menu.evaluate("e => e.open"))
    # The current-step bar never sits over the step it stands for: with the step peeking in at the bottom edge it is tucked.
    ph.evaluate("""() => { const step = document.querySelector('#results .anvil-step.current'); window.scrollBy(0, step.getBoundingClientRect().top - (innerHeight - 40)); }""")
    frames(ph, 3)  # (the observer that tucks the bar away reports after a paint)
    covered = ph.evaluate("""() => { const bar = document.querySelector('#results .current-bar'); const head = document.querySelector('#results .anvil-step.current .step-head').getBoundingClientRect(); const b = getComputedStyle(bar).visibility === 'hidden' ? null : bar.getBoundingClientRect(); return Boolean(b && b.top < head.bottom && b.bottom > head.top && head.top < innerHeight); }""")
    check("the current-step bar does not cover its step's head", not covered)
    # A wide window keeps the buttons and has no menu.
    _, wide, errs = open_page(browser, base, viewport={"width": 1280, "height": 900})
    errors += errs
    pick_boots(wide)
    check("on a wide screen the same icons show as on a phone", wide.locator("#results .share-menu").is_visible() and wide.locator("#results .fold-toggle").is_visible() and wide.locator("#results .density").is_visible())
    # The settings panel: one label column for both sections, inside a short window (a phone on its side).
    _, land, errs = open_page(browser, base, viewport={"width": 740, "height": 360})
    errors += errs
    land.click("#options-menu summary")
    land.wait_for_selector("#limit-panel", state="visible")
    settle(land)
    frames(land)
    info = land.evaluate("""() => { const p = document.querySelector('#limit-panel'); return { bottom: p.getBoundingClientRect().bottom, height: innerHeight, scrolls: p.scrollHeight > p.clientHeight, xs: [...p.querySelectorAll('.option-control')].map(e => Math.round(e.getBoundingClientRect().left)) }; }""")
    check("the settings panel fits a short window and scrolls inside", info["bottom"] <= info["height"] and info["scrolls"], info)
    check("every control of the settings panel starts at the same x", len(set(info["xs"])) == 1, info["xs"])
    return errors


def part_motion_access(browser, base):
    """reduced motion stops every transition and the glint switch says so, headings and groups have proper names, bigger hit areas"""
    errors = []
    context = browser.new_context(viewport={"width": 1000, "height": 900}, reduced_motion="reduce")
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_selector("#wanted .item-grid")
    pick_boots(page)
    running = page.evaluate("""() => ['.cost-line', '.collapse-toggle', '.ench-book', '.hotbar-slot', '.current-bar', '.level-seg', '.rule-switch-track'].map(sel => { const el = document.querySelector(sel); return el ? [sel, getComputedStyle(el).transitionDuration, getComputedStyle(el, '::before').transitionDuration] : null; }).filter(Boolean).filter(([, a, b]) => a.split(', ').some(d => d !== '0s') || b.split(', ').some(d => d !== '0s'))""")
    check("with reduced motion no transition runs", not running, running)
    page.click("#options-menu summary")
    glint = page.locator('[data-focus="glints"]')
    check("with reduced motion the glint switch is off, disabled, and says why", glint.is_disabled() and glint.get_attribute("aria-checked") == "false" and "reduced motion" in page.inner_text("#limit-panel"))
    context.close()
    # Names: a heading is its title, not the badge digit and the summaries; aria-controls only while the item menu is open.
    _, p2, errs = open_page(browser, base, viewport={"width": 1000, "height": 900})
    errors += errs
    pick_boots(p2)
    names = p2.evaluate("""() => [...document.querySelectorAll('main h2')].map(h => [h.getAttribute('aria-labelledby') && document.getElementById(h.getAttribute('aria-labelledby').split(' ')[0]).textContent, h.querySelector('.step-badge').getAttribute('aria-hidden')])""")
    check("each section's heading is named by its title (and its state), never by the badge glyph", len(names) == 4 and all(t and a == "true" for t, a in names), names)
    check("the item menu button has no aria-controls while closed", p2.get_attribute(".item-menu-button", "aria-controls") is None)
    p2.click(".item-menu-button")
    check("and points at the menu while it is open", p2.get_attribute(".item-menu-button", "aria-controls") == "item-menu" and p2.locator("#item-menu").count() == 1)
    p2.keyboard.press("Escape")
    focus = p2.evaluate("""() => { const box = document.querySelector('.anvil-name'); box.querySelector('input').focus(); const s = getComputedStyle(box); return [s.outlineStyle, s.outlineWidth]; }""")
    check("the rename box has a 2px focus outline", focus == ["solid", "2px"], focus)
    # Sides, parts and Pick one groups: grouped and named, radios where exactly one can be taken.
    _, p3, errs = open_page(browser, base, viewport={"width": 1000, "height": 900})
    errors += errs
    p3.click('#wanted .item-grid button[data-focus="item-helmet"]')
    choose_max(p3)
    p3.wait_for_selector("#wanted .wanted-list")
    sides = p3.evaluate("""() => [...document.querySelectorAll('#wanted [role=group][aria-label^="Side "]')].map(e => e.getAttribute('aria-label'))""")
    radios = p3.evaluate("""() => [...document.querySelectorAll('#wanted [role=radiogroup]')].every(g => g.querySelectorAll('[role=radio]').length > 0)""")
    check("every radiogroup in section 1 holds radios", radios)
    check("sides, when there are any, are named 'Side n of m'", all(re.match(r"Side \d+ of \d+$", n) for n in sides), sides)
    # Touch screens: a tall hit area for the progress segments (on a phone the hotbar slots stand in for them); and with a mouse still 24px.
    _, p4, errs = open_page(browser, base, viewport={"width": 390, "height": 800}, is_mobile=True, has_touch=True)
    errors += errs
    pick_boots(p4)
    cell = p4.evaluate("(() => { const r = document.querySelector('.hotbar-slot').getBoundingClientRect(), b = getComputedStyle(document.querySelector('.hotbar-slot'), '::before'); return [Math.round(r.width), Math.round(r.height) + Math.round(-2 * parseFloat(b.top))]; })()")
    check("on touch the hotbar slots have a 40px tall hit area", cell[1] >= 40, cell)
    _, p5, errs = open_page(browser, base, viewport={"width": 1000, "height": 800})
    errors += errs
    pick_boots(p5)
    return errors

def eases(page, selector, click, prop="height"):
    """Clicks `click` and scrubs the animations it starts, reading `selector`'s height (or `prop`): how many distinct values it passed through (more than the two ends means it eased)."""
    result = scrub(page, "document.querySelector(%s).click();" % repr(click), "Math.round(document.querySelector(%s).getBoundingClientRect().%s * 10) / 10" % (repr(selector), prop))
    return len(set(result["values"])), result["values"]


def part_keys(browser, base):
    """skip links, one tab stop per group, the groups legend and shapes, distinct fold labels, the drag chip"""
    errors = []
    _, p, errs = open_page(browser, base, viewport={"width": 1280, "height": 900})
    errors += errs
    # Skip links: the first Tab stops, visible only while focused, and move the focus into the section (Anvil uses shows once an item is picked).
    check("with no item there is no skip link to Anvil uses", not p.locator('.skip-link[data-skip="steps"]').is_visible() and p.locator('[data-section="steps"]').is_hidden())
    p.click('#wanted .item-grid button[data-focus="item-boots"]')
    settle(p)
    p.reload()
    p.wait_for_selector("#item .wanted-preview")
    p.keyboard.press("Tab")
    first = p.evaluate("(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return [a.textContent, r.top >= 0 && r.bottom > 0]; })()")
    check("the first Tab stop is the 'Skip to the steps' link, on screen while focused", first == ["Skip to the steps", True], first)
    p.keyboard.press("Enter")
    check("a skip link moves the focus into its section", p.evaluate("document.activeElement.dataset.section") == "steps")
    check("a skip link that has no focus is out of sight", p.evaluate("document.querySelector('.skip-link').getBoundingClientRect().bottom") < 0)
    p.goto(base)
    p.wait_for_selector("#wanted .item-grid")
    pick_helmet_max(p)
    settle(p)
    offer_wanted_fold(p, "expand")
    p.click('#wanted .fold-toggle[data-action="expand"]')
    settle(p)
    # The two fold pairs are named apart.
    group_label = p.get_attribute("#wanted .fold-toggle", "aria-label")
    step_label = p.get_attribute("#results .fold-toggle", "aria-label")
    check("Enchantments' fold toggle says groups, Anvil uses' says steps", "groups" in group_label and step_label in ("Expand all steps", "Collapse all steps"), (group_label, step_label))
    check("after Expand all, the toggle offers Collapse", p.get_attribute("#wanted .fold-toggle", "data-action") == "collapse")
    # One tab stop per group, step, and progress bar.
    stops = p.evaluate("""() => [...document.querySelectorAll('#wanted [role=radiogroup]')].map(g => [...g.querySelectorAll('[role=radio]')].filter(r => r.tabIndex === 0).length)""")
    check("each Pick one radiogroup is one tab stop", stops and all(n == 1 for n in stops), stops)
    check("steps are not tab stops themselves (only their tick and fold button)", p.locator("#results .anvil-step[tabindex]").count() == 0)
    check("the hotbar slots are one tab stop", p.evaluate("[...document.querySelectorAll('.hotbar-slot')].filter(c => c.tabIndex === 0).length") == 1)
    p.evaluate("document.querySelector('.hotbar-slot[tabindex=\"0\"]').focus()")
    p.keyboard.press("ArrowRight")
    check("Right moves along the hotbar", p.evaluate("document.activeElement.classList.contains('hotbar-slot') && document.activeElement.tabIndex") == 0)
    p.evaluate("document.querySelector('#wanted [role=radiogroup] [role=radio][tabindex=\"0\"]').focus()")
    before = p.evaluate("document.activeElement.dataset.focus")
    p.keyboard.press("ArrowRight")
    after = p.evaluate("document.activeElement.dataset.focus")
    check("an arrow key moves between a group's radios", after and after != before, (before, after))
    # The legend.
    p.hover("#wanted .group-legend button")
    bubble = p.inner_text("#wanted .group-legend .info-tip-bubble")
    check("the groups '?' explains Pick one, a side, a part, any, the arrows and the badges", all(word in bubble for word in ("Pick one", "Pick a side", "Pick any part", "Pick any", "⇄", "Side 1")), bubble[:200])
    # The drag chip stays off the target's title.
    _, q, errs = open_page(browser, base, viewport={"width": 1280, "height": 900})
    errors += errs
    q.click('#wanted .item-grid button[data-focus="item-sword"]')
    choose_max(q)
    q.wait_for_selector("#results .anvil-step", timeout=8000)
    q.click("#books >> text=Custom")
    settle(q)
    q.locator("#books .entry-card").nth(2).scroll_into_view_if_needed()
    q.evaluate("scrollBy(0, 120)") # the card must be fully on screen (the drag chip needs room around it)
    src = q.locator("#books .entry-card").nth(1).locator(".entry-slot").bounding_box()
    dst = q.locator("#books .entry-card").nth(2)
    q.mouse.move(src["x"] + 10, src["y"] + 10)
    q.mouse.down()
    q.mouse.move(src["x"] + 30, src["y"] + 30, steps=4)
    clear = True
    box = dst.bounding_box()
    title = dst.locator(".entry-title").bounding_box()
    for fx, fy in ((0.5, 0.15), (0.3, 0.5), (0.5, 0.5), (0.7, 0.85)):
        q.mouse.move(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy, steps=4)
        q.wait_for_selector(".merge-ghost")
        ghost = q.locator(".merge-ghost").bounding_box()
        overlap = min(ghost["x"] + ghost["width"], title["x"] + title["width"]) - max(ghost["x"], title["x"]) > 0 and min(ghost["y"] + ghost["height"], title["y"] + title["height"]) - max(ghost["y"], title["y"]) > 0
        inside = ghost["x"] >= 0 and ghost["y"] >= 0 and ghost["x"] + ghost["width"] <= 1280 and ghost["y"] + ghost["height"] <= 900
        clear = clear and not overlap and inside
    q.mouse.up()
    check("the drag chip never covers the target's title and stays in the window", clear)
    return errors


def part_folds_motion(browser, base):
    """shared fold easing (steps, groups, sections) and the XP orbs (motion on)"""
    errors = []
    _, p, errs = open_page(browser, base, viewport={"width": 1280, "height": 900})
    errors += errs
    pick_helmet_max(p)
    settle(p)
    offer_wanted_fold(p, "expand")
    p.click('#wanted .fold-toggle[data-action="expand"]')
    settle(p)
    # Folds ease, all with the same duration and curve as a section.
    count, values = eases(p, '#results .anvil-step[data-step-card="3"]', '.anvil-step[data-step-card="3"] .step-fold')
    check("a single step folding or unfolding eases its height", count >= 5, (count, values[:12]))
    count, values = eases(p, '#results .anvil-step[data-step-card="1"]', 'input[data-step="1"]')
    check("ticking a step eases the fold too", count >= 5, (count, values[:12]))
    settle(p)
    count, values = eases(p, '#results .anvil-step[data-step-card="5"]', "#results .step-hotbar > .hotbar-slot:nth-child(5)")
    check("jumping to a folded step from the hotbar eases it open", count >= 5, (count, values[:12]))
    settle(p)
    count, values = eases(p, '#results .anvil-step[data-step-card="1"]', "#results .step-reset")
    check("Uncheck all eases the steps whose fold changes", count >= 5, (count, values[:12]))
    count, values = eases(p, "#wanted .group-fold", "#wanted .group-fold > summary")
    check("a Section 1 group folding eases", count >= 5, (count, values[:12]))
    settle(p)
    offer_wanted_fold(p, "collapse")
    count, values = eases(p, '[data-section="books"]', '#wanted .fold-toggle[data-action="collapse"]', "top")
    check("Collapse groups slides what is below it", count >= 5, (count, values[:12]))
    settle(p)
    offer_wanted_fold(p, "expand")
    count, values = eases(p, '[data-section="books"]', '#wanted .fold-toggle[data-action="expand"]', "top")
    check("and so does Expand groups", count >= 5, (count, values[:12]))
    settle(p)
    count_steps = p.locator("input[data-step]").count()
    # The last tick: XP orbs pop out of the bar, only with motion on.
    for number in range(2, count_steps):
        p.locator(f'input[data-step="{number}"]').check()
    settle(p)
    p.locator(f'input[data-step="{count_steps}"]').check()
    p.wait_for_selector(".step-hotbar .pop-orb")
    check("the last tick pops a few orbs out of the hotbar", p.locator(".step-hotbar .pop-orb").count() >= 5)
    p.wait_for_function("document.querySelectorAll('.pop-orb').length === 0", timeout=4000)
    check("and they clear themselves away", p.locator(".pop-orb").count() == 0)
    p.click("#results .step-reset")
    p.click("#options-menu summary")
    p.click('#limit-panel [data-focus="motion-on"]')
    p.keyboard.press("Escape")
    for number in range(1, count_steps + 1):
        p.locator(f'input[data-step="{number}"]').check()
    check("with animations off there are no orbs", p.locator(".pop-orb").count() == 0)
    return errors


def part_wide_morph(browser, base):
    """the widest windows: Steps <-> Compact, the current step's ring goes with its panel (it jumped at the end)"""
    _, p, errors = open_page(browser, base, viewport={"width": 1920, "height": 1100})
    p.click("#wanted .example")
    settle(p)
    RINGS = """[...document.querySelectorAll('#results .anvil-row, #results .card-frame')].filter(el => { const s = getComputedStyle(el);
        return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor !== 'rgba(0, 0, 0, 0)' && el.getBoundingClientRect().width > 0; })
        .map(el => el.className + ' ' + Math.round(el.getBoundingClientRect().width)).join(' | ')"""
    # No switch between Steps, Tree and Compact brings a scroll bar to the steps, even for a moment.
    BAR = "['scroll', 'auto'].includes(getComputedStyle(document.querySelector('#results .steps-scroll')).overflowY) ? 1 : 0"  # (headless Chromium hides scroll bars, so the style is checked)
    for action in ("document.querySelector('#results [data-view=\"tree\"]').click();", "document.querySelector('#results [data-view=\"steps\"]').click();",
                   "document.querySelector('#results .density').click();", "document.querySelector('#results .density').click();"):
        bars = scrub(p, action, BAR)["values"]
        check("switching views never shows a scroll bar on the steps (%s)" % action[40:60], max(bars) < 1, bars)
        settle(p)
    for _ in range(2):
        rings = scrub(p, "document.querySelector('#results .density').click();", RINGS)["values"]
        check("while Steps and Compact morph, the current step has one ring, on its panel's frame", all(r.count("|") == 0 and "card-frame" in r for r in rings[1:-1]), rings[:4])
        settle(p)
    return errors


def part_search_tip(browser, base):
    """a slow search (vanilla boots, Allow conflicts, all 11 non-curse enchantments at max): the badge's ring fills and its tooltip follows it without moving the mouse"""
    _, p, errors = open_page(browser, base, viewport={"width": 1440, "height": 900})
    p.click('#wanted .item-grid button[data-focus="item-boots"]')
    settle(p)
    p.click("#options-menu summary")
    p.click("#limit-panel .rule-switch")
    p.keyboard.press("Escape")
    settle(p)
    p.mouse.move(0, 0)
    count = p.locator("#wanted .pick-any-list .ench-row").count()
    for i in range(count):
        p.evaluate("i => { const bar = document.querySelectorAll('#wanted .pick-any-list .ench-row .level-bar')[i]; bar.focus(); bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); }", i)
    check("all 11 of the boots' enchantments are chosen", count == 11 and p.locator("#wanted .ench-row.chosen").count() == 11, count)
    p.wait_for_function("document.documentElement.dataset.search === 'running'", timeout=6000)
    p.hover('[data-section="steps"] .step-badge')
    # Read the tooltip every 50ms while the mouse stays where it is, until the search ends.
    seen = p.evaluate("""() => new Promise(done => { const seen = []; const tick = () => { const tip = document.querySelector('.search-tip');
        if (document.documentElement.dataset.search !== 'running') { done({ seen, hidden_after: !tip || tip.hidden }); return; }
        if (tip && !tip.hidden && seen[seen.length - 1] !== tip.textContent) seen.push(tip.textContent);
        const badge = document.querySelector('[data-section=steps] .step-badge'); const share = parseFloat(badge.style.getPropertyValue('--search-share')) || 0;
        const deg = parseFloat((getComputedStyle(badge, '::after').backgroundImage.match(/([0-9.]+)deg/) || [0, 0])[1]);
        seen.lag = Math.max(seen.lag || 0, Math.abs(deg - share * 360)); setTimeout(tick, 50); }; tick(); }).then(r => ({ ...r, lag: r.seen.lag }))""")
    check("hovering the badge shows the search's percent, and it changes while the mouse is still", len(seen["seen"]) >= 2 and all("%" in t for t in seen["seen"]), seen["seen"])
    check("the tooltip goes when the search ends", seen["hidden_after"])
    check("while hovered, the ring keeps up with the search (it is drawn straight from the share)", seen["lag"] is not None and seen["lag"] < 2, seen["lag"])
    settle(p)
    # Cancel, then Run again: while the new search runs there is no "Cancelled. Run again" (it would start yet another one), only Cancel.
    p.mouse.move(0, 0)
    p.evaluate("() => { const bar = document.querySelector('#wanted .pick-any-list .ench-row .level-bar'); bar.focus(); bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); }")  # (a change, so the search runs again)
    p.wait_for_function("document.documentElement.dataset.search === 'running'", timeout=6000)
    p.click("#results .progress .btn", timeout=4000)
    p.wait_for_selector("#results .hint >> text=Run again")
    p.click("#results .hint .link")
    p.wait_for_function("document.documentElement.dataset.search === 'running'", timeout=6000)
    during = p.evaluate("[document.documentElement.dataset.search, document.querySelectorAll('#results .hint .link').length]")
    check("once Run again starts the search, the Cancelled line and its Run again are gone", during == ["running", 0], during)
    settle(p)
    return errors


PARTS = [part_search_tip, part_stage_hotbar, part_wide_morph, part_rerun, part_item_bar, part_shelf, part_controls, part_typed_lines, part_chip_drag, part_offline, part_folds_motion, part_chips, part_pick_none, part_sections_motion, part_books_tail, part_books, part_books_views, part_keys, part_anvil_uses, part_section1_motion, part_ranking, part_settings_motion, part_fancy, part_links, part_section1, part_steps, part_two_mods, part_pick_side, part_narrow_results, part_layout, part_motion_access, part_level_rows, part_elytra, part_mod_off, part_cost_width, part_pick_each, part_plain_bracket, part_several_groups, part_fold_all, part_stray_groups]  # longest first, so the long parts start together


class PartBrowser:
    """A part's view of the worker's shared Chromium: every context it opens gets the quick default timeout, animations off
    unless the part is in MOTION_PARTS, and is closed when the part ends (so parts never see each other's pages)."""

    def __init__(self, browser, motion):
        self.browser, self.motion, self.contexts = browser, motion, []

    def new_context(self, *args, **options):
        context = self.browser.new_context(*args, **options)
        context.set_default_timeout(DEFAULT_TIMEOUT_MS)
        if not self.motion:
            context.add_init_script(NO_MOTION_SCRIPT)
        self.contexts.append(context)
        return context

    def new_page(self, *args, **options):
        return self.new_context(*args, **options).new_page()

    def close_contexts(self):
        for context in self.contexts:
            try:
                context.close()
            except Exception:
                pass


# The parts that check animations (they keep "Show animations" on); the rest run with it off, which is faster and steadier.
MOTION_PARTS = {part_wide_morph, part_folds_motion, part_chips, part_sections_motion, part_books_views, part_section1_motion, part_settings_motion, part_section1, part_narrow_results, part_motion_access, part_level_rows}


def run_part(part, base, browser):
    """One part, in a fresh set of contexts of the worker's Chromium."""
    mine = PartBrowser(browser, part in MOTION_PARTS)
    started = time.time()
    try:
        return part.__name__, part(mine, base)
    except Exception:
        check(part.__name__ + " ran to the end", False, traceback.format_exc())
        return part.__name__, []
    finally:
        mine.close_contexts()
        with output_lock:
            print("  (%s took %.1fs)" % (part.__name__, time.time() - started), flush=True)


def worker(queue, base, results):
    """One thread: one Playwright driver and one Chromium, for every part it takes from the queue."""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            try:
                while True:
                    try:
                        index, part = queue.get_nowait()
                    except Exception:
                        return
                    results[index] = run_part(part, base, browser)
            finally:
                browser.close()
    except Exception:
        check("a worker ran to the end", False, traceback.format_exc())


def main():
    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    serial = "--serial" in sys.argv
    queue = Queue()
    only = [arg for arg in sys.argv[1:] if arg.startswith("part_")]  # `part_name ...` runs just those parts, for debugging
    for item in enumerate([part for part in PARTS if not only or part.__name__ in only]):
        queue.put(item)
    results = {}
    threads = [threading.Thread(target=worker, args=(queue, base, results)) for _ in range(1 if serial else min(JOBS, len(PARTS)))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    for index in sorted(results):
        name, errors = results[index]
        check(f"no page errors ({name})", not errors, errors)
    server.shutdown()
    print(f"{passed} passed" + (f", {failed} failed" if failed else ""))
    sys.exit(1 if failed else 0)


main()
