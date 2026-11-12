// resolve.js: maps compositions and phase names from Thermo-Calc `.pop` and
// ESPEI ZPF files onto this database. Shared by both readers.
//
// x is the mole fraction of the database's second element, so a file written
// in terms of the first is mirrored. A mistake here draws a plausible diagram
// in the wrong place, which reads as a model disagreement.

/// Returns a function that puts a composition of `element` onto the app's x
/// axis, or null when `element` is in neither position of `elements`. It is a
/// function rather than a flag so that the mirror cannot be skipped.
export function axisFor(element, elements) {
    const el = String(element || '').toUpperCase();
    const first = String(elements[0] || '').toUpperCase();
    const second = String(elements[1] || '').toUpperCase();
    if (el && el === second) return (v) => v;
    if (el && el === first) return (v) => 1 - v;
    return null;
}

/// Resolves a phase name from a foreign file against this database: an exact
/// match, else Thermo-Calc's rule of a unique prefix (`LIQ` for LIQUID).
///
/// `phases` must be the phases the engine models, not every declared phase:
/// a rejected phase can make a prefix ambiguous (`FCC` in Cr-Ni). A name with
/// no match or several is kept as written and returned with a note; the point
/// still loads, and its residual reports `matched_phase: false`.
export function resolvePhase(name, phases) {
    const want = String(name || '').toUpperCase();
    if (!want) return { phase: '' };
    const exact = phases.find((p) => p.toUpperCase() === want);
    if (exact) return { phase: exact };
    const hits = phases.filter((p) => p.toUpperCase().startsWith(want));
    if (hits.length === 1) return { phase: hits[0] };
    return {
        phase: name,
        note: hits.length === 0
            ? `no phase in this database is called ${name} or starts with it`
            : `${name} could be ${hits.join(' or ')}`,
    };
}
