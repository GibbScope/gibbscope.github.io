// espei.js: reads ESPEI ZPF datasets as experimental points.
//
//   {
//     "components": ["CU", "MG"],
//     "conditions": { "P": 101325, "T": [1056.11, 1062.70, ...] },
//     "output": "ZPF",
//     "values": [
//       [["LIQUID", ["MG"], [0.29042]], ["LAVES_C15", ["MG"], [null]]],
//       ...
//     ],
//     "reference": "Bagnoud (1978)", "weight": 10.0
//   }
//
// Each `values` row lists `[phase, [component], [fraction]]` at T[i]; a null
// fraction means the phase was present but its composition not measured. One
// measured composition gives a boundary point, two give a tie-line, and none
// gives nothing to draw (counted and reported).
//
// Only `output: "ZPF"` is read; activity and thermochemical datasets have the
// same structure, so they are refused by name. Also refused: disabled datasets,
// `broadcast_conditions`, conditions other than P and T, and entries with more
// than one component. ZPF datasets carry no uncertainties, so `x_err` and
// `t_err` are 0 and the engine's defaults (0.01, 10 K) apply.
//
// Pure: no DOM, no globals.

import { axisFor, resolvePhase } from './resolve.js';

/// Non-ZPF outputs and their names for the refusal message, matched on the
/// prefix since they carry a suffix (`ACR_MG`, `HM_MIX`).
const NOT_A_DIAGRAM_POINT = [
    [/^HM/i, 'enthalpy'],
    [/^SM/i, 'entropy'],
    [/^GM/i, 'Gibbs energy'],
    [/^CPM/i, 'heat capacity'],
    [/^ACR/i, 'activity'],
    [/^MU/i, 'chemical potential'],
];

/// Whether a parsed JSON object is an ESPEI dataset of any output, so that
/// `parseEspei` can refuse a non-ZPF file by name instead of the point-record
/// parser rejecting it with misleading errors.
export function looksLikeEspei(obj) {
    return Boolean(obj) && typeof obj === 'object' && !Array.isArray(obj)
        && typeof obj.output === 'string'
        && Array.isArray(obj.values)
        && Boolean(obj.conditions) && typeof obj.conditions === 'object';
}

/// Reads an ESPEI dataset.
///
/// @param {object} data       the parsed JSON
/// @param {object} ctx        `{ fileName, elements, phases }` — `elements` is
///                            the database's two in its declared order,
///                            `phases` the set the engine models.
/// @returns {{points: object[], errors: string[]}} the same shape the CSV, JSON
///          and `.pop` readers return.
export function parseEspei(data, { fileName, elements, phases }) {
    const label = data.reference || data.bibtex || fileName.replace(/\.[^.]+$/, '');
    const refuse = (why) => ({ points: [], errors: [`${fileName} was not read — ${why}`] });

    if (data.disabled) {
        const why = data['disabled-reason'] || data.disabled_reason;
        return refuse('the file marks it disabled'
            + (why ? `: "${String(why).slice(0, 160)}"` : ', with no reason given'));
    }
    const out = String(data.output);
    if (out.toUpperCase() !== 'ZPF') {
        const named = NOT_A_DIAGRAM_POINT.find(([re]) => re.test(out));
        return refuse(named
            ? `it is ${named[1]} (output ${out}), not a phase boundary`
            : `its output is ${out}, and only ZPF is a set of (x, T) points`);
    }
    if (data.broadcast_conditions) {
        return refuse('broadcast_conditions is set, so its conditions are a grid '
            + 'rather than a list and values is indexed by something this reader '
            + 'does not compute');
    }

    const conditions = data.conditions || {};
    const extra = Object.keys(conditions).filter((k) => k !== 'P' && k !== 'T');
    if (extra.length) {
        return refuse(`it fixes ${extra.join(', ')} as well as T, and this reader `
            + 'pairs T[i] with values[i] and nothing else');
    }
    const temps = Array.isArray(conditions.T) ? conditions.T : null;
    if (!temps && !Number.isFinite(conditions.T)) {
        return refuse('it has no temperature condition');
    }
    if (temps && temps.length !== data.values.length) {
        return refuse(`it lists ${temps.length} temperatures against `
            + `${data.values.length} value rows, so they cannot be paired`);
    }

    const weight = Number.isFinite(data.weight) && data.weight >= 0 ? data.weight : 1;
    const points = [];
    const notes = new Set();
    let noComposition = 0, offSystem = 0, ternary = 0, tooMany = 0;

    data.values.forEach((tuple, i) => {
        const t = temps ? Number(temps[i]) : Number(conditions.T);
        if (!Number.isFinite(t) || !Array.isArray(tuple)) { noComposition++; return; }

        const measured = [];
        for (const entry of tuple) {
            if (!Array.isArray(entry) || entry.length < 3) continue;
            const [name, comps, fracs] = entry;
            if (!Array.isArray(comps) || !Array.isArray(fracs)) continue;
            if (fracs[0] === null || fracs[0] === undefined) continue;
            if (comps.length !== 1) { ternary++; continue; }
            const axis = axisFor(comps[0], elements);
            if (!axis) { offSystem++; continue; }
            const v = Number(fracs[0]);
            if (!Number.isFinite(v)) { noComposition++; continue; }
            const r = resolvePhase(name, phases);
            if (r.note) notes.add(r.note);
            measured.push({ phase: r.phase, x: axis(v) });
        }

        if (measured.length === 0) { noComposition++; return; }
        if (measured.length > 2) { tooMany++; return; }

        const mk = (m, kind) => ({
            x: m.x, t, kind, phase: m.phase,
            x_err: 0, t_err: 0, weight, source: label,
        });
        if (measured.length === 1) {
            points.push(mk(measured[0], 'boundary'));
            return;
        }
        // Two measured ends: a tie-line, ordered by x rather than file order.
        // visual-check's fixture covers this path.
        const [lo, hi] = measured[0].x <= measured[1].x
            ? [measured[0], measured[1]] : [measured[1], measured[0]];
        points.push(mk(lo, 'tie_left'), mk(hi, 'tie_right'));
    });

    const errors = [];
    if (noComposition) {
        errors.push(`${noComposition} row(s) name the phases in equilibrium but `
            + 'measured no composition, so there is nothing to draw for them');
    }
    if (offSystem) {
        errors.push(`${offSystem} composition(s) are of an element that is not `
            + `${elements.join('-')}`);
    }
    if (ternary) {
        errors.push(`${ternary} entr(y/ies) name more than one component, which is a `
            + 'ternary or higher and has no place on a binary axis');
    }
    if (tooMany) {
        errors.push(`${tooMany} row(s) measured more than two phases at once, which is `
            + 'not a tie-line this reader can place');
    }
    for (const n of notes) errors.push(`phase name kept as written — ${n}`);
    if (points.length === 0 && errors.length === 0) {
        errors.push(`${fileName} is a ZPF dataset with no values in it`);
    }
    return { points, errors };
}
