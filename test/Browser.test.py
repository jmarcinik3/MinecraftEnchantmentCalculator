"""Browser tests: the page in a real browser (Chromium through Playwright).

Run from the project folder:  python test/Browser.test.py
Needs:  pip install playwright   and   playwright install chromium

It serves the site on a free local port, picks a helmet, and checks the flows that
unit tests can't see: results, ticking and folding steps, the link with progress, the
hover/keyboard links to the Books and items cards, and the Tree view.
Skips (exit 0) when Playwright isn't installed, so it never blocks the other tests.
"""
import functools
import http.server
import os
import sys
import threading

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("skipped: Playwright is not installed (pip install playwright; playwright install chromium)")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  ok  " + name)
    else:
        failed += 1
        print("  FAIL " + name + (" - " + str(detail) if detail else ""))


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


def pick_helmet_max(page):
    page.click('#wanted .item-grid button[data-focus="item-helmet"]')
    page.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
    page.wait_for_selector("#results .anvil-step", timeout=15000)


def main():
    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context, page, errors = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_selector("#wanted .item-grid")
        check("the first screen explains the page", page.locator("#wanted .intro").count() == 1)
        page.click("#wanted .example")
        page.wait_for_selector("#results .anvil-step", timeout=15000)
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
        page.wait_for_timeout(300)
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
        page2.wait_for_selector("#results .anvil-step", timeout=15000)
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
        page3.wait_for_selector("#results .anvil-step", timeout=15000)
        check("320px has no sideways scroll", not page3.evaluate("document.documentElement.scrollWidth > innerWidth"))

        # Start over: one click clears the setup and bring the first screen back; saved setups stay.
        page.evaluate("localStorage.setItem('enchantment-calculator-saved', JSON.stringify([{name: 'Keep', item: 'sword', link: 'x'}]))")
        with page.expect_navigation():
            page.click("#reset")
        page.wait_for_selector("#wanted .intro")
        check("Start over brings the first screen back", page.locator("#wanted .intro").count() == 1)
        check("Start over keeps saved setups", "Keep" in (page.evaluate("localStorage.getItem('enchantment-calculator-saved')") or ""))
        check("Start over clears the ticks", page.evaluate("localStorage.getItem('enchantment-calculator-checklist')") is None)

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
        check("the × clears one enchantment", page6.locator("#wanted .ench-row.chosen").count() == chosen_before - 1)
        page6.click("#wanted .preset >> text=Plain")
        check("the Plain preset clears every enchantment", page6.locator("#wanted .ench-row.chosen").count() == 0)
        check("Plain shows as selected", page6.locator("#wanted .preset.selected >> text=Plain").count() == 1)

        # Swapping Protection for Projectile Protection: the old line is covered from the right
        # (a copy, without data-ns) while the new one is uncovered; the copy is gone afterwards.
        page6.click("#wanted .item-menu-button")
        page6.click('#items button[data-focus="item-helmet"]')
        page6.click('#wanted button[data-focus$="-protection"]')
        page6.wait_for_timeout(600)
        page6.click('#wanted button[data-focus$="-projectile_protection"]')
        mid_copy = page6.locator("#wanted .mc-tooltip .mc-ench:not([data-ns])").count()
        page6.wait_for_timeout(700)
        check("a swapped line leaves a copy while it is covered, then none",
              mid_copy == 1 and page6.locator("#wanted .mc-tooltip .mc-ench:not([data-ns])").count() == 0, mid_copy)

        # Switching Depth Strider (III) for Frost Walker (II) rolls the bar: a copy of the lost
        # segment is there mid-roll, and gone afterwards.
        page6.click('#wanted .item-menu-button')
        page6.click('#items button[data-focus="item-boots"]')
        page6.click('#wanted .group-switch button:has-text("Depth Strider")')
        page6.wait_for_timeout(500)
        page6.click('#wanted .group-switch button:has-text("Frost Walker")')
        mid = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > *").count()
        page6.wait_for_timeout(900)
        after = page6.locator("#wanted .ench-group.exclusive:has(button[data-focus$=\"-frost_walker\"]) .level-bar > *").count()
        check("a shrinking bar rolls its lost segment away", mid == 3 and after == 2, (mid, after))
        page6.click("#wanted .item-menu-button")
        check("the slot opens the item menu", page6.locator("#item-menu").count() == 1)
        page6.keyboard.press("Escape")
        check("the item menu closes again", page6.locator("#item-menu").count() == 0)

        # Everything else once, so a broken import or typo anywhere shows up as a page error.
        wide, page4, errors4 = open_page(browser, base, viewport={"width": 1280, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
        page4.click('#wanted .item-grid button[data-focus="item-sword"]')
        page4.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
        page4.wait_for_selector("#results .anvil-step", timeout=15000)
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
        page4.wait_for_timeout(300)
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
        page4.wait_for_timeout(300)
        check("the wheel over the slot corner adds a copy", page4.locator("#books .stack-count").count() == 1)
        page4.locator("#books .stack-edit").first.hover()
        page4.mouse.wheel(0, 100)
        page4.wait_for_timeout(300)
        page4.locator("#books .entry-more").first.click(force=True)
        page4.locator("#books .anvil-pip:not(.zero)").nth(1).click()
        page4.locator("#books .anvil-pip.zero").click()
        pips = page4.locator("#books .anvil-pip:not(.zero)")
        p1, p3 = pips.nth(0).bounding_box(), pips.nth(2).bounding_box()
        page4.mouse.move(p1["x"] + 5, p1["y"] + 5)
        page4.mouse.down()
        page4.mouse.move(p3["x"] + 5, p3["y"] + 5, steps=6)
        page4.mouse.up()
        page4.wait_for_timeout(300)
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
        page4.wait_for_timeout(300)
        check("the merge preview changes nothing", page4.locator("#books .entry-card").count() == cards)
        # The slots view.
        page4.click('#books [data-focus="view-slots"]')
        page4.wait_for_timeout(500)
        check("the slots view shows one slot per entry", page4.locator("#books .entry-card.slotcell").count() == cards)
        page4.locator("#books .entry-card.slotcell").nth(1).hover()
        page4.wait_for_timeout(250)
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
        page4.wait_for_timeout(600)
        check("dragging a slot's grip reorders the slots", page4.locator("#books .slot-tip").nth(3).inner_text() == before, before)
        page4.keyboard.press("Escape")
        page4.click('#books [data-focus="view-cards"]')
        page4.wait_for_timeout(500)
        page4.click('#books >> text=Add book')
        page4.keyboard.press("Escape")
        page4.click('#books [data-focus="view-list"]')
        check("the list view keeps one row per entry", page4.locator("#books .entry-card.compact").count() >= cards)
        page4.click('#books [data-focus="view-cards"]')
        page4.fill('#books input[placeholder^="Type a book"]', "unbreaking 3")
        page4.keyboard.press("Enter")
        page4.click('#books button[aria-label^="Remove entry 1"]')
        page4.wait_for_timeout(500)
        page4.click("#options-menu summary")
        page4.locator("#limit-panel input[type=range]").fill("30")
        page4.keyboard.press("Escape")
        page4.fill("#ranking input[type=text]", "Excalibur")
        page4.wait_for_selector("#results .anvil-step", timeout=15000)
        page4.click("#saved summary")
        page4.fill("#saved-panel input[type=text]", "Smoke")
        page4.click("#saved-panel >> text=Save")
        check("a saved setup is listed", page4.locator("#saved-panel .saved-list li").count() == 1)
        page4.click('#saved-panel button[aria-label^="Remove"]')
        page4.keyboard.press("Escape")
        page4.click("#rank-help")
        page4.click("#edition >> text=Bedrock")
        page4.wait_for_selector("#results .anvil-step", timeout=15000)
        page4.click("#edition >> text=Java")
        page4.click("#theme")
        check("the theme button sets a theme", page4.evaluate("document.documentElement.dataset.theme") in ("dark", "light"))
        page4.click('[data-section="wanted"] .collapse-toggle')
        page4.click('[data-section="wanted"] .collapse-toggle')
        page4.click("#copy-link")
        page4.click(".copy-steps")
        page4.locator("#language select").select_option("es")
        page4.wait_for_function("document.documentElement.lang === 'es'")
        check("Spanish changes the heading", "encantamientos" in page4.inner_text("h1").lower(), page4.inner_text("h1"))
        page4.locator("#language select").select_option("en")
        page4.wait_for_function("document.documentElement.lang === 'en'")
        page4.wait_for_selector("#results .anvil-step", timeout=15000)

        # Anvil uses: focus, slot labels and instruction, cost breakdown, Slots view, planner, final card, tree.
        _, p7, errors7 = open_page(browser, base, viewport={"width": 1280, "height": 1000})
        p7.evaluate("localStorage.clear()")
        p7.reload()
        p7.wait_for_selector("#wanted .item-grid")
        p7.click('#wanted .item-grid button[data-focus="item-boots"]')
        p7.click("#wanted .preset:not([data-focus=\"preset-plain\"]) >> nth=0")
        p7.wait_for_selector("#results .anvil-step", timeout=20000)
        p7.wait_for_timeout(500)
        steps = p7.locator("#results .anvil-step").count()
        check("only the current step is in full at first", p7.locator("#results .anvil-step:not(.folded)").count() == 1, p7.locator("#results .anvil-step:not(.folded)").count())
        check("a step says which slot is which", p7.locator("#results .anvil-step.current .cell-label").count() == 3)
        check("a step says what to do in words", "left slot" in p7.inner_text("#results .anvil-step.current .step-instruction"))
        p7.click("#results .fold-buttons >> text=Expand all")
        check("Expand all shows every step in full", p7.locator("#results .anvil-step.folded").count() == 0)
        p7.click("#results .fold-buttons >> text=Collapse all")
        check("Collapse all folds every step", p7.locator("#results .anvil-step:not(.folded)").count() == 0)
        p7.locator("#results .anvil-step").nth(2).locator(".step-head").click()
        p7.locator("#results .anvil-step").nth(2).locator(".anvil-cost").hover()
        check("the cost shows where its levels come from", p7.locator("#results .cost-breakdown").first.is_visible() or p7.locator("#results .has-breakdown.open").count() == 1)
        p7.mouse.move(0, 0)
        check("the progress sits on its own row", p7.evaluate("document.querySelector('.step-progress').getBoundingClientRect().top > document.querySelector('.result-tools .copy-steps').getBoundingClientRect().bottom - 2"))
        check("the heading counts steps, not uses twice", "step" in p7.inner_text("#steps-summary"), p7.inner_text("#steps-summary"))
        p7.click('#results [data-view="slots"]')
        check("the Slots view hides the tooltips until hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-cell .mc-tooltip')).display") == "none")
        p7.locator("#results .anvil-cell.result").first.hover()
        check("a slot's tooltip shows on hover", p7.evaluate("getComputedStyle(document.querySelector('#results .slots-mode .anvil-cell.result .mc-tooltip')).display") != "none")
        p7.click('#results [data-view="steps"]')
        check("the finished item shows after the steps", p7.locator("#results .final-card").count() == 1 and "done" not in (p7.get_attribute("#results .final-card", "class") or ""))
        p7.locator('#results input[data-step="7"]').check(force=True)
        p7.wait_for_timeout(500)
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
        p9.wait_for_timeout(400)
        p9.fill('#books input[placeholder^="Type a book"]', "feather falling 3")
        p9.keyboard.press("Enter")
        p9.fill('#books input[placeholder^="Type a book"]', "feather falling 3")
        p9.keyboard.press("Enter")
        p9.wait_for_selector("#results .anvil-step", timeout=20000)
        p9.wait_for_timeout(500)
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
        p8.wait_for_selector("#results .anvil-step", timeout=20000)
        p8.locator("#results .anvil-step").first.scroll_into_view_if_needed()
        p8.wait_for_timeout(400)
        check("the current-step bar shows on a phone", p8.locator("#results .current-bar").is_visible())
        p8.click("#results .current-bar .btn.primary")
        p8.wait_for_timeout(500)
        check("its Done button ticks the step and moves on", p8.locator('#results input[data-step="1"]').is_checked() and "Step 2" in p8.inner_text("#results .current-bar"), p8.inner_text("#results .current-bar"))
        errors_extra = errors7 + errors8
        for name, errs in (("desktop", errors), ("phone", errors2), ("small", errors3), ("smoke", errors4), ("section 1", errors6), ("anvil uses", errors_extra)):
            check(f"no page errors ({name})", not errs, errs)
        browser.close()
    server.shutdown()
    print(f"{passed} passed" + (f", {failed} failed" if failed else ""))
    sys.exit(1 if failed else 0)


main()
