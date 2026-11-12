// picker.js: the periodic-table picker over the served corpus.
//
// The 118 cells come from `elements.js`; everything else is read from
// `corpus/phase-manifest.json` at runtime, so the code holds no corpus counts.
//
// Only entries under `data/tdb/` are offered. The manifest also lists the
// bundled examples, which either repeat corpus ids or exist only in
// `app/examples/`.
//
// A database's grade is its worst fact and needs both `engine_approximates`
// and `unsupported_phases`, since a database can have unsupported phases with
// the flag false. A cell's grade is the best of its databases ("is there a
// clean assessment here?"), so one bad database does not mark an element.
// After an element is selected, cells are graded on that pair only.
//
// The corner mark shows grade and the fill shows density (how many databases).
// The two are nearly independent, so they use different visual channels.

import { ELEMENTS, bySymbol } from './elements.js';

/// The manifest entries the picker offers (see the header).
const CORPUS_PREFIX = 'data/tdb/';

/// Best first, so "best of" is a rank comparison. The keys are the statuses
/// `phase_support` reports, as in the fidelity panel.
const GRADES = [
    { key: 'full', mark: '', label: 'All phases modeled in full' },
    { key: 'approximated', mark: '≈', label: 'Physics dropped — a phase without some terms specified in the .tdb' },
    { key: 'unsupported', mark: '⊘', label: 'Phases missing — unsupported phases left off the diagram' },
];
const RANK = new Map(GRADES.map((g, i) => [g.key, i]));

export function gradeOf(entry) {
    if (entry.unsupported_phases?.length) return 'unsupported';
    if (entry.engine_approximates) return 'approximated';
    return 'full';
}

const better = (a, b) => (RANK.get(a) <= RANK.get(b) ? a : b);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/// Number of fill steps: how many washes of one ink are distinguishable on a
/// 50 px tile. A design constant; the step boundaries come from the data.
const DENSITY_STEPS = 5;

/// The fill step for a cell offering `n` databases when the fullest offers
/// `max`. Steps are equal ratios (boundaries at `max^(i/STEPS)`) because the
/// counts are skewed: linear steps would put most elements in the palest step,
/// and quantiles break on ties.
function densityStep(n, max) {
    if (n <= 0) return 0;
    // The fullest cell offers one, so every non-empty cell is the first step.
    if (max <= 1) return 1;
    return Math.min(DENSITY_STEPS,
                    Math.max(1, Math.ceil(DENSITY_STEPS * Math.log(n) / Math.log(max))));
}

const GRADE_WORD = {
    full: 'modeled in full',
    approximated: 'physics dropped',
    unsupported: 'phases missing',
};

/// Words for the engine's approximation reasons (`approximation_reasons` in
/// the manifest). An unknown reason is shown as written, not dropped.
const REASON_TEXT = {
    magnetic: 'magnetic ordering term not applied',
    associate_species: 'associate species dropped',
    unaccounted_terms: 'terms the parser could not read',
    unsupported_parameter_type: 'a parameter type the engine does not implement',
};

const symbolOf = (name) => bySymbol.get(name)?.symbol || name;

/**
 * Builds the picker inside `root` and returns `{ open, loadById, peers,
 * entryById }`. The manifest is large, so it is fetched on the first
 * `open()`, not at start-up.
 */
