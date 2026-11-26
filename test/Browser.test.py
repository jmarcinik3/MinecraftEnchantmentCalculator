"""Browser tests: the page in a real browser (Chromium through Playwright).

Run from the project folder:  python test/Browser.test.py
Needs:  pip install playwright   and   playwright install chromium

It serves the site on a free local port and checks the flows that unit tests can't see:
results, ticking and folding steps, links, hover/keyboard links, the Tree view, animations,
mods. The checks are split into independent `part_...` functions, each in its own Chromium, run
JOBS at a time (`--serial` runs them one by one, for debugging). Waits use `settle(page)` (the
search is idle and no finite animation is running) rather than fixed sleeps.
Skips (exit 0) when Playwright isn't installed, so it never blocks the other tests.
"""
import concurrent.futures
import functools
import http.server
import os
import re
import sys
import threading
import traceback

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("skipped: Playwright is not installed (pip install playwright; playwright install chromium)")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TIMEOUT_MS = 6000  # how long a click or wait for an element tries before the check fails
JOBS = min(6, os.cpu_count() or 1)  # parts that run side by side (each in its own Chromium); `--serial` runs them one at a time
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


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def open_page(browser, url, **options):
    context = browser.new_context(**options)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.wait_for_selector("#wanted .item-grid, #wanted .wanted-preview")
    return context, page, errors


def settle(page, timeout=10000):
    """Waits until the search is idle and no finite animation or transition is still running (instead of sleeping)."""
    page.wait_for_function("""() => document.documentElement.dataset.search !== "pending" && document.documentElement.dataset.search !== "running" &&
        document.getAnimations().every(a => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity)""", timeout=timeout)


def pick_helmet_max(page):
    page.click('#wanted .item-grid button[data-focus="item-helmet"]')
    page.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    page.wait_for_selector("#results .anvil-step", timeout=8000)


