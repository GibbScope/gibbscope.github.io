// elements.js: periodic-table data and each element's cell in the picker grid.
// Keyed by the uppercase symbol, as TDB files and the manifest spell it (`FE`).

// [Z, symbol, name, group, period]. `group` is null for the lanthanides and
// actinides, which go in the two rows below the main table.
const RAW = [
    [1, 'H', 'hydrogen', 1, 1], [2, 'He', 'helium', 18, 1],
    [3, 'Li', 'lithium', 1, 2], [4, 'Be', 'beryllium', 2, 2],
    [5, 'B', 'boron', 13, 2], [6, 'C', 'carbon', 14, 2],
    [7, 'N', 'nitrogen', 15, 2], [8, 'O', 'oxygen', 16, 2],
    [9, 'F', 'fluorine', 17, 2], [10, 'Ne', 'neon', 18, 2],
    [11, 'Na', 'sodium', 1, 3], [12, 'Mg', 'magnesium', 2, 3],
    [13, 'Al', 'aluminium', 13, 3], [14, 'Si', 'silicon', 14, 3],
    [15, 'P', 'phosphorus', 15, 3], [16, 'S', 'sulfur', 16, 3],
    [17, 'Cl', 'chlorine', 17, 3], [18, 'Ar', 'argon', 18, 3],
    [19, 'K', 'potassium', 1, 4], [20, 'Ca', 'calcium', 2, 4],
    [21, 'Sc', 'scandium', 3, 4], [22, 'Ti', 'titanium', 4, 4],
    [23, 'V', 'vanadium', 5, 4], [24, 'Cr', 'chromium', 6, 4],
    [25, 'Mn', 'manganese', 7, 4], [26, 'Fe', 'iron', 8, 4],
    [27, 'Co', 'cobalt', 9, 4], [28, 'Ni', 'nickel', 10, 4],
    [29, 'Cu', 'copper', 11, 4], [30, 'Zn', 'zinc', 12, 4],
    [31, 'Ga', 'gallium', 13, 4], [32, 'Ge', 'germanium', 14, 4],
    [33, 'As', 'arsenic', 15, 4], [34, 'Se', 'selenium', 16, 4],
    [35, 'Br', 'bromine', 17, 4], [36, 'Kr', 'krypton', 18, 4],
    [37, 'Rb', 'rubidium', 1, 5], [38, 'Sr', 'strontium', 2, 5],
    [39, 'Y', 'yttrium', 3, 5], [40, 'Zr', 'zirconium', 4, 5],
    [41, 'Nb', 'niobium', 5, 5], [42, 'Mo', 'molybdenum', 6, 5],
    [43, 'Tc', 'technetium', 7, 5], [44, 'Ru', 'ruthenium', 8, 5],
    [45, 'Rh', 'rhodium', 9, 5], [46, 'Pd', 'palladium', 10, 5],
    [47, 'Ag', 'silver', 11, 5], [48, 'Cd', 'cadmium', 12, 5],
    [49, 'In', 'indium', 13, 5], [50, 'Sn', 'tin', 14, 5],
    [51, 'Sb', 'antimony', 15, 5], [52, 'Te', 'tellurium', 16, 5],
    [53, 'I', 'iodine', 17, 5], [54, 'Xe', 'xenon', 18, 5],
    [55, 'Cs', 'caesium', 1, 6], [56, 'Ba', 'barium', 2, 6],
    [57, 'La', 'lanthanum', null, 6], [58, 'Ce', 'cerium', null, 6],
    [59, 'Pr', 'praseodymium', null, 6], [60, 'Nd', 'neodymium', null, 6],
    [61, 'Pm', 'promethium', null, 6], [62, 'Sm', 'samarium', null, 6],
    [63, 'Eu', 'europium', null, 6], [64, 'Gd', 'gadolinium', null, 6],
    [65, 'Tb', 'terbium', null, 6], [66, 'Dy', 'dysprosium', null, 6],
    [67, 'Ho', 'holmium', null, 6], [68, 'Er', 'erbium', null, 6],
    [69, 'Tm', 'thulium', null, 6], [70, 'Yb', 'ytterbium', null, 6],
    [71, 'Lu', 'lutetium', null, 6],
    [72, 'Hf', 'hafnium', 4, 6], [73, 'Ta', 'tantalum', 5, 6],
    [74, 'W', 'tungsten', 6, 6], [75, 'Re', 'rhenium', 7, 6],
    [76, 'Os', 'osmium', 8, 6], [77, 'Ir', 'iridium', 9, 6],
    [78, 'Pt', 'platinum', 10, 6], [79, 'Au', 'gold', 11, 6],
    [80, 'Hg', 'mercury', 12, 6], [81, 'Tl', 'thallium', 13, 6],
    [82, 'Pb', 'lead', 14, 6], [83, 'Bi', 'bismuth', 15, 6],
    [84, 'Po', 'polonium', 16, 6], [85, 'At', 'astatine', 17, 6],
    [86, 'Rn', 'radon', 18, 6],
    [87, 'Fr', 'francium', 1, 7], [88, 'Ra', 'radium', 2, 7],
    [89, 'Ac', 'actinium', null, 7], [90, 'Th', 'thorium', null, 7],
    [91, 'Pa', 'protactinium', null, 7], [92, 'U', 'uranium', null, 7],
    [93, 'Np', 'neptunium', null, 7], [94, 'Pu', 'plutonium', null, 7],
    [95, 'Am', 'americium', null, 7], [96, 'Cm', 'curium', null, 7],
    [97, 'Bk', 'berkelium', null, 7], [98, 'Cf', 'californium', null, 7],
    [99, 'Es', 'einsteinium', null, 7], [100, 'Fm', 'fermium', null, 7],
    [101, 'Md', 'mendelevium', null, 7], [102, 'No', 'nobelium', null, 7],
    [103, 'Lr', 'lawrencium', null, 7],
    [104, 'Rf', 'rutherfordium', 4, 7], [105, 'Db', 'dubnium', 5, 7],
    [106, 'Sg', 'seaborgium', 6, 7], [107, 'Bh', 'bohrium', 7, 7],
    [108, 'Hs', 'hassium', 8, 7], [109, 'Mt', 'meitnerium', 9, 7],
    [110, 'Ds', 'darmstadtium', 10, 7], [111, 'Rg', 'roentgenium', 11, 7],
    [112, 'Cn', 'copernicium', 12, 7], [113, 'Nh', 'nihonium', 13, 7],
    [114, 'Fl', 'flerovium', 14, 7], [115, 'Mc', 'moscovium', 15, 7],
    [116, 'Lv', 'livermorium', 16, 7], [117, 'Ts', 'tennessine', 17, 7],
    [118, 'Og', 'oganesson', 18, 7],
];

/// Grid rows of the two f-block rows. Row 8 is an empty spacer.
export const F_BLOCK_ROWS = { 6: 9, 7: 10 };

/// First column of the f-block rows. Columns 1 and 2 stay empty so the series
/// lines up with the d-block.
const F_BLOCK_FIRST_COLUMN = 3;

const F_BLOCK_FIRST_Z = { 6: 57, 7: 89 };

export const ELEMENTS = RAW.map(([z, symbol, name, group, period]) => ({
    z,
    symbol,
    name,
    group,
    period,
    // The grid has 18 columns, numbered from 1, so the column is the group.
    column: group ?? F_BLOCK_FIRST_COLUMN + (z - F_BLOCK_FIRST_Z[period]),
    row: group ? period : F_BLOCK_ROWS[period],
}));

export const bySymbol = new Map(ELEMENTS.map((e) => [e.symbol.toUpperCase(), e]));