export function setupPicker({ manifestUrl, onLoad, root }) {
    const grid = root.querySelector('#picker-grid');
    const status = root.querySelector('#picker-status');
    const countLine = root.querySelector('#picker-count');
    const hint = root.querySelector('#picker-hint');
    const chip = root.querySelector('#picker-selection');
    const legend = root.querySelector('#picker-legend');
    const chooser = root.querySelector('#picker-chooser');
    const panel = root.querySelector('#picker-chooser-panel');
    const panelClose = root.querySelector('#picker-chooser-close');

    let entries = null;            // the served subset of the manifest
    let byElement = null;          // symbol → entries containing it
    let byPair = null;             // "A|B" → entries
    let byId = null;               // id → entry, for `?db=`
    let loading = null;            // the in-flight fetch, so two opens share one
    let selected = null;           // the first-clicked element, or null
    let paired = null;             // its partner, once a pair has been opened
    let current = null;            // the id last loaded from here
    let chooserReturnFocus = null; // what to hand the caret back to on close
    let densityLabel = null;       // the fill key's sentence, rewritten per state
    const cells = new Map();       // symbol → button

    const chooserOpen = () => !panel.classList.contains('hidden');

    async function open() {
        if (entries || loading) return loading;
        status.textContent = 'Reading the corpus index…';
        status.classList.remove('hidden', 'picker-failed');
        loading = (async () => {
            try {
                const res = await fetch(manifestUrl);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                index(await res.json());
                status.classList.add('hidden');
                buildGrid();
                refresh();
            } catch (e) {
                // Say so; an empty table alone looks like an empty corpus.
                status.textContent =
                    `The corpus index could not be read (${e.message}). `
                    + 'The table is empty because of that, not because the corpus is. '
                    + 'It is staged by tools/build.sh.';
                status.classList.add('picker-failed');
                status.classList.remove('hidden');
            } finally {
                loading = null;
            }
        })();
        return loading;
    }

    function index(manifest) {
        entries = (manifest.systems || []).filter((e) => e.tdb?.startsWith(CORPUS_PREFIX));
        byElement = new Map();
        byPair = new Map();
        // Ids are unique once the examples are filtered out.
        byId = new Map();
        for (const e of entries) {
            byId.set(e.id, e);
            const [a, b] = e.elements;
            for (const el of new Set(e.elements)) {
                if (!byElement.has(el)) byElement.set(el, []);
                byElement.get(el).push(e);
            }
            const k = pairKey(a, b);
            if (!byPair.has(k)) byPair.set(k, []);
            byPair.get(k).push(e);
        }
        for (const list of byPair.values()) {
            list.sort((x, y) => RANK.get(gradeOf(x)) - RANK.get(gradeOf(y))
                             || x.id.localeCompare(y.id));
        }
    }

    // ── the table ───────────────────────────────────────────────────────────

    function buildGrid() {
        grid.replaceChildren();
        cells.clear();
        for (const el of ELEMENTS) {
            const cell = document.createElement('button');
            cell.type = 'button';
            // `picker-dens` carries the fill; the legend swatches use it too.
            cell.className = 'picker-cell picker-dens';
            cell.dataset.symbol = el.symbol.toUpperCase();
            cell.style.gridColumn = String(el.column);
            cell.style.gridRow = String(el.row);

            const z = document.createElement('span');
            z.className = 'picker-z';
            z.textContent = String(el.z);
            const sym = document.createElement('span');
            sym.className = 'picker-symbol';
            sym.textContent = el.symbol;
            // The mark shows the grade without relying on colour.
            const mark = document.createElement('span');
            mark.className = 'picker-mark';
            mark.setAttribute('aria-hidden', 'true');
            cell.append(z, sym, mark);

            cell.addEventListener('click', () => click(el));
            cells.set(el.symbol.toUpperCase(), cell);
            grid.appendChild(cell);
        }
        renderLegend();
    }

    /// The databases a click on `symbol` would offer next; cells are graded
    /// and labelled by this. Once a pair is open, a third element starts a new
    /// pair, so cells outside the pair offer all their databases again.
    function candidates(symbol) {
        if (paired) {
            return symbol === paired ? (byPair.get(pairKey(selected, paired)) || [])
                                     : (byElement.get(symbol) || []);
        }
        if (!selected || symbol === selected) return byElement.get(symbol) || [];
        return byPair.get(pairKey(selected, symbol)) || [];
    }

    function refresh() {
        if (!entries) return;
        const lists = new Map(ELEMENTS.map((el) => {
            const symbol = el.symbol.toUpperCase();
            return [symbol, candidates(symbol)];
        }));
        // The selected cell is left out of the scale and gets no fill: clicking
        // it clears the selection, and its own count would push its partners
        // into the palest steps.
        const scale = Math.max(0, ...[...lists]
            .filter(([symbol]) => symbol !== selected)
            .map(([, list]) => list.length));

        for (const el of ELEMENTS) {
            const symbol = el.symbol.toUpperCase();
            const cell = cells.get(symbol);
            const list = lists.get(symbol);
            const grade = list.reduce((g, e) => better(g, gradeOf(e)), 'unsupported');
            const isSelected = symbol === selected || symbol === paired;

            cell.disabled = list.length === 0;
            cell.classList.toggle('is-selected', isSelected);
            // Fill is shown only while one element is selected and no pair is
            // open, when the count is what the reader is choosing by. Without
            // fill, the atomic number keeps its 4.55:1 contrast. Density is not
            // in the aria-label; the count already is.
            cell.dataset.density = String(
                !selected || paired || symbol === selected
                    ? 0 : densityStep(list.length, scale));
            for (const g of GRADES) {
                cell.classList.toggle(`pick-${g.key}`, !cell.disabled && grade === g.key);
            }
            cell.querySelector('.picker-mark').textContent =
                cell.disabled ? '' : GRADES[RANK.get(grade)].mark;

            // The count is the cell's own: every database with the element, or,
            // with another element selected, those of the pair.
            const n = list.length;
            const detail = n === 0 ? 'no database'
                : `${n} database${n === 1 ? '' : 's'}, best: ${GRADE_WORD[grade]}`;
            cell.title = `${el.symbol} — ${el.name}: ${detail}`;
            cell.setAttribute('aria-label', `${el.name}: ${detail}`);
            cell.setAttribute('aria-pressed', String(isSelected));

            // Only the second cell of an open pair toggles the list, so only it
            // has `aria-expanded`. Elsewhere the attribute is removed rather
            // than set to false, which would announce a closed disclosure.
            if (paired && symbol === paired) {
                cell.setAttribute('aria-expanded', String(chooserOpen()));
                cell.setAttribute('aria-controls', 'picker-chooser-panel');
            } else {
                cell.removeAttribute('aria-expanded');
                cell.removeAttribute('aria-controls');
            }
        }
        renderDensityKey(scale);
        renderHint();
        renderChip();
    }

    // ── selection ───────────────────────────────────────────────────────────

    function click(el) {
        const symbol = el.symbol.toUpperCase();
        // With a pair open, its first cell clears it and its second toggles the
        // list, so the reader can come back to compare assessments. Any other
        // element starts a new pair.
        if (paired) {
            if (symbol === selected) { clearSelection(); return; }
            if (symbol === paired) {
                if (chooserOpen()) { closeChooser(); refresh(); }
                else openPair(selected, paired);
                return;
            }
            // Close the old pair's list before regrading against the new element.
            closeChooser();
            selected = symbol;
            paired = null;
            refresh();
            return;
        }
        if (!selected) {
            selected = symbol;
            refresh();
            return;
        }
        if (symbol === selected) { clearSelection(); return; }
        openPair(selected, symbol);
    }

    function clearSelection() {
        selected = null;
        paired = null;
        closeChooser();
        refresh();
    }

    /// Opens the list for a pair, even with one assessment: the second click
    /// always does the same thing, and the list shows the database's grade,
    /// phases and axis top before it loads.
    function openPair(a, b) {
        const list = byPair.get(pairKey(a, b)) || [];
        if (list.length === 0) return;       // the cell is disabled anyway
        paired = b;
        openChooser({ list, a, b });
        refresh();                           // after, so `aria-expanded` is current
    }

    async function choose(entry) {
        const loaded = await onLoad(entry);
        // On failure, leave everything as it was; `onLoad` decides whether the
        // tab switches, so the error stays visible.
        if (!loaded) return false;
        current = entry.id;
        // The list and the selection stay, so coming back to the tab shows the
        // list with the loaded row marked, ready to try the next assessment.
        // Focus is not restored: the opening cell is now in a hidden panel.
        markCurrent();
        return true;
    }

    /// Unmarks the loaded row, once the app holds a database from elsewhere.
    function forget() {
        current = null;
        markCurrent();
    }

    function markCurrent() {
        let any = false;
        for (const row of chooser.querySelectorAll('.picker-choice')) {
            const isCurrent = row.dataset.id === current;
            if (isCurrent) any = true;
            row.classList.toggle('is-current', isCurrent);
            if (isCurrent) row.setAttribute('aria-current', 'true');
            else row.removeAttribute('aria-current');
        }
        // The accent frame (`.picker-expansion.is-fresh`) means "pick one" and
        // shows only while no row in the list is loaded.
        panel.classList.toggle('is-fresh', !any);
    }

    // ── the words around the table ──────────────────────────────────────────

    function renderLegend() {
        const counts = new Map(GRADES.map((g) => [g.key, 0]));
        for (const e of entries) counts.set(gradeOf(e), counts.get(gradeOf(e)) + 1);

        legend.replaceChildren();
        const key = (cls, mark, text) => {
            const li = document.createElement('li');
            li.className = `picker-key ${cls}`;
            const swatch = document.createElement('span');
            swatch.className = 'picker-swatch';
            swatch.textContent = mark || '·';
            swatch.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = text;
            li.append(swatch, label);
            legend.appendChild(li);
        };
        for (const g of GRADES) {
            key(`pick-${g.key}`, g.mark, `${g.label} — ${counts.get(g.key)} databases`);
        }
        key('pick-absent', '', `Not in the corpus — ${ELEMENTS.length - byElement.size} elements`);

        // The fill's key is a ramp; `renderDensityKey` writes its text.
        const li = document.createElement('li');
        li.className = 'picker-key picker-key-density';
        const ramp = document.createElement('span');
        ramp.className = 'picker-ramp';
        ramp.setAttribute('aria-hidden', 'true');
        for (let i = 1; i <= DENSITY_STEPS; i++) {
            const swatch = document.createElement('span');
            swatch.className = 'picker-swatch picker-dens';
            swatch.dataset.density = String(i);
            ramp.appendChild(swatch);
        }
        densityLabel = document.createElement('span');
        li.append(ramp, densityLabel);
        legend.appendChild(li);

        const multi = [...byPair.values()].filter((l) => l.length > 1).length;
        countLine.textContent =
            `${entries.length} databases · ${byElement.size} elements · `
            + `${byPair.size} binary systems (${multi} with multiple assessments)`;
    }

    /// The fill key's text, rewritten on each refresh because the selection
    /// changes what is counted and the scale.
    function renderDensityKey(scale) {
        if (!densityLabel) return;
        const li = densityLabel.parentElement;
        const shown = selected && !paired;
        if (li) li.classList.toggle('hidden', !shown);
        if (!shown) return;
        const what = `assessments of its ${symbolOf(selected)} pair`;
        // State the ratio per step, unless the fullest cell offers only one.
        const ratio = scale > 1
            ? ` · each step about ×${(scale ** (1 / DENSITY_STEPS)).toFixed(1)}`
            : '';
        densityLabel.textContent =
            `Fill — how many ${what} a cell offers: palest 1, densest ${scale}${ratio}`;
    }

    /// The next step. How to clear the selection is on the chip.
    function renderHint() {
        hint.textContent = paired
            ? `${symbolOf(selected)}–${symbolOf(paired)} chosen — click `
              + `${symbolOf(paired)} again to ${chooserOpen() ? 'close' : 'reopen'} `
              + 'its list. Any other element starts a new pair.'
            : selected
                ? `${symbolOf(selected)} selected — now click its partner. Dimmed `
                  + `elements have no ${symbolOf(selected)} database.`
                : 'Click an element, then a second one, to load that binary system.';
    }

    /// The chip showing the selection (`Fe` or `Fe–Ni`), which clears it.
    function renderChip() {
        const label = paired ? `${symbolOf(selected)}–${symbolOf(paired)}`
                             : selected ? symbolOf(selected) : '';
        chip.replaceChildren();
        chip.classList.toggle('hidden', !label);
        if (!label) return;
        const name = document.createElement('span');
        name.textContent = label;
        const x = document.createElement('span');
        x.className = 'picker-chip-x';
        x.textContent = '×';
        x.setAttribute('aria-hidden', 'true');
        chip.append(name, x);
        // The `×` is decorative; the label says what the button does.
        chip.setAttribute('aria-label', `Clear the ${label} selection`);
        chip.title = `Clear the ${label} selection (or press Escape)`;
    }

    chip.addEventListener('click', clearSelection);

    // ── the chooser ─────────────────────────────────────────────────────────
    //
    // The list of a pair's assessments, opened by the second click, with each
    // one's grade, phases and losses. It expands below the table rather than
    // opening a dialog, so the table stays visible while comparing.
    //
    //   - Name: `role="region"` with `aria-labelledby` on its `<h3>`.
    //   - Focus moves to the first row on open; otherwise a keyboard user would
    //     tab through 118 cells to reach it.
    //   - Focus is not trapped: the rest of the page stays live.
    //   - Escape closes the innermost open thing (see the handler below).

    function openChooser(what) {
        renderChooser(what);
        chooserReturnFocus = document.activeElement;
        panel.classList.remove('hidden');
        (panel.querySelector('.picker-choice') || panelClose)
            .focus({ preventScroll: true });
        frame();
    }

    /// Scrolls the list into view while keeping the table on screen: enough to
    /// show the whole list, but not so far that the table leaves the top, and
    /// always enough to show the list's title, which wins on a short window.
    /// `scrollIntoView({ block: 'nearest' })` pushes most of the table off.
    function frame() {
        const title = chooser.querySelector('h3');
        const wanted = Math.max(0, panel.getBoundingClientRect().bottom - innerHeight);
        const spare = Math.max(0, grid.getBoundingClientRect().top);
        const least = title
            ? Math.max(0, title.getBoundingClientRect().bottom - innerHeight) : 0;
        const by = Math.max(least, Math.min(wanted, spare));
        if (by > 0) window.scrollBy(0, by);
    }

    function closeChooser() {
        if (!chooserOpen()) return;
        // Check focus before hiding, which moves it to `<body>`. Restore it
        // only if nothing outside the panel has taken it (as a click on a third
        // element does).
        const active = document.activeElement;
        const owned = !active || active === document.body || panel.contains(active);
        panel.classList.add('hidden');
        const back = chooserReturnFocus;
        chooserReturnFocus = null;
        if (owned && back) back.focus();
    }

    panelClose.addEventListener('click', () => { closeChooser(); refresh(); });

    // Escape closes the list if open, else clears the selection. Bound to the
    // tab panel, not the document, and not stopped, so it does not swallow an
    // Escape meant for the cite popover.
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (chooserOpen()) { closeChooser(); refresh(); }
        else if (selected) clearSelection();
    });

    function renderChooser({ list, a, b }) {
        chooser.replaceChildren();
        const head = document.createElement('h3');
        head.id = 'picker-chooser-title';       // the region's `aria-labelledby`
        head.textContent = `${symbolOf(a)}–${symbolOf(b)}: ${list.length} `
            + `assessment${list.length === 1 ? '' : 's'} available for the system`;
        chooser.append(head);

        // Columns, so the differences between assessments line up.
        const table = document.createElement('div');
        table.className = 'picker-choice-table';
        const headRow = document.createElement('div');
        headRow.className = 'picker-choice-head';
        headRow.setAttribute('aria-hidden', 'true');   // each row is self-labelling
        for (const [text, cls] of [['assessment', ''], ['grade', ''],
                                   ['phases', 'num'], ['max T', 'num'],
                                   ['unsupported by the engine', '']]) {
            const th = document.createElement('span');
            if (cls) th.className = cls;
            th.textContent = text;
            headRow.appendChild(th);
        }
        table.appendChild(headRow);

        for (const entry of list) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `picker-choice pick-${gradeOf(entry)}`;
            row.dataset.id = entry.id;
            // The row is one button; its accessible name is one sentence.
            row.setAttribute('aria-label',
                `${entry.id}, ${GRADE_WORD[gradeOf(entry)]}: ${describe(entry)}`);

            const id = document.createElement('span');
            id.className = 'picker-choice-id';
            id.textContent = entry.id;

            const badge = document.createElement('span');
            badge.className = 'picker-badge';
            badge.textContent = GRADE_WORD[gradeOf(entry)];

            const nPhases = entry.phases?.length ?? 0;
            const nCompounds = entry.line_compounds?.length ?? 0;
            const phases = document.createElement('span');
            phases.className = 'picker-choice-num';
            phases.append(String(nPhases));
            if (nCompounds) {
                const lc = document.createElement('span');
                lc.className = 'picker-choice-dim';
                lc.textContent = ` ${nCompounds} lc`;
                phases.appendChild(lc);
                phases.title = `${nPhases} phases, ${nCompounds} of them line compounds`;
            }

            // `t_axis_max`, not `t_max`; see `describe`.
            const temp = document.createElement('span');
            temp.className = 'picker-choice-num';
            temp.textContent = `${Math.round(entry.t_axis_max)} K`;

            const loses = document.createElement('span');
            loses.className = 'picker-choice-loses';
            const bits = [];
            for (const { phase, reasons } of entry.approximation_reasons || []) {
                bits.push({ name: phase, what: 'physics dropped',
                            why: reasons.map((r) => REASON_TEXT[r] || r).join(', ') });
            }
            // Named, not counted, so the reader sees which phases are missing.
            for (const phase of entry.unsupported_phases || []) {
                bits.push({ name: phase, what: 'off the diagram', why: '' });
            }
            bits.forEach((b, i) => {
                if (i) loses.append(' · ');
                const nm = document.createElement('span');
                nm.textContent = b.name;
                const wh = document.createElement('span');
                wh.className = 'picker-choice-dim';
                wh.textContent = ` ${b.what}`;
                if (b.why) wh.title = b.why;
                loses.append(nm, wh);
            });
            // Tagged only when the magnetic term could not be applied, not for
            // every database with magnetic parameters.
            if (entry.magnetic_approximated) {
                const tag = document.createElement('span');
                tag.className = 'picker-choice-tag';
                tag.textContent = 'mag';
                tag.title = 'Magnetic parameters this engine cannot evaluate, so the '
                          + 'ordering term is left out of a phase here.';
                if (bits.length) loses.append(' ');
                loses.appendChild(tag);
            }
            if (!bits.length && !entry.magnetic_approximated) {
                const none = document.createElement('span');
                none.className = 'picker-choice-dim';
                none.textContent = 'nothing';
                loses.appendChild(none);
            }

            row.append(id, badge, phases, temp, loses);
            row.addEventListener('click', () => choose(entry));
            table.appendChild(row);
        }
        chooser.appendChild(table);

        // One footnote listing the reasons for dropped physics in this list.
        const reasons = [...new Set(list.flatMap((e) =>
            (e.approximation_reasons || []).flatMap(({ reasons: rs }) =>
                rs.map((r) => REASON_TEXT[r] || r))))];
        if (reasons.length) {
            const foot = document.createElement('p');
            foot.className = 'picker-chooser-foot';
            foot.textContent = `Physics dropped here means: ${reasons.join('; ')}.`;
            chooser.appendChild(foot);
        }
        markCurrent();
    }

    /// A one-line summary of a database, used as its row's accessible name.
    /// The temperature is the diagram's axis top (`t_axis_max`), not `t_max`,
    /// which is 6000 K throughout the corpus.
    function describe(entry) {
        const bits = [];
        const nPhases = entry.phases?.length ?? 0;
        const nCompounds = entry.line_compounds?.length ?? 0;
        bits.push(`${nPhases} phases`
            + (nCompounds ? `, ${nCompounds} of them line compounds` : ''));
        bits.push(`diagram to ${Math.round(entry.t_axis_max)} K`);
        if (entry.magnetic_approximated) bits.push('magnetic ordering term left out');

        for (const { phase, reasons } of entry.approximation_reasons || []) {
            const why = reasons.map((r) => REASON_TEXT[r] || r).join(', ');
            bits.push(`${phase} with physics dropped (${why})`);
        }
        if (entry.unsupported_phases?.length) {
            bits.push(`left off the diagram: ${entry.unsupported_phases.join(', ')}`);
        }
        return bits.join(' · ');
    }

    /**
     * Loads the database a `?db=` link names, through `choose`, so the page
     * ends in the same state as after clicking. Fetches the manifest if the
     * tab was never opened.
     *
     * @returns {Promise<{ok: boolean, reason: string}>} `reason` is a sentence
     *   for the reader explaining a failure.
     */
    async function loadById(id) {
        await open();
        if (!byId) {
            return { ok: false,
                     reason: `The corpus index could not be read, so the link's `
                             + `database (${id}) could not be looked up.` };
        }
        const entry = byId.get(id);
        if (!entry) {
            return { ok: false,
                     reason: `The link names a database (${id}) that is not in `
                             + 'the corpus index.' };
        }
        return { ok: await choose(entry),
                 reason: `${id} is in the corpus index but could not be loaded.` };
    }

    /// All assessments of an element pair, for the comparison chooser. Shares
    /// `open()`'s single manifest fetch. Element order does not matter, so the
    /// caller must check each entry's orientation before drawing.
    async function peers(a, b) {
        await open();
        if (!byPair) return [];
        return byPair.get(pairKey(a, b)) || [];
    }

    /// One entry by id, for `?bl=`. Shares the same fetch.
    async function entryById(id) {
        await open();
        return byId ? (byId.get(id) || null) : null;
    }

    return { open, loadById, peers, entryById, forget };
}