def part_steps(browser, base):
    """the helmet flow: ticking, folding, links, phones, Start over"""
    context, page, errors = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page.wait_for_selector("#wanted .item-grid")
    check("the first screen explains the page", page.locator("#wanted .intro").count() == 1)
    page.click("#wanted .example")
    page.wait_for_selector("#results .anvil-step", timeout=8000)
    check("the example picks a helmet with enchantments", page.locator("#wanted .wanted-preview .mc-ench").count() >= 3)

    steps = page.locator("#results .anvil-step")
    total = steps.count()
    check("a result with several steps", total >= 3, total)
    bars = page.locator(".step-progress-cell")
    check("the progress bar has one segment per step", bars.count() == total, bars.count())

    # Ticking folds the ticked step and fills a segment; the page doesn't jump.
    page.locator('input[data-step="1"]').check()
    check("ticking fills one progress segment", page.locator(".step-progress-cell.filled").count() == 1)
    check("a ticked step is folded", page.locator('.anvil-step[data-step-card="1"].folded').count() == 1)
    # A step folds and unfolds by clicking its head.
    page.locator('.anvil-step[data-step-card="2"] .step-head').click(position={"x": 200, "y": 8})
    check("clicking a step's head folds it", page.locator('.anvil-step[data-step-card="2"].folded').count() == 1)
    page.locator('.anvil-step[data-step-card="2"] .step-fold').click()
    check("its button unfolds it", page.locator('.anvil-step[data-step-card="2"].folded').count() == 0)

    # Starting items: hover lights the card, Tab + Enter shows it.
    link = page.locator(".anvil-step:not(.folded) [data-entry-link]").first
    link.hover()
    check("hovering a starting item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    page.mouse.move(0, 0)
    check("moving away clears the outline", page.locator("#books .entry-card.highlight").count() == 0)
    link.focus()
    check("focusing a starting item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    page.keyboard.press("Enter")
    settle(page)
    check("Enter flashes the card", page.locator("#books .entry-card.flash").count() == 1)
    check("a starting item has an accessible name", "Books and items" in (link.get_attribute("aria-label") or ""))

    # Screen readers: ticking is announced.
    check("ticking a step is announced", "done" in page.inner_text("#live"), page.inner_text("#live"))

    # Tree: merges fold and unfold; hovering a starting item lights its card.
    page.click(".segmented >> text=Tree")
    nodes_open = page.locator(".tree-node:visible").count()
    page.locator('.tree-line[data-step-card="3"] .step-fold').click()
    check("folding a merge hides its inputs", page.locator(".tree-node:visible").count() < nodes_open)
    page.locator('.tree-line[data-step-card="3"] .step-fold').click()
    check("unfolding brings them back", page.locator(".tree-node:visible").count() == nodes_open)
    page.locator(".tree-line:not(.merge)[data-entry-link]").first.hover()
    check("hovering a tree item outlines its card", page.locator("#books .entry-card.highlight").count() == 1)
    # Printing shows every merge's inputs, even folded ones.
    page.emulate_media(media="print")
    check("print shows a folded merge's inputs", page.locator(".tree-node:visible").count() == page.locator(".tree-node").count())
    page.emulate_media(media="screen")
    page.click(".segmented >> text=Steps")

    # The link with progress: another device (new context) continues from the same ticks.
    ticked = page.locator(".step-tick input:checked").count()
    page.click("#copy-link")
    copied = page.evaluate("navigator.clipboard.readText()")
    check("the link carries progress", "#" in copied and len(copied) > len(base), copied[:60])
    other, page2, errors2 = open_page(browser, base, viewport={"width": 390, "height": 800})
    page2.goto(copied)
    page2.reload()
    page2.wait_for_selector("#results .anvil-step", timeout=8000)
    check("the second device has the same ticks", page2.locator(".step-tick input:checked").count() == ticked,
          (ticked, page2.locator(".step-tick input:checked").count()))

    # Ticking the last step flashes the bar once ("level up").
    for number in range(1, total + 1):
        box = page.locator(f'input[data-step="{number}"]')
        if not box.is_checked():
            box.check()
    check("all steps ticked flashes the bar", page.locator(".step-progress-track.level-up").count() == 1)

    # Phones: Steps/Tree, Copy steps and Print share a row.
    tops = page2.evaluate("""[...document.querySelector('.result-tools').children]
        .filter(el => !el.classList.contains('step-progress')).map(el => Math.round(el.getBoundingClientRect().top))""")
    check("on a phone the tools share one row", len(set(tops)) == 1, tops)
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
    with page.expect_navigation():
        page.click("#reset")
    page.wait_for_selector("#wanted .intro")
    check("Start over brings the first screen back", page.locator("#wanted .intro").count() == 1)
    check("Start over keeps saved setups", "Keep" in (page.evaluate("localStorage.getItem('enchantment-calculator-saved')") or ""))
    check("Start over clears the ticks", page.evaluate("localStorage.getItem('enchantment-calculator-checklist')") is None)
    return errors + errors2 + errors3


def part_section1(browser, base):
    """section 1: aligned rows, the item menu, swaps and bar rolls"""
    # Section 1: aligned rows, descriptions, the x on a chosen row, the item menu on the slot.
    sec, page6, errors6 = open_page(browser, base, viewport={"width": 1280, "height": 900})
    page6.click('#wanted .item-grid button[data-focus="item-sword"]')
    page6.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    page6.wait_for_selector("#wanted .ench-row.chosen")
    rights = page6.evaluate("[...document.querySelectorAll('#wanted .ench-row .level-bar')].map(b => Math.round(b.getBoundingClientRect().right))")
    check("every level bar ends at the same x", len(set(rights)) == 1, rights)
    check("rows describe their enchantment", page6.locator("#wanted .ench-desc").count() >= 5)
    check("chosen rows glint", page6.evaluate("getComputedStyle(document.querySelector('#wanted .ench-row.chosen'), '::after').animationName") == "row-glint")
    chosen_before = page6.locator("#wanted .ench-row.chosen").count()
    page6.locator("#wanted .ench-row.chosen .ench-clear").first.click()
    settle(page6) # a cleared row closes, as a copy, before it is gone
    check("the × clears one enchantment", page6.locator("#wanted .ench-row.chosen").count() == chosen_before - 1)
    page6.click("#wanted .preset >> text=Plain")
    settle(page6)
    check("the Plain preset clears every enchantment", page6.locator("#wanted .ench-row.chosen").count() == 0)
    check("with nothing chosen the Levels line has folded away", page6.locator("#wanted .wanted-preview .cost-line:not(.idle)").count() == 0 and page6.locator("#wanted .wanted-preview .cost-line").evaluate("l => l.textContent.trim()") == "")
    check("Plain shows as selected", page6.locator("#wanted .preset.selected >> text=Plain").count() == 1)

    # Swapping Protection for Projectile Protection: the old line is covered from the right
    # (a copy, without data-ns) while the new one is uncovered; the copy is gone afterwards.
    page6.click("#wanted .item-menu-button")
    page6.click('#items button[data-focus="item-helmet"]')
    page6.click('#wanted button[data-focus$="-protection"]')
    settle(page6)
    page6.click('#wanted button[data-focus$="-projectile_protection"]')
    mid_copy = page6.locator("#wanted .mc-tooltip .mc-ench:not([data-ns])").count()
    settle(page6)
    check("a swapped line leaves a copy while it is covered, then none",
          mid_copy == 1 and page6.locator("#wanted .mc-tooltip .mc-ench:not([data-ns])").count() == 0, mid_copy)

    # Switching Depth Strider (III) for Frost Walker (II) rolls the bar: a copy of the lost
    # segment is there mid-roll, and gone afterwards.
    page6.click('#wanted .item-menu-button')
    page6.click('#items button[data-focus="item-boots"]')
    page6.click('#wanted .group-switch button:has-text("Depth Strider")')
    settle(page6)
    page6.click('#wanted .group-switch button:has-text("Frost Walker")')
    mid = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > .level-seg").count()
    settle(page6)
    after = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > .level-seg").count()
    check("a shrinking bar rolls its lost segment away", mid == 3 and after == 2, (mid, after))
    page6.click("#wanted .item-menu-button")
    check("the slot opens the item menu", page6.locator("#item-menu").count() == 1)
    page6.keyboard.press("Escape")
    check("the item menu closes again", page6.locator("#item-menu").count() == 0)
    return errors6


def part_books(browser, base):
    """section 2: copies, prior work, merges, the three views, ordering, saved setups and language"""
    # Everything else once, so a broken import or typo anywhere shows up as a page error.
    wide, page4, errors4 = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page4.click('#wanted .item-grid button[data-focus="item-sword"]')
    page4.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
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
    # Copies: the slot's corner opens a stepper (and the wheel changes it); prior work: the anvil track.
    page4.locator("#books .stack-edit").first.click(force=True)
    page4.locator('#books [data-focus$="-plus"]').first.click()
    check("a copy count shows on the slot", page4.locator("#books .stack-count").count() == 1 and page4.locator("#books .stack-count").first.inner_text() == "2")
    page4.locator('#books [data-focus$="-minus"]').first.click()
    page4.keyboard.press("Escape")
    page4.locator("#books .stack-edit").first.hover()
    page4.mouse.wheel(0, -100)
    page4.locator("#books .stack-count").first.wait_for(timeout=3000) if page4.locator("#books .stack-count").count() == 0 else None  # (the wheel is handled a frame later under load)
    settle(page4)
    check("the wheel over the slot corner adds a copy", page4.locator("#books .stack-count").count() == 1)
    page4.locator("#books .stack-edit").first.hover()
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
    check("back at the default the badge and stack count go", page4.locator("#books .entry-badge").count() == 0 and page4.locator("#books .stack-count").count() == 0)
    # Dragging a slot onto another entry previews the merge.
    src = page4.locator("#books .entry-card").nth(1).locator(".entry-slot")
    dst = page4.locator("#books .entry-card").nth(2)
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
    # Switching views: tooltips that rest hidden never flash, every slot travels on its own, and nothing is left behind.
    page4.mouse.move(0, 0)
    flash = page4.evaluate("""() => new Promise(resolve => {
        let worst = 0, moving = 0;
        document.querySelector('#books [data-focus="view-slots"]').click();
        moving = [...document.querySelectorAll('#books .slotcell .slot-cell-button')].filter(unit => unit.getAnimations().some(a => a.effect.getKeyframes().some(k => k.transform && k.transform !== 'none'))).length;
        const start = performance.now();
        const sample = () => {
            for (const tip of document.querySelectorAll('#books .slot-tip')) worst = Math.max(worst, +getComputedStyle(tip).opacity);
            performance.now() - start < 600 ? requestAnimationFrame(sample) : resolve({ worst, moving });
        };
        sample();
    })""")
    check("switching to Slots never flashes the tooltips", flash["worst"] == 0, flash)
    check("each slot travels to its new place", flash["moving"] >= cards - 1, flash)
    check("a view switch leaves no frames or copies behind", page4.locator("#books .card-frame, #books .card-ghost, #books .morphing").count() == 0)
    for view in ("list", "cards", "list", "slots", "cards"):
        page4.click('#books [data-focus="view-%s"]' % view)
        page4.wait_for_timeout(120)
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
    page4.click('#books >> text=Add book')
    page4.keyboard.press("Escape")
    page4.click('#books [data-focus="view-list"]')
    check("the list view keeps one row per entry", page4.locator("#books .entry-card.compact").count() >= cards)
    page4.click('#books [data-focus="view-cards"]')
    page4.fill('#books input[placeholder^="Type a book"]', "unbreaking 3")
    page4.keyboard.press("Enter")
    page4.click('#books button[aria-label^="Remove entry 1"]')
    settle(page4)
    page4.click("#options-menu summary")
    page4.locator("#limit-panel input[type=range]").fill("30")
    page4.keyboard.press("Escape")
    page4.fill("#ranking input[type=text]", "Excalibur")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    page4.click("#saved summary")
    page4.fill("#saved-panel input[type=text]", "Smoke")
    page4.click("#saved-panel >> text=Save")
    check("a saved setup is listed", page4.locator("#saved-panel .saved-list li").count() == 1)
    page4.click('#saved-panel button[aria-label^="Remove"]')
    page4.keyboard.press("Escape")
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
    page4.click(".copy-menu summary")
    page4.click(".copy-steps")
    page4.locator("#language select").select_option("es")
    page4.wait_for_function("document.documentElement.lang === 'es'")
    check("Spanish changes the heading", "encantamientos" in page4.inner_text("h1").lower(), page4.inner_text("h1"))
    page4.locator("#language select").select_option("en")
    page4.wait_for_function("document.documentElement.lang === 'en'")
    page4.wait_for_selector("#results .anvil-step", timeout=8000)
    return errors4


def part_anvil_uses(browser, base):
    """section 4: slots, cost, planner, final card, tree, phones"""
    # Anvil uses: focus, slot labels and instruction, cost breakdown, Slots view, planner, final card, tree.
    _, p7, errors7 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p7.wait_for_selector("#wanted .item-grid")
    p7.click('#wanted .item-grid button[data-focus="item-boots"]')
    p7.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    p7.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p7)
    steps = p7.locator("#results .anvil-step").count()
    check("only the current step is in full at first", p7.locator("#results .anvil-step:not(.folded)").count() == 1, p7.locator("#results .anvil-step:not(.folded)").count())
    check("a step says which slot is which", p7.locator("#results .anvil-step.current .cell-label").count() == 3)
    check("a step says what to do in words", "left slot" in p7.text_content("#results .anvil-step.current .step-instruction"))
    p7.click("#results .fold-buttons >> text=Expand all")
    check("Expand all shows every step in full", p7.locator("#results .anvil-step.folded").count() == 0)
    p7.click("#results .fold-buttons >> text=Collapse all")
    check("Collapse all folds every step", p7.locator("#results .anvil-step:not(.folded)").count() == 0)
    p7.locator("#results .anvil-step").nth(2).locator(".step-head").click()
    p7.locator("#results .anvil-step").nth(2).locator(".anvil-cost").hover()
    check("the cost shows where its levels come from", p7.locator("#results .cost-breakdown").first.is_visible() or p7.locator("#results .has-breakdown.open").count() == 1)
    p7.mouse.move(0, 0)
    check("the progress sits on its own row", p7.evaluate("document.querySelector('.step-progress').getBoundingClientRect().top > document.querySelector('.result-tools .copy-menu').getBoundingClientRect().bottom - 2"))
    check("the heading counts steps, not uses twice", "step" in p7.inner_text("#steps-summary"), p7.inner_text("#steps-summary"))
    p7.click('#results [data-view="slots"]')
    check("the Slots view hides the tooltips until hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-step:not(.folded) .anvil-cell .mc-tooltip')).display") == "none")
    p7.locator("#results .anvil-step:not(.folded) .anvil-cell.result").first.hover() # (ticked steps are folded here too)
    check("the Slots view's result slot shows its tooltip on hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-step:not(.folded) .anvil-cell.result .mc-tooltip')).display") != "none")
    p7.click('#results [data-view="steps"]')
    settle(p7) # the old view is laid over the new one while they cross-fade
    check("the finished item shows after the steps", p7.locator("#results .final-card").count() == 1 and "done" not in (p7.get_attribute("#results .final-card", "class") or ""))
    p7.locator('#results input[data-step="7"]').check(force=True)
    settle(p7)
    check("ticking every step finishes the card", "done" in (p7.get_attribute("#results .final-card", "class") or ""))
    p7.click("#results .step-reset")
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
    p9.click('#wanted .preset >> text=Plain')
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
    p8.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    p8.wait_for_selector("#results .anvil-step", timeout=8000)
    p8.locator("#results .anvil-step").first.scroll_into_view_if_needed()
    try:
        p8.locator("#results .current-bar").wait_for(state="hidden", timeout=3000) # an observer tucks it away
    except Exception:
        pass
    check("the current-step bar tucks away while its step is on screen", not p8.locator("#results .current-bar").is_visible())
    p8.locator("#results .final-card").scroll_into_view_if_needed()
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
    p8.click('#results [data-view="slots"]')
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
    p9.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
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
    p9.evaluate("""() => { window.__gap = new Promise(resolve => {
        const heights = new Set(); let gaps = [];
        const start = performance.now();
        const tick = () => {
            const strip = document.querySelector('#books .coverage'), grid = document.querySelector('#books .entry-grid');
            const a = strip.getBoundingClientRect(), b = grid.getBoundingClientRect();
            heights.add(Math.round(a.height)); gaps.push(Math.round((b.top - a.bottom) * 10) / 10);
            performance.now() - start < 800 ? requestAnimationFrame(tick) : resolve({ heights: heights.size, spread: Math.max(...gaps) - Math.min(...gaps) });
        };
        tick();
    }); }""")
    p9.click('#books [data-focus="cover-summary"]')
    gap = p9.evaluate("window.__gap")
    check("the entries below follow the opening menu at its own rate", gap["heights"] >= 6 and gap["spread"] < 1, gap)
    settle(p9)
    check("the reached chips roll out of the summary chip", p9.locator("#books .cover-chip.ok:not(.summary)").count() >= 3 and p9.get_attribute('#books [data-focus="cover-summary"]', "aria-expanded") == "true")
    p9.evaluate("""() => { window.__ghosts = new Promise(resolve => { let most = 0; const start = performance.now();
        const tick = () => { most = Math.max(most, document.querySelectorAll('#books .chip-leaving').length); performance.now() - start < 1000 ? requestAnimationFrame(tick) : resolve(most); }; tick(); }); }""")
    p9.click('#books [data-focus="cover-summary"]')
    p9.wait_for_timeout(900)
    check("closing the menu does not replay the chips fading out", p9.evaluate("window.__ghosts") == 0)
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
    p9.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    p9.wait_for_selector("#books .entry-card")
    settle(p9)
    p9.click('[data-focus="mode-custom"]')
    settle(p9)
    key = p9.locator("#wanted .ench-group.exclusive").first.get_attribute("data-group")
    # Section 1 changes ease to a stop: the last change in #wanted's height, frame to frame, is small (a jump at the end is a snap).
    def last_step(act):
        p9.evaluate("""() => { window.__j = new Promise(resolve => {
            const el = document.querySelector('#wanted'); let last = el.getBoundingClientRect().height, final = 0; const start = performance.now();
            const tick = () => { const now = el.getBoundingClientRect().height; if (Math.abs(now - last) > 0.05) final = Math.abs(now - last); last = now; performance.now() - start < 900 ? requestAnimationFrame(tick) : resolve(final); };
            tick();
        }); }""")
        act()
        return p9.evaluate("window.__j")
    p9.click("#wanted .preset >> text=Plain")
    settle(p9)
    jump = last_step(lambda: p9.locator('[data-focus="bar-feather_falling"] .level-seg').nth(3).click())
    check("adding an enchantment does not jump in height", jump < 4, jump)
    settle(p9)
    jump = last_step(lambda: p9.click('[data-focus="clear-feather_falling"]'))
    check("removing an enchantment does not jump in height", jump < 4, jump)
    settle(p9)
    p9.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    settle(p9)
    jump = last_step(lambda: p9.click('#wanted [data-focus="switch-%s-none"]' % key))
    check("picking None in a group does not jump in height", jump < 4, jump)
    # A section slides shut and open, and leaves nothing fixed behind.
    for section in ("wanted", "books", "order", "steps"):
        toggle = '.card.collapsible[data-section="%s"] .collapse-toggle' % section
        p9.click(toggle)
        settle(p9)
        closed = p9.evaluate("(s) => { const c = document.querySelector('.card[data-section=' + s + ']'); return c.classList.contains('collapsed') && c.querySelector(':scope > .section-body').hidden && !c.classList.contains('closing') && c.style.flex === ''; }", section)
        p9.click(toggle)
        settle(p9)
        opened = p9.evaluate("(s) => { const c = document.querySelector('.card[data-section=' + s + ']'); const b = c.querySelector(':scope > .section-body'); return !c.classList.contains('collapsed') && !b.hidden && c.style.flex === '' && b.style.flex === '' && b.style.overflow === ''; }", section)
        check("the %s section slides shut and open cleanly" % section, closed and opened, (closed, opened))
    # The glints share the page's clock: a redraw does not start a sheen over.
    phase = lambda: p9.evaluate("[...document.getAnimations()].filter(a => a.animationName === 'glint' || a.animationName === 'row-glint').map(a => a.startTime)")
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
    p10.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    p10.wait_for_selector("#results .anvil-step", timeout=8000)
    settle(p10)
    check("the game rules menu is among the header buttons", p10.locator(".header-actions #options-menu").count() == 1 and p10.locator("#metrics #options-menu, .section-head #options-menu").count() == 0)
    check("every ranking tile has a grip, a unit and a note", p10.locator(".rank-tile .rank-grip").count() == 4 and all(p10.locator(".rank-tile .metric-unit").nth(i).inner_text() for i in range(4)) and all(p10.locator(".rank-tile .metric-note").nth(i).inner_text() for i in range(4)))
    p10.click(".rank-presets .preset >> text=Least XP")
    check("a ranking preset puts its criterion first", p10.locator(".rank-tile").first.get_attribute("data-criterion") == "xp" and "XP" in p10.inner_text(".rank-caption"))
    p10.click(".rank-presets .preset >> text=Fewest levels")
    p10.click('[data-focus="level-toggle"]')
    settle(p10)
    check("tracking your level says how many levels are missing", "more" in p10.inner_text("#level-status"), p10.inner_text("#level-status"))
    p10.click("#level-set")
    settle(p10)
    check("setting it to what the order needs says it is enough", "enough" in p10.get_attribute("#level-status", "class") or "Enough" in p10.inner_text("#level-status"))
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
    check("a line says the goal before the steps", "enchantments" in p10.inner_text("#results .result-goal"), p10.inner_text("#results .result-goal"))
    check("the anvil wear badge is labelled", p10.locator("#anvil-risk .anvil-risk-label").is_visible())
    check("the sentence is behind an In words line", not p10.locator("#results .anvil-step.current .step-instruction").is_visible())
    p10.click("#results .anvil-step.current .step-words summary")
    check("opening it shows the sentence", p10.locator("#results .anvil-step.current .step-instruction").is_visible())
    p10.click("#results .anvil-step.current .step-words summary")
    p10.locator("#results .step-progress-cell").nth(4).click()
    settle(p10)
    check("a progress segment jumps to its step", p10.evaluate("document.activeElement.dataset.stepCard") == "5", p10.evaluate("document.activeElement.dataset.stepCard"))
    p10.keyboard.press("ArrowDown")
    check("Down moves to the next step", p10.evaluate("document.activeElement.dataset.stepCard") == "6")
    p10.keyboard.press("ArrowUp")
    check("Up moves back", p10.evaluate("document.activeElement.dataset.stepCard") == "5")
    p10.click(".copy-menu summary")
    check("Copy is a menu of steps and checklist", p10.locator(".copy-panel .copy-steps").is_visible() and p10.locator(".copy-panel .copy-checklist").is_visible())
    p10.keyboard.press("Escape")
    p10.locator("#results .step-progress-cell").nth(6).click()
    settle(p10)
    p10.locator('#results .anvil-step[data-step-card="7"] .anvil-cell.result').hover()
    sources = p10.locator("#books .entry-card.highlight").count()
    check("hovering a merged item lights every entry that went into it", sources >= 5, sources)
    p10.mouse.move(0, 0)
    check("moving away clears them", p10.locator("#books .entry-card.highlight").count() == 0)
    # The Slots view folds like Steps: every step starts open, Collapse all folds each to its head, Expand all opens them again.
    p10.click('#results [data-view="slots"]')
    settle(p10)
    steps_n = p10.locator("#results .anvil-step").count()
    check("the Slots view's steps have a fold arrow and all start open", p10.locator("#results .step-fold").count() == steps_n and p10.locator("#results .anvil-step.folded").count() == 0 and p10.locator("#results .fold-buttons").count() == 1)
    p10.click("#results >> text=Collapse all")
    settle(p10)
    check("Collapse all folds every Slots step to its head (the row and caption go, the one-line summary shows)", p10.locator("#results .anvil-step.folded").count() == steps_n and p10.locator("#results .anvil-row:visible").count() == 0 and p10.locator("#results .step-caption:visible").count() == 0 and "+" in p10.locator("#results .anvil-step.folded .step-summary").first.inner_text())
    p10.locator("#results .anvil-step").nth(1).locator(".step-head").click(position={"x": 200, "y": 8})
    settle(p10)
    check("a click on a folded Slots step's head opens it", p10.locator("#results .anvil-step.folded").count() == steps_n - 1 and p10.locator("#results .anvil-row:visible").count() == 1)
    p10.click("#results >> text=Expand all")
    settle(p10)
    check("Expand all opens every Slots step", p10.locator("#results .anvil-step.folded").count() == 0 and p10.locator("#results .anvil-row:visible").count() == steps_n)
    p10.click('#results [data-view="steps"]')
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
    # Settings: the game rules are a subsection beside a Display one, and "Show animations" off stops every animation.
    titles = p10.eval_on_selector_all("#limit-panel .settings-section-title", "e => e.map(x => x.textContent.trim())")
    check("the menu is Settings, with Game rules and Display as subsections", titles == ["Game rules", "Display"] and p10.inner_text("#options-menu summary").strip() == "Settings", titles)
    check("animations are shown to begin with", p10.get_attribute("html", "data-motion") is None and p10.get_attribute('#limit-panel [data-focus="motion-off"]', "aria-checked") == "true")
    p10.click('#limit-panel [data-focus="motion-off"]')
    kept = p10.evaluate("() => document.getAnimations().map(a => a.animationName || a.constructor.name)")
    check("Show animations off leaves the glints running (they have their own switch)", kept and all("glint" in n for n in kept), kept)
    p10.click('#limit-panel [data-focus="glints"]')
    check("Glints off stops them and is kept", p10.get_attribute("html", "data-glint") == "off" and p10.evaluate("document.getAnimations().length") == 0 and p10.evaluate("localStorage.getItem('enchantment-calculator-glints')") == "false")
    p10.keyboard.press("Escape")
    p10.click('#results [data-view="tree"]')
    leftover = p10.evaluate("() => [document.documentElement.dataset.motion, document.getAnimations().length, document.querySelectorAll('#results .results-content > .steps-scroll').length]")
    check("with Show animations off, a view switch animates nothing (no cross-fade copy, no animation running, not even the glints)", leftover == ["off", 0, 1], leftover)
    p10.click('#results [data-view="steps"]')
    p10.click("#options-menu summary")
    p10.click('#limit-panel [data-focus="motion-off"]')
    p10.click('#limit-panel [data-focus="glints"]')
    check("and turning it off brings them back", p10.get_attribute("html", "data-motion") is None and p10.evaluate("localStorage.getItem('enchantment-calculator-no-motion')") == "false")
    p10.keyboard.press("Escape")
    return errors10


