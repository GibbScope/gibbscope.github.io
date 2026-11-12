// svg-canvas.js: a minimal CanvasRenderingContext2D that records SVG.
//
// `drawPhaseDiagram` and `drawGibbsCurves` draw into this instead of a canvas,
// so the SVG export uses the same drawing code as the screen. Only the
// operations they use are implemented; the others throw (see the end of the
// file). Any method that returns a value the caller lays out with, such as
// `measureText`, must give the same answer as a real canvas.

const XMLNS = 'http://www.w3.org/2000/svg';

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function num(v) {
    // Three decimals keeps files small without visible loss at print sizes.
    return Number.isFinite(v) ? (Math.round(v * 1000) / 1000) : 0;
}

/// Splits a CSS colour into an opaque paint and an alpha. SVG 1.1 colours have
/// no alpha (`rgba()` is legal only from SVG 2), and a strict reader may turn
/// an `rgba()` paint black. The alpha goes into `fill-opacity` or
/// `stroke-opacity` instead. A colour without alpha is returned unchanged.
function splitAlpha(color) {
    const s = String(color).trim();

    const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
    if (fn) {
        const p = fn[1].split(',').map(v => v.trim());
        // Only the comma form occurs (`withAlpha`, `--fig-casing`);
        // any other form is returned unchanged.
        if (p.length !== 4) return { color: s, alpha: 1 };
        const raw = p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
        if (!Number.isFinite(raw)) return { color: s, alpha: 1 };
        return {
            color: `rgb(${p[0]}, ${p[1]}, ${p[2]})`,
            alpha: Math.min(1, Math.max(0, raw)),
        };
    }

    return { color: s, alpha: 1 };
}

export class SvgContext {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.body = [];
        this.defs = [];
        this._clipCount = 0;

        this.fillStyle = '#000';
        this.strokeStyle = '#000';
        this.lineWidth = 1;
        this.lineJoin = 'miter';
        this.lineCap = 'butt';
        this.globalAlpha = 1;
        this.font = '11px sans-serif';
        this.textAlign = 'start';
        this.textBaseline = 'alphabetic';
        this.imageSmoothingEnabled = true;

