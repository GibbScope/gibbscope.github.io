// pop.js: reads the phase-diagram tables in a Thermo-Calc PARROT `.POP` file.
//
// A POP file lists equilibria with conditions, fixed phases, an EXPERIMENT
// clause and a weight. Only part of it is (x, T) data, so every block is either
// turned into points or refused with a reason, and refusals are reported.
//
// Read: a `TABLE-HEAD` block whose conditions and EXPERIMENT fix one x and one
// T per row. Two shapes cover the phase-diagram tables in the Cr-Ni PARROT
// tutorial:
//
//   SET-CONDITION  P=1E5 T=@2            a solvus: x from column 1, T from
//   EXPERIMENT     X(FCC,CR)=@1:0.02     column 2, phase and sigma from the X()
//
//   SET-CONDITION  P=1E5 X(CR)=@1        a liquidus or solidus: x from column
//   EXPERIMENT     T=@2:10               1, T from column 2, sigma in kelvin
//
// A condition may also give a literal (`T=1073` rather than `T=@3`), which
// applies to every row.
//
// Refused:
//   * thermochemical quantities (`HMR=`, `ACR(...)=`, `MUR(...)=`, ...);
//   * a block with no composition, such as `EXPERIMENT T=1618:5` under three
//     fixed phases: its compositions are in another block that nothing links;
//   * `CHANGE-STATUS PHASE @4=FIX 1`, where the phase varies per row;
//   * an element the loaded database does not have.
//
// Phase names and elements go through resolve.js, which resolves POP's
// abbreviations (`LIQ`, `FCC`) by unique prefix.
//
// Pure: no DOM, no globals.

import { axisFor, resolvePhase } from './resolve.js';

/// Directives that do not affect which (x, T) a row is; skipped silently. Any
/// other unhandled directive is reported, since it might change the meaning.
const IGNORED = new Set([
    'SET-ALL-START', 'SET-START-VALUE', 'SET-START-CONSTITUTION',
    'SET-REFERENCE-STATE', 'SET-REF', 'SET-NUMERICAL-LIMITS',
    'SET-ALTERNATE-CONDITION', 'DEFINE-COMPONENTS', 'ADVANCED-OPTIONS',
    'SAVE-WORKSPACES', 'SAVE', 'FLUSH-BUFFER', 'COMMENT', 'ENTER-SYMBOL',
]);

/// EXPERIMENT quantities that are not phase-diagram points, and their names for
/// the refusal message. Matched on the prefix.
const NOT_A_DIAGRAM_POINT = [
    [/^HM/i,  'enthalpy'],
    [/^SM/i,  'entropy'],
    [/^GM/i,  'Gibbs energy'],
    [/^CP/i,  'heat capacity'],
    [/^AC/i,  'activity'],
    [/^MU/i,  'chemical potential'],
    [/^LNAC/i, 'activity'],
];

/// Normalises `_` to `-`, so `TABLE_HEAD` matches `TABLE-HEAD`. Thermo-Calc's
/// abbreviations (`T-H`) are not accepted: resolving them needs its full
/// command table.
const canon = (word) => word.toUpperCase().replace(/_/g, '-');

/// Splits a line into code and its trailing `$` comment. The comment is kept:
/// on SET-WEIGHT lines it names the source study.
function split(line) {
    const cut = line.indexOf('$');
    return cut < 0
        ? { code: line.trim(), note: '' }
        : { code: line.slice(0, cut).trim(), note: line.slice(cut + 1).trim() };
}

const isNumericRow = (code) => /^[-+]?[\d.]/.test(code);

/// `X(FCC,CR)=@1:0.02` -> { quantity:'X', phase:'FCC', element:'CR', ref:'@1',
/// sigma:0.02 }. Also reads `T=@2:10` and `X(CR)=@1`.
function clause(text) {
    const m = text.match(/^([A-Za-z_]+)\s*(?:\(([^)]*)\))?\s*=\s*([^:]+?)\s*(?::\s*([-\d.eE+]+))?\s*$/);
    if (!m) return null;
    const args = (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
        quantity: m[1].toUpperCase(),
        // `X(PHASE,EL)` is a phase's composition; `X(EL)` the overall one.
        phase: args.length > 1 ? args[0] : '',
        element: args.length > 1 ? args[1] : (args[0] || ''),
        ref: m[3].trim(),
        sigma: m[4] === undefined ? null : Number(m[4]),
    };
}