def part_elytra(browser, base):
    """an item with no conflicts"""
    # An item whose enchantments never conflict (Elytra) has no conflict graph, and no stray text where it would be.
    _, p13, errors13 = open_page(browser, base, viewport={"width": 1280, "height": 1100})
    p13.wait_for_selector("#wanted .item-grid")
    p13.click("#wanted .item-grid >> text=Elytra")
    p13.wait_for_selector("#wanted .wanted-preview")
    check("an item with no conflicts has no conflict graph and no stray text", p13.locator("#wanted .graph-box").count() == 0 and "null" not in p13.inner_text("#wanted"), p13.inner_text("#wanted")[:200])
    p13.click("#books >> text=Custom")
    p13.click("#books >> text=Add book")
    p13.wait_for_selector(".picker-search")
    p13.fill(".picker-search", "MEND")
    settle(p13)
    check("the add-enchantment menu has a search box, with no mod on", p13.eval_on_selector_all(".entry-popover .picker-row", "e => e.map(x => x.dataset.ns)") == ["mending"])
    # Flint & Steel in the game's own list has one group only (its lone enchantments), so no subsection is made around it.
    p13.click("#wanted .item-menu-button")
    p13.click('#items button[data-focus="item-flint_and_steel"]')
    p13.wait_for_selector("#wanted .ench-row")
    check("a section with one group shows it without a subsection", p13.locator("#wanted .group-fold").count() == 0 and p13.locator("#wanted .wanted-list > .ench-row").count() >= 1)
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
    p11.click("#wanted .item-grid >> text=Sword")
    p11.wait_for_selector("#wanted .wanted-preview")
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
    order = p11.evaluate("[...document.querySelector('#wanted').children].map(el => el.classList.contains('wanted-head') ? 'head' : el.classList.contains('search-row') ? 'search' : el.classList.contains('list-box') ? 'list' : el.classList.contains('mod-section') ? 'mod' : el.classList.contains('graph-box') ? 'graph' : '?')")
    check("section 1 has the search, then the enchantment list, each mod's list and the conflict graph as boxes of their own", order == ["head", "search", "list", "mod", "graph"], order)
    p11.click("#wanted .list-box > summary")
    check("a mod's box stays when the list is folded", p11.locator("#wanted > .mod-section").is_visible())
    p11.click("#wanted .list-box > summary")
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
    p14.click("#wanted .item-grid >> text=Sword")
    p14.wait_for_selector("#wanted .wanted-preview")
    preset_names = lambda: p14.eval_on_selector_all("#wanted .preset-chips button, #wanted .presets button, #wanted .chip", "e => e.map(x => x.textContent.trim())")
    names_off = preset_names()
    p14.click("#options-menu summary")
    check("the Mods row offers both mods", p14.locator('#limit-panel [data-focus^="mod-"]').count() == 2)
    p14.click('#limit-panel [data-focus="mod-spellbound"]')
    p14.wait_for_selector('#wanted .mod-section[data-mod="Spellbound"]')
    check("a mod's note shows only while the mod is on", p14.locator("#limit-panel .mod-note").count() == 1, p14.locator("#limit-panel .mod-note").all_inner_texts())
    check("Spellbound alone adds its own folded section", p14.locator("#wanted .mod-section").count() == 1)
    p14.click('#limit-panel [data-focus="mod-fancy_enchantments"]')
    p14.wait_for_selector('#wanted .mod-section[data-mod="Fancy Enchantments"]')
    check("with both on, each mod has its own section", p14.locator("#wanted .mod-section").count() == 2)
    p14.keyboard.press("Escape")
    check("turning mods on does not rename the presets", names_off and preset_names() == names_off, (names_off, preset_names()))
    p14.locator('#wanted .switch-option[data-opt="spellbound:dullness"]').first.click()
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
    p16.evaluate("""() => { window.__h = []; const t0 = performance.now(); const tick = () => { const bar = document.querySelector('#wanted .ench-group.exclusive .ench-row .level-bar'); if (bar) window.__h.push(Math.round(bar.getBoundingClientRect().height)); performance.now() - t0 < 900 && requestAnimationFrame(tick); }; tick(); }""")
    p16.click("#wanted .group-switch >> text=Mod D")
    p16.wait_for_timeout(900)
    heights = p16.evaluate("window.__h")
    check("a bar gaining a second row grows smoothly", 28 <= heights[0] < 40 and heights[-1] == 56 and any(40 <= x <= 52 for x in heights), heights[:12])
    dull = p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-bar')
    box = dull.bounding_box()
    check("a level bar past V wraps onto a second row of five (to X)", p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-seg').count() == 10 and box["height"] > 50 and box["width"] < 160, box)
    p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-seg[data-level="8"]').click()
    settle(p16)
    check("a level in the second row can be chosen", p16.locator('#wanted .ench-row[data-ns="spellbound:d"] .level-bar').get_attribute("aria-valuetext") == "Mod D VIII")
    # And back: the ten-level bar's extra row leaves with the height, not after it (one animation, not two).
    p16.evaluate("""() => { window.__g = []; const t0 = performance.now(); const tick = () => { const bar = document.querySelector('#wanted .ench-group.exclusive .ench-row .level-bar'); if (bar) window.__g.push([Math.round(bar.getBoundingClientRect().height), bar.querySelectorAll('.level-seg').length]); performance.now() - t0 < 900 && requestAnimationFrame(tick); }; tick(); }""")
    p16.click("#wanted .group-switch >> text=Sharpness")
    p16.wait_for_timeout(900)
    frames = p16.evaluate("window.__g")
    settled = next(i for i, f in enumerate(frames) if f[0] == 28)
    check("losing a row: the extra levels are gone by the time the height has settled", all(f[1] == 5 for f in frames[settled + 2:]), frames[settled - 1:settled + 3])
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
    p17.wait_for_function("document.querySelector('#wanted .cost-line') && document.querySelector('#wanted .wanted-preview').textContent.includes('Mod C')")
    p17.click("#options-menu summary")
    p17.click('#limit-panel [data-focus="mod-spellbound"]')
    p17.keyboard.press("Escape")
    p17.wait_for_function("document.querySelector('#wanted .cost-line') && document.querySelector('#wanted .cost-line').textContent.includes('5 ')", timeout=5000)
    settle(p17) # the removed tooltip line fades out first
    tip, results = p17.inner_text("#wanted .wanted-preview"), p17.inner_text("#results")
    check("turning a mod off drops its picks everywhere, with no error", "Mod C" not in tip and "5 Levels" in tip and "Mod C" not in results and "issing" not in results, (tip, results[:200]))
    context.close()
    return errors17


def part_cost_width(browser, base):
    """the tooltip is wide enough for its cost line when the enchantment's name is shorter (vanilla Lure on a fishing rod)"""
    _, p19, errors19 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
    p19.click("#wanted .item-grid >> text=Fishing Rod")
    p19.click('#wanted .ench-row[data-ns="lure"] .level-seg[data-level="1"]')
    p19.wait_for_selector("#results .anvil-step")
    p19.wait_for_function("document.querySelector('#wanted .cost-line:not(.idle) .cost-line-text') && document.querySelector('#wanted .cost-line-text').textContent.includes('Levels')")
    settle(p19)
    fits = p19.evaluate("""() => { const tip = document.querySelector('#wanted .wanted-preview .mc-tooltip').getBoundingClientRect(); const text = document.querySelector('#wanted .cost-line-text').getBoundingClientRect(); return [Math.round(text.right), Math.round(tip.right)]; }""")
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
    page.click("#wanted .item-grid >> text=" + item.replace("_", " ").title())
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
    check("the game's list has a Pick any (lone enchantments) and a Pick one subsection, named by type and size", len(headers) == 2 and headers[0].startswith("pick any (") and headers[1].startswith("pick one ("), headers)
    check("a section with a single group (the mod's) shows it without a subsection or a second header", section.locator("xpath=ancestor::details[contains(@class, 'group-fold')]").count() == 0 and p.locator("#wanted .ench-group-label").count() == 0)
    first = p.locator("#wanted .group-fold > summary").nth(1)
    first.click()
    check("a group folds away from its header, and opens again", not p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    first.click()
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
    p.click("#wanted .item-grid >> text=Boots")
    p.wait_for_selector("#wanted .ench-group.exclusive")
    heads = p.evaluate("""() => [...document.querySelectorAll('#wanted .wanted-list > .group-fold > summary')].map(el => el.textContent.trim().toLowerCase())""")
    check("the list starts with the lone enchantments in a Pick any subsection, then the groups", heads and heads[0].startswith("pick any (") and len(heads) > 1 and not any(h.startswith("pick any") for h in heads[1:]), heads)
    check("the Pick any subsection holds plain rows", p.locator("#wanted .wanted-list > .group-fold >> nth=0 >> .ench-row").count() == int(heads[0].split("(")[1].rstrip(")")))
    check("the fold buttons sit to the right of the search box", p.evaluate("""() => { const input = document.querySelector('#wanted .wanted-search').getBoundingClientRect(), buttons = document.querySelector('#wanted .search-row .fold-buttons').getBoundingClientRect(); return buttons.left >= input.right - 1 && Math.abs(buttons.top - input.top) < 40; }"""))
    # The presets are the same whether or not conflicts are allowed.
    preset_row = lambda: p.eval_on_selector_all("#wanted .presets button, #wanted .preset-chips button", "e => e.map(x => x.textContent.trim())")
    presets_before = preset_row()
    p.click("#options-menu summary")
    p.click("#limit-panel .rule-switch")
    p.keyboard.press("Escape")
    settle(p)
    check("Allow conflicts keeps the same presets", presets_before and preset_row() == presets_before, (presets_before, preset_row()))
    p.click("#options-menu summary")
    p.click("#limit-panel .rule-switch")
    p.keyboard.press("Escape")
    settle(p)
    p.click("#wanted .graph-box > summary")
    p.wait_for_selector(".graph-canvas")
    p.click('#wanted [data-focus="wanted-expand"]')
    open_count = lambda: p.evaluate("[...document.querySelectorAll('#wanted details')].filter(d => d.open).length")
    total = p.evaluate("document.querySelectorAll('#wanted details').length")
    check("Expand all opens every fold-away box and group", open_count() == total and total >= 4, (open_count(), total))
    p.click('#wanted [data-focus="wanted-collapse"]')
    check("Collapse all closes them all", open_count() == 0)
    p.click('#wanted [data-focus="wanted-expand"]')
    check("and Expand all opens them again", open_count() == total)
    # The list folds away from its heading, and a group from its own.
    p.click("#wanted .list-box > summary")
    check("the list folds away", not p.locator("#wanted .list-box .wanted-list").is_visible())
    p.click("#wanted .list-box > summary")
    check("and opens again", p.locator("#wanted .list-box .wanted-list").is_visible())
    first = p.locator("#wanted .group-fold > summary").nth(1)
    first.click()
    check("a group folds away from its header", not p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    first.click()
    check("and opens again", p.evaluate("document.querySelectorAll('#wanted .group-fold')[1].open"))
    # The conflict graph: a node per conflicting enchantment, a line per conflict, hover and click.
    check("the conflict graph draws a node per conflicting enchantment and a line per conflict", p.locator(".graph-node").count() >= 6 and p.locator(".graph-edge").count() >= 6)
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
    check("on a narrow screen the buttons drop below the search box", p.evaluate("""() => { const input = document.querySelector('#wanted .wanted-search').getBoundingClientRect(), buttons = document.querySelector('#wanted .search-row .fold-buttons').getBoundingClientRect(); return buttons.top >= input.bottom - 1; }"""))
    check("no page errors with the fold buttons", not errors, errors)


def part_stray_groups(browser, base):
    """a stray and a first level of parts (made up: Mod A1-A2 and Mod B1-B2 are two Pick ones, and Mod S conflicts with Mod A1 and Mod B1 only)"""
    edges = {"a1": ["a2", "s"], "b1": ["b2", "s"]}
    context, p, errors, _ = mocked_mod_page(browser, base, edges, singles=["z"])  # (Mod Z gives the mod's section a second group, so each is a subsection)
    section = p.locator("#wanted .pick-groups")
    summary = section.locator("xpath=ancestor::details[contains(@class, 'group-fold')]/summary")
    check("a group whose first level is parts that never conflict is named Pick a part, with its size", summary.inner_text().lower() == "pick a part (5)", summary.inner_text())
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
    p18.evaluate("""() => { window.__copies = []; const t0 = performance.now(); const tick = () => { window.__copies.push(document.querySelectorAll('#results .results-content > .steps-scroll').length); if (performance.now() - t0 < 500) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }""")
    p18.click('#results [data-view="slots"]')
    p18.wait_for_timeout(700)
    copies = p18.evaluate("window.__copies")
    check("switching view cross-fades (a copy of the old view fades out) and leaves nothing behind", max(copies) == 2 and copies[-1] == 1 and p18.locator("#results .results-content > .steps-scroll").count() == 1, copies[:12])
    p18.click('#results [data-view="steps"]')
    settle(p18)
    p18.evaluate("""() => { window.__h = []; const t0 = performance.now(); const tick = () => { window.__h.push([...document.querySelectorAll('#results .anvil-step')].map(e => Math.round(e.getBoundingClientRect().height))); if (performance.now() - t0 < 500) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }""")
    p18.click("#results >> text=Expand all")
    p18.wait_for_timeout(700)
    frames = p18.evaluate("window.__h")
    first, last = frames[0], frames[-1]
    grown = [i for i in range(len(first)) if last[i] > first[i] + 20]
    mid = [f for f in frames if any(first[i] + 10 < f[i] < last[i] - 10 for i in grown)]
    check("Expand all eases each step open instead of jumping", len(grown) > 0 and len(mid) >= 2, (first, last))
    return errors18


PARTS = [part_chips, part_books, part_anvil_uses, part_section1_motion, part_ranking, part_fancy, part_section1, part_steps, part_two_mods, part_pick_side, part_narrow_results, part_level_rows, part_elytra, part_mod_off, part_cost_width, part_pick_each, part_plain_bracket, part_several_groups, part_fold_all, part_stray_groups]  # longest first, so the long parts start together


def run_part(part, base):
    """One part in its own Chromium (and Playwright driver), so parts can run side by side."""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            # Every context a part opens gives up on a missing element after 6s, not Playwright's 30s (explicit timeouts still win).
            new_context = browser.new_context
            def quick_context(*args, **options):
                context = new_context(*args, **options)
                context.set_default_timeout(DEFAULT_TIMEOUT_MS)
                return context
            browser.new_context = quick_context
            new_page = browser.new_page
            def quick_page(*args, **options):
                page = new_page(*args, **options)
                page.set_default_timeout(DEFAULT_TIMEOUT_MS)
                return page
            browser.new_page = quick_page
            try:
                return part.__name__, part(browser, base)
            finally:
                browser.close()
    except Exception:
        check(part.__name__ + " ran to the end", False, traceback.format_exc())
        return part.__name__, []


def main():
    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    serial = "--serial" in sys.argv
    with concurrent.futures.ThreadPoolExecutor(1 if serial else min(JOBS, len(PARTS))) as pool:
        results = list(pool.map(lambda part: run_part(part, base), PARTS))
    for name, errors in results:
        check(f"no page errors ({name})", not errors, errors)
    server.shutdown()
    print(f"{passed} passed" + (f", {failed} failed" if failed else ""))
    sys.exit(1 if failed else 0)


main()
