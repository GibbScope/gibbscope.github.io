// palette.js: every colour the figure draws. Values come from the CSS custom
// properties in style.css, so re-theming is a stylesheet change.
//
// The phase series is eight categorical hues. Fills only need adjacent slots
// to differ, since two single-phase fields in a binary isobaric section never
// touch. The legend and the G-panel curves see all pairs, which do not all
// separate, so labels carry the identity there. Slot 0 is close to
// `--primary`, which is shared with the Neural EBSD Explorer; labels carry
// that difference too.
//
// The light figure's live mark (`--fig-highlight` in `.fig-light`) is #920afc,
// since the dark lime is unreadable on white. Its CVD distance from the series
// is 7.2, under the floor of 8, which is accepted because the live mark is
// also told apart by shape.
//
// Experimental marks have no hue, since hue means phase. Marker shape gives the
// kind of point and a lightness ramp the dataset (`--fig-exp-*` in style.css).

// The element the figure tokens are read from: the plot card, which carries its
// own theme (`.fig-light`), so a white figure can sit in dark chrome. Until the
// card is set, the root is used; it declares the dark values.
let tokenSource = null;

function cssVar(name, fallback) {
    if (typeof document === 'undefined') return fallback;
    const el = tokenSource || document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name);
    return (v && v.trim()) || fallback;
}

// ---------------------------------------------------------------- surfaces --

export const palette = {};

/// Reads every figure colour from CSS; a canvas inherits nothing. Call again
/// after a theme change. `palette` is filled in place, so code holding a
/// reference to it sees the new values.
export function refreshPalette(el = null) {
    tokenSource = el;
    Object.assign(palette, {
        bg:        cssVar('--fig-bg', '#202428'),
        surface:   cssVar('--fig-surface', '#2a2f35'),
        border:    cssVar('--fig-border', '#3a4048'),
        text:      cssVar('--fig-text', '#e8eaed'),
        textDim:   cssVar('--fig-text-dim', '#9aa0a6'),
        // Separate from `textDim` so the reference curves can be tuned without
        // changing the caption. See `drawBaselineGhost`.
        ghost:     cssVar('--fig-ghost', '#b0b6bc'),
        highlight: cssVar('--fig-highlight', '#e3ff30'),

        // Axis furniture, one step off the surface so it stays recessive.
        axis:      cssVar('--fig-text-dim', '#9aa0a6'),
        casing:    cssVar('--fig-casing', 'rgba(0, 0, 0, 0.55)'),

        // The colours `phaseColorSet` and `phaseColor` shift toward. Per
        // theme: lighter reads on dark, darker on white.
        setShift:    cssVar('--fig-set-shift', '#ffffff'),
        setShiftAlt: cssVar('--fig-set-shift-alt', '#000000'),
        // A scalar, per theme: one value cannot suit both grounds.
        coexWash: parseFloat(cssVar('--fig-coex-wash', '0.43')) || 0.43,

        // Fallbacks are the dark theme's hueless ramp.
        exp: [
            cssVar('--fig-exp-1', '#ffffff'),
            cssVar('--fig-exp-2', '#e1e1e1'),
            cssVar('--fig-exp-3', '#c4c4c4'),
        ],
        expOther: cssVar('--fig-exp-other', '#a7a7a7'),

        residualLow:  cssVar('--fig-residual-low', '#5ab0ff'),
        residualMid:  cssVar('--fig-residual-mid', '#9aa0a6'),
        residualHigh: cssVar('--fig-residual-high', '#ff5a7a'),
    });
    return palette;
}

refreshPalette();

// ------------------------------------------------------------ phase series --

export const PHASE_SERIES = [
    '#4b74d4', // blue
    '#c742a7', // magenta
    '#199e70', // aqua
    '#c98500', // yellow
    '#d55181', // magenta
    '#178c14', // green
    '#9085e9', // violet
    '#e66767', // red
];

/// How many phases this series can name before it starts reusing a hue.
export const PHASE_SERIES_LEN = PHASE_SERIES.length;

/// True when phase `index` is past the series and reuses a hue. The legend
/// marks such phases.
export function phaseColorIsReused(index) {
    return index >= PHASE_SERIES_LEN;
}

/// The colour for phase `index`. Past the eighth phase, a hue is reused at a
/// different lightness, alternating direction from the theme's readable one,
/// and the legend marks it.
export function phaseColor(index) {
    const base = PHASE_SERIES[index % PHASE_SERIES_LEN];
    const wrap = Math.floor(index / PHASE_SERIES_LEN);
    if (wrap === 0) return base;
    // Larger than the composition-set step (0.22): a reused hue sits beside
    // the original in the legend, while two sets of one phase are usually far
    // apart on the diagram.
    const toward = wrap % 2 === 1 ? palette.setShift : palette.setShiftAlt;
    return mixColors(base, toward, Math.min(0.34 + 0.12 * (wrap - 1), 0.7));
}

/// The colour for composition set `set` of phase `index` (the Cu-rich FCC
/// beside the Ag-rich one): the same hue, shifted in lightness.
export function phaseColorSet(index, set) {
    const base = phaseColor(index);
    if (!set) return base;
    // Alternate direction so three sets stay apart; the theme picks the first.
    const toward = set % 2 === 1 ? palette.setShift : palette.setShiftAlt;
    return mixColors(base, toward, 0.22 + 0.10 * Math.floor((set - 1) / 2));
}

/// A colour at partial opacity. Use this rather than writing a token's channels
/// as an rgba literal, which would not follow the theme.
export function withAlpha(color, alpha) {
    const [r, g, b] = hexToRgb(color);
    return `rgba(${r},${g},${b},${alpha})`;
}

export function mixColors(a, b, amount) {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    return rgbToHex(
        ar + amount * (br - ar),
        ag + amount * (bg - ag),
        ab + amount * (bb - ab),
    );
}

// ------------------------------------------------- experimental data marks --

export function expSourceColor(slot) {
    return slot < palette.exp.length ? palette.exp[slot] : palette.expOther;
}

// ------------------------------------------------------ residual diverging --

// Diverging scale: two opposite hues with a hueless midpoint.
export const RESIDUAL_CLAMP = 3;   // sigma at which the scale saturates

export function residualColor(signed) {
    const u = Math.max(-1, Math.min(1, (signed || 0) / RESIDUAL_CLAMP));
    return u < 0 ? mixColors(palette.residualMid, palette.residualLow, -u)
                 : mixColors(palette.residualMid, palette.residualHigh, u);
}

// ------------------------------------------------------------------ helpers --

function hexToRgb(hex) {
    const h = hex.replace('#', '').trim();
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(full, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r, g, b) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + ((1 << 24) + (clamp(r) << 16) + (clamp(g) << 8) + clamp(b))
        .toString(16).slice(1);
}