        this._dash = [];
        this._path = [];
        this._stack = [];
        this._clip = null;
        this._groups = 0;
    }

    // ---------------------------------------------------------------- state --

    save() {
        this._stack.push({
            fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
            lineWidth: this.lineWidth, lineJoin: this.lineJoin, lineCap: this.lineCap,
            globalAlpha: this.globalAlpha, font: this.font,
            textAlign: this.textAlign, textBaseline: this.textBaseline,
            dash: this._dash.slice(), clip: this._clip, groups: this._groups,
        });
    }

    restore() {
        const s = this._stack.pop();
        if (!s) return;
        Object.assign(this, {
            fillStyle: s.fillStyle, strokeStyle: s.strokeStyle,
            lineWidth: s.lineWidth, lineJoin: s.lineJoin, lineCap: s.lineCap,
            globalAlpha: s.globalAlpha, font: s.font,
            textAlign: s.textAlign, textBaseline: s.textBaseline,
        });
        this._dash = s.dash;
        this._clip = s.clip;
        // Close any transform groups opened since the matching save().
        while (this._groups > s.groups) { this.body.push('</g>'); this._groups--; }
    }

    // Transforms become nested <g> elements, not a tracked matrix, so they must
    // be bracketed by save()/restore() (as for the rotated y-axis title).
    translate(x, y) {
        this.body.push(`<g transform="translate(${num(x)} ${num(y)})">`);
        this._groups++;
    }

    rotate(radians) {
        this.body.push(`<g transform="rotate(${num(radians * 180 / Math.PI)})">`);
        this._groups++;
    }

    setLineDash(d) { this._dash = Array.isArray(d) ? d.slice() : []; }
    getLineDash() { return this._dash.slice(); }
    scale() { /* the caller sizes the viewBox instead */ }

    // ----------------------------------------------------------------- paths --

    beginPath() { this._path = []; }
    moveTo(x, y) { this._path.push(`M${num(x)} ${num(y)}`); }
    lineTo(x, y) { this._path.push(`L${num(x)} ${num(y)}`); }
    closePath() { this._path.push('Z'); }

    rect(x, y, w, h) {
        this._path.push(`M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}Z`);
    }

    /// Full circles only (the markers), as two half arcs.
    arc(cx, cy, r, start, end) {
        if (Math.abs(end - start) < Math.PI * 2 - 1e-6) {
            assertSupported('arc', 'a partial', 'Only full circles are drawn.');
        }
        this._path.push(
            `M${num(cx - r)} ${num(cy)}` +
            `a${num(r)} ${num(r)} 0 1 0 ${num(r * 2)} 0` +
            `a${num(r)} ${num(r)} 0 1 0 ${num(-r * 2)} 0Z`);
    }

    fill() { this._emitPath({ fill: this.fillStyle, stroke: 'none' }); }
    stroke() { this._emitPath({ fill: 'none', stroke: this.strokeStyle }); }

    fillRect(x, y, w, h) {
        this._push(`<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`
            + `${this._paint('fill', this.fillStyle)}${this._alpha()}/>`);
    }

    strokeRect(x, y, w, h) {
        this._push(`<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"`
            + ` fill="none"${this._paint('stroke', this.strokeStyle)}`
            + ` stroke-width="${num(this.lineWidth)}"${this._alpha()}/>`);
    }

    clip() {
        const id = `clip${++this._clipCount}`;
        this.defs.push(`<clipPath id="${id}"><path d="${this._path.join('')}"/></clipPath>`);
        this._clip = id;
    }

    // ------------------------------------------------------------------ text --

    /// Splits a CSS font shorthand into weight, size and family. A plain
    /// `parseFloat` would read "600 12px …" as size 600.
    _parseFont() {
        const m = /(?:([1-9]00|bold|bolder|lighter|normal)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/
            .exec(this.font || '');
        return m
            ? { weight: m[1] || null, size: parseFloat(m[2]), family: m[3].trim() }
            : { weight: null, size: 11, family: 'monospace' };
    }

    /// Measures with a real 2D context. `drawRegionLabels` uses the width to
    /// decide whether a label fits or wraps, and an estimate would wrap labels
    /// differently in the file. One measuring canvas per context, made on
    /// first use; one per string would dominate an export.
    measureText(text) {
        if (!this._metricsCtx) this._metricsCtx = document.createElement('canvas').getContext('2d');
        this._metricsCtx.font = this.font;
        return this._metricsCtx.measureText(String(text));
    }

    fillText(text, x, y) { this._text(text, x, y, { fill: this.fillStyle, stroke: 'none' }); }

    strokeText(text, x, y) {
        this._text(text, x, y, {
            fill: 'none', stroke: this.strokeStyle, strokeWidth: this.lineWidth,
        });
    }

    // ----------------------------------------------------------------- image --

    /// The phase raster, embedded as a data URI so the SVG is self-contained,
    /// and pixelated so each cell stays a sharp square.
    drawImage(source, dx, dy, dw, dh) {
        let href;
        try { href = source.toDataURL('image/png'); } catch { return; }
        this._push(`<image href="${esc(href)}" x="${num(dx)}" y="${num(dy)}"`
            + ` width="${num(dw)}" height="${num(dh)}"`
            + ` preserveAspectRatio="none" image-rendering="pixelated"${this._alpha()}/>`);
    }

    // --------------------------------------------------------------- output --

    toSvg({ background = null, title = '', description = '' } = {}) {
        while (this._groups > 0) { this.body.push('</g>'); this._groups--; }
        const defs = this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '';
        const bg = background
            ? `<rect width="${num(this.width)}" height="${num(this.height)}"`
              + `${this._paint('fill', background)}/>`
            : '';
        return `<?xml version="1.0" encoding="UTF-8"?>\n`
            + `<svg xmlns="${XMLNS}" width="${num(this.width)}" height="${num(this.height)}"`
            + ` viewBox="0 0 ${num(this.width)} ${num(this.height)}">`
            + (title ? `<title>${esc(title)}</title>` : '')
            // Provenance goes in `<desc>`; SVG optimisers strip comments.
            + (description ? `<desc>${esc(description)}</desc>` : '')
            + defs + bg + this.body.join('') + '</svg>\n';
    }

    // --------------------------------------------------------------- private --

    /// A paint attribute, plus `*-opacity` when the colour has alpha. Each
    /// element paints either fill or stroke, never both, so `opacity` (from
    /// `globalAlpha`) times `*-opacity` equals what a canvas draws. That breaks
    /// if an element ever paints both.
    _paint(kind, color) {
        if (color === 'none') return ` ${kind}="none"`;
        const { color: paint, alpha } = splitAlpha(color);
        return ` ${kind}="${esc(paint)}"`
            + (alpha < 1 ? ` ${kind}-opacity="${num(alpha)}"` : '');
    }

    _alpha() {
        return this.globalAlpha < 1 ? ` opacity="${num(this.globalAlpha)}"` : '';
    }

    _clipAttr() {
        return this._clip ? ` clip-path="url(#${this._clip})"` : '';
    }

    _push(el) {
        this.body.push(el.replace('/>', `${this._clipAttr()}/>`));
    }

    _emitPath({ fill, stroke }) {
        if (this._path.length === 0) return;
        const d = this._path.join('');
        let attrs = this._paint('fill', fill);
        if (stroke !== 'none') {
            attrs += `${this._paint('stroke', stroke)} stroke-width="${num(this.lineWidth)}"`;
            if (this.lineJoin !== 'miter') attrs += ` stroke-linejoin="${esc(this.lineJoin)}"`;
            if (this.lineCap !== 'butt') attrs += ` stroke-linecap="${esc(this.lineCap)}"`;
            if (this._dash.length) attrs += ` stroke-dasharray="${this._dash.map(num).join(' ')}"`;
        }
        this.body.push(`<path d="${d}"${attrs}${this._alpha()}${this._clipAttr()}/>`);
    }

    _text(text, x, y, { fill, stroke, strokeWidth }) {
        const anchor = { center: 'middle', right: 'end', end: 'end' }[this.textAlign] || 'start';
        const baseline = {
            top: 'hanging', middle: 'central', bottom: 'auto', alphabetic: 'auto',
        }[this.textBaseline] || 'auto';
        const { size, family, weight } = this._parseFont();

        let attrs = `x="${num(x)}" y="${num(y)}" font-size="${num(size)}"`
            + ` font-family="${esc(family)}" text-anchor="${anchor}"`
            + ` dominant-baseline="${baseline}"${this._paint('fill', fill)}`;
        if (weight) attrs += ` font-weight="${esc(weight)}"`;
        if (stroke !== 'none') {
            attrs += `${this._paint('stroke', stroke)}`
                + ` stroke-width="${num(strokeWidth || 1)}" paint-order="stroke"`;
        }
        this.body.push(`<text ${attrs}${this._alpha()}${this._clipAttr()}>${esc(text)}</text>`);
    }
}