/// Returns a function of a row for a table column (`@2`) or a literal, or null
/// for anything else.
function valueOf(ref) {
    const col = ref.match(/^@(\d+)$/);
    if (col) {
        const i = Number(col[1]) - 1;
        return (row) => (i < row.length ? row[i] : NaN);
    }
    const n = Number(ref);
    return Number.isFinite(n) ? () => n : null;
}

/// Sorts a block's directives into conditions, experiments and fixed phases.
function readDirectives(lines, phases) {
    const out = {
        conditions: [], experiments: [], fixed: [], unknown: [], columnPhase: false,
    };
    for (const { code, line } of lines) {
        const head = canon(code.split(/\s+/)[0] || '');
        const rest = code.slice(code.split(/\s+/)[0].length).trim();
        if (IGNORED.has(head)) continue;
        if (head === 'CREATE-NEW') continue;   // the equilibrium's own id
        if (head === 'SET-CONDITION') {
            // `P=1E5 T=@2 X(CR)=@1` — several clauses on one line.
            for (const part of rest.split(/\s+(?=[A-Za-z_]+\s*[(=])/)) {
                const c = clause(part);
                if (c) out.conditions.push(c);
            }
            continue;
        }
        if (head === 'EXPERIMENT') {
            const c = clause(rest);
            if (c) out.experiments.push({ ...c, line });
            else out.unknown.push({ line, code });
            continue;
        }
        if (head === 'CHANGE-STATUS') {
            const m = rest.match(/^PHASE\s+(.+?)\s*=\s*FIX(?:ED)?\s+([-\d.eE+]+)/i);
            if (!m) continue;               // ENTERED / SUSPENDED: no fixed amount
            const amount = Number(m[2]);
            for (const name of m[1].split(/[\s,]+/).filter(Boolean)) {
                if (name.startsWith('@')) { out.columnPhase = true; continue; }
                out.fixed.push({ ...resolvePhase(name, phases), amount });
            }
            continue;
        }
        out.unknown.push({ line, code });
    }
    return out;
}

/// One `TABLE-HEAD … TABLE-END` block, plus the `SET-WEIGHT` lines after it.
/// Returns `{ points }` or `{ refusal }`.
function readTable(block, { elements, phases }) {
    const d = readDirectives(block.directives, phases);
    const at = `line ${block.line}`;

    if (d.experiments.length === 0) {
        return { refusal: { reason: 'no EXPERIMENT clause', at } };
    }
    // One measured quantity per block; the two shapes cannot place several.
    if (d.experiments.length > 1) {
        return { refusal: {
            reason: `${d.experiments.length} EXPERIMENT clauses in one table`, at } };
    }
    const exp = d.experiments[0];

    for (const [re, what] of NOT_A_DIAGRAM_POINT) {
        if (re.test(exp.quantity)) {
            return { refusal: { reason: `${what} (${exp.quantity}), not a phase boundary`, at } };
        }
    }
    if (d.columnPhase) {
        return { refusal: { reason: 'the phase is a table column (@n), so it varies per row', at } };
    }

    const condT = d.conditions.find((c) => c.quantity === 'T');
    const condX = d.conditions.find((c) => c.quantity === 'X' || c.quantity === 'W');
    let readX = null, readT = null, phase = '', xErr = 0, tErr = 0, note = '';

    if (exp.quantity === 'W') {
        return { refusal: { reason:
            'weight fraction (W), which needs a mass balance this reader does not do', at } };
    }
    if (exp.quantity === 'X') {
        // Shape A: the EXPERIMENT is the composition, the condition is T.
        if (!condT) return { refusal: { reason: 'a composition with no temperature condition', at } };
        readT = valueOf(condT.ref);
        readX = valueOf(exp.ref);
        xErr = exp.sigma ?? 0;
        if (exp.phase) {
            const r = resolvePhase(exp.phase, phases);
            phase = r.phase;
            if (r.note) note = r.note;
        }
        const axis = axisFor(exp.element, elements);
        if (!axis) {
            return { refusal: { reason: `X(${exp.element}) is not one of ${elements.join('-')}`, at } };
        }
        const raw = readX;
        readX = (row) => axis(raw(row));
    } else if (exp.quantity === 'T') {
        // Shape B: the EXPERIMENT is the temperature, the condition is x.
        if (!condX) return { refusal: { reason: 'a temperature with no composition condition', at } };
        readT = valueOf(exp.ref);
        tErr = exp.sigma ?? 0;
        const axis = axisFor(condX.element, elements);
        if (!axis) {
            return { refusal: { reason: `X(${condX.element}) is not one of ${elements.join('-')}`, at } };
        }
        const raw = valueOf(condX.ref);
        readX = raw && ((row) => axis(raw(row)));
        // The phase fixed at a non-zero amount has the overall composition, so
        // the point is on its boundary: `LIQ=FIX 1` with `FCC=FIX 0` is a
        // liquidus point of LIQUID, and the reverse a solidus point of FCC.
        const present = d.fixed.filter((f) => f.amount > 0);
        if (present.length === 1) {
            phase = present[0].phase;
            if (present[0].note) note = present[0].note;
        } else if (present.length > 1) {
            return { refusal: { reason:
                `${present.length} phases are fixed at a non-zero amount, so which `
                + 'boundary this is cannot be read', at } };
        }
    } else {
        return { refusal: { reason: `EXPERIMENT ${exp.quantity}=, which is not x or T`, at } };
    }

    if (!readX || !readT) {
        return { refusal: { reason: 'a condition this reader cannot turn into a number', at } };
    }

    const points = [];
    const bad = [];
    block.rows.forEach((row, i) => {
        const x = readX(row.values), t = readT(row.values);
        if (!Number.isFinite(x) || !Number.isFinite(t)) {
            bad.push(row.line);
            return;
        }
        const w = block.weightAt(i);
        points.push({
            x, t, kind: 'boundary', phase,
            x_err: xErr, t_err: tErr,
            weight: w.weight,
            source: w.source,
        });
    });
    return { points, note, badRows: bad };
}

/// Reads a `.POP`.
///
/// @param {string} text        the file, already decoded
/// @param {object} ctx         `{ fileName, elements, phases }`: `elements` is
///                             the database's two in declared order, `phases`
///                             the set the engine models.
/// @returns {{points: object[], errors: string[]}} as the CSV and JSON readers.
export function parsePop(text, { fileName, elements, phases }) {
    const label = fileName.replace(/\.[^.]+$/, '');
    const lines = text.split(/\r?\n/).map((raw, i) => ({ ...split(raw), line: i + 1 }));

    const blocks = [];
    const refusals = [];
    const unknown = [];
    let i = 0;

    while (i < lines.length) {
        const { code, line } = lines[i];
        const head = canon(code.split(/\s+/)[0] || '');

        if (head === 'TABLE-HEAD') {
            const firstId = Number(code.split(/\s+/)[1]) || 1;
            const directives = [];
            i++;
            while (i < lines.length && canon(lines[i].code.split(/\s+/)[0] || '') !== 'TABLE-VALUES') {
                if (lines[i].code) directives.push(lines[i]);
                i++;
            }
            i++;                                     // past TABLE-VALUES
            const rows = [];
            while (i < lines.length && canon(lines[i].code.split(/\s+/)[0] || '') !== 'TABLE-END') {
                if (isNumericRow(lines[i].code)) {
                    rows.push({ values: lines[i].code.split(/[\s,]+/).map(Number),
                                line: lines[i].line });
                }
                i++;
            }
            i++;                                     // past TABLE-END
            // `SET-WEIGHT w lo-hi $ label` counts rows from the table's first
            // equilibrium id (`TABLE-HEAD 4` with 21 rows is 4..24). The comment
            // names the study, so one POP file can hold several sources.
            const spans = [];
            while (i < lines.length) {
                const h = canon(lines[i].code.split(/\s+/)[0] || '');
                if (h === 'TABLE-HEAD' || h === 'CREATE-NEW') break;
                const m = h === 'SET-WEIGHT'
                    ? lines[i].code.match(/\s+([-\d.eE+]+)\s+(\d+)\s*(?:-\s*(\d+))?/)
                    : null;
                if (m) {
                    spans.push({ weight: Number(m[1]),
                                 lo: Number(m[2]) - firstId,
                                 hi: (m[3] ? Number(m[3]) : Number(m[2])) - firstId,
                                 source: lines[i].note || '' });
                } else if (lines[i].code && !IGNORED.has(h)) {
                    unknown.push({ line: lines[i].line, code: lines[i].code });
                }
                i++;
            }
            blocks.push({
                line, rows, directives,
                weightAt: (n) => {
                    const s = spans.find((sp) => n >= sp.lo && n <= sp.hi);
                    return { weight: s ? s.weight : 1,
                             source: (s && s.source) || label };
                },
            });
            continue;
        }

        if (head === 'CREATE-NEW') {
            // A single equilibrium, read only to refuse it with a reason; it
            // usually fixes T and leaves the compositions to another block.
            const directives = [];
            i++;
            while (i < lines.length) {
                const h = canon(lines[i].code.split(/\s+/)[0] || '');
                if (h === 'CREATE-NEW' || h === 'TABLE-HEAD') break;
                if (lines[i].code) directives.push(lines[i]);
                i++;
            }
            const d = readDirectives(directives, phases);
            const hasX = d.experiments.some((e) => e.quantity === 'X')
                || d.conditions.some((c) => c.quantity === 'X');
            const hasT = d.experiments.some((e) => e.quantity === 'T')
                || d.conditions.some((c) => c.quantity === 'T');
            refusals.push({
                at: `line ${line}`,
                reason: hasX && !hasT
                    ? 'a single equilibrium giving compositions but no temperature'
                    : hasT && !hasX
                        ? 'a single equilibrium giving a temperature but no composition'
                        : 'a single equilibrium this reader cannot reduce to a point',
            });
            continue;
        }

        if (code && !IGNORED.has(head) && head !== 'TABLE-END' && head !== 'TABLE-VALUES') {
            unknown.push({ line, code });
        }
        i++;
    }

    const points = [];
    const notes = [];
    let badRows = 0;
    for (const block of blocks) {
        const r = readTable(block, { elements, phases });
        if (r.refusal) { refusals.push(r.refusal); continue; }
        points.push(...r.points);
        badRows += r.badRows.length;
        if (r.note) notes.push(r.note);
    }

    // Refusals are grouped by reason, since one file can have many.
    const errors = [];
    const byReason = new Map();
    for (const r of refusals) {
        if (!byReason.has(r.reason)) byReason.set(r.reason, []);
        byReason.get(r.reason).push(r.at);
    }
    for (const [reason, where] of byReason) {
        errors.push(`${where.length === 1 ? '1 block' : `${where.length} blocks`} not read `
            + `— ${reason} (${where.slice(0, 3).join(', ')}`
            + `${where.length > 3 ? `, +${where.length - 3} more` : ''})`);
    }
    if (badRows) {
        errors.push(`${badRows} table row(s) held no number where a column was expected`);
    }
    for (const n of new Set(notes)) errors.push(`phase name kept as written — ${n}`);
    if (unknown.length) {
        errors.push(`${unknown.length} directive(s) this reader does not know, skipped: `
            + unknown.slice(0, 3).map((u) => `${u.code.split(/\s+/)[0]} (line ${u.line})`).join(', ')
            + (unknown.length > 3 ? `, +${unknown.length - 3} more` : ''));
    }
    if (points.length === 0 && errors.length === 0) {
        errors.push('no TABLE-HEAD block in the file');
    }
    return { points, errors };
}

/// Whether this text is a `.POP` rather than a CSV or JSON, decided by content:
/// these directives start lines in every POP and in no delimited file.
export function looksLikePop(text) {
    return /^[ \t]*(TABLE[-_]HEAD|TABLE[-_]VALUES|CREATE[-_]NEW)\b/im.test(text);
}