// ------------------------------------------------------------ unsupported --

// Unimplemented methods throw with a hint instead of the generic "is not a
// function". Unimplemented properties throw on assignment: otherwise
// `ctx.globalCompositeOperation = 'multiply'` would change the screen and
// silently not the SVG.
function assertSupported(name, kind, hint) {
    throw new Error(
        `SvgContext does not implement ${kind} \`${name}\`, so the vector figure `
        + `would differ from the canvas.${hint ? ' ' + hint : ''}`);
}

// Not the whole 2D API: the methods drawing code like this is likely to try.
const UNSUPPORTED_METHODS = {
    clearRect: 'An SVG is an append-only display list and cannot erase. Paint '
        + 'the background with fillRect instead, as drawPhaseDiagram does.',
    setTransform: 'Transforms here are nested <g> wrappers; use translate/rotate '
        + 'bracketed by save()/restore().',
    transform: null, resetTransform: null, getTransform: null,
    bezierCurveTo: null, quadraticCurveTo: null, arcTo: null,
    ellipse: null, roundRect: null,
    createLinearGradient: 'SVG gradients need a <defs> entry per gradient; none '
        + 'is emitted.',
    createRadialGradient: null, createConicGradient: null, createPattern: null,
    getImageData: 'Nothing is rasterized here, so there are no pixels to read.',
    putImageData: null, createImageData: null,
    isPointInPath: null, isPointInStroke: null,
};

for (const [name, hint] of Object.entries(UNSUPPORTED_METHODS)) {
    SvgContext.prototype[name] = function () {
        assertSupported(name, 'method', hint);
    };
}

// Properties that change a canvas picture. Writing one throws; reading gives
// undefined, as feature detection expects.
const UNSUPPORTED_PROPERTIES = [
    'globalCompositeOperation', 'filter', 'lineDashOffset', 'miterLimit',
    'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
    'direction', 'letterSpacing', 'wordSpacing', 'fontKerning',
];

for (const name of UNSUPPORTED_PROPERTIES) {
    Object.defineProperty(SvgContext.prototype, name, {
        get() { return undefined; },
        set() { assertSupported(name, 'property'); },
        configurable: true,
    });
}
