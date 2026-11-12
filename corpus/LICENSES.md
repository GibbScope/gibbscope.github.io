# Licenses

## GibbScope

The terms are in `LICENSE`.

## Rust libraries

The WebAssembly module in `app/pkg/` is compiled from the open-source Rust
libraries (crates) listed below, as resolved from `engine/Cargo.lock`. Each is
distributed under the license shown, and its copyright notice and license text
are in its source repository.

| crate | version | license |
| :--- | ---: | :--- |
| bumpalo | 3.19.1 | MIT OR Apache-2.0 |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| js-sys | 0.3.85 | MIT OR Apache-2.0 |
| memchr | 2.8.0 | Unlicense OR MIT |
| once_cell | 1.21.3 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.106 | MIT OR Apache-2.0 |
| quote | 1.0.44 | MIT OR Apache-2.0 |
| rustversion | 1.0.22 | MIT OR Apache-2.0 |
| serde | 1.0.228 | MIT OR Apache-2.0 |
| serde-wasm-bindgen | 0.6.5 | MIT |
| serde_core | 1.0.228 | MIT OR Apache-2.0 |
| serde_derive | 1.0.228 | MIT OR Apache-2.0 |
| serde_json | 1.0.149 | MIT OR Apache-2.0 |
| syn | 2.0.114 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.22 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| wasm-bindgen | 0.2.108 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.108 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.108 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.108 | MIT OR Apache-2.0 |
| zmij | 1.0.21 | MIT |

## SGTE binary databases

The databases in `data/tdb/` and the example databases in `app/examples/` are
from Hallstedt, "The SGTE collection of binary datasets", *Calphad* (2025),
<https://doi.org/10.1016/j.calphad.2025.102833>.
They are redistributed unmodified under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Each file begins
with a `$` comment block that gives the reference for its assessment; these
blocks are part of the attribution and are left as published.

## Experimental data loaded with the examples

The experimental data loaded with four of the examples are from the following
sources. The header of each data file lists the tables the points were taken
from and the points that were left out.

- **Ag–Cu** (`app/examples/agcu-86hay/data/`): liquidus temperatures from
  Heycock and Neville
  ([*Phil. Trans. R. Soc. A* 189, 1897](https://doi.org/10.1098/rsta.1897.0002))
  and from six thermal-analysis studies compiled by Subramanian and Perepezko
  ([*J. Phase Equilib.* 14, 1993](https://doi.org/10.1007/BF02652162)), which
  cites the original studies; the Ag-rich solidus and solvus from Bienzle et
  al. ([*Mater. Trans. JIM* 33, 1992](https://doi.org/10.2320/matertrans1989.33.51)).
- **Al–Si** (`app/examples/alsi-97feu/data/`): adopted from Murray and
  McAlister
  ([*Bull. Alloy Phase Diagrams* 5, 1984](https://doi.org/10.1007/BF02868729)),
  which compiles measurements from the original studies cited therein.
- **Cr–Ni** (`app/examples/crni-16tan/data/`): adopted from Tang and Hallstedt
  ([*Calphad* 55, 2016](https://doi.org/10.1016/j.calphad.2016.10.003)), which
  compiles measurements from the original studies cited therein.
- **Fe–Ni** (`app/examples/feni-03dup/data/`): liquidus, solidus, and δ/γ
  arrests from Hellawell and Hume-Rothery
  ([*Phil. Trans. R. Soc. A* 249, 1957](https://doi.org/10.1098/rsta.1957.0004)),
  as transcribed in
  [ESPEI-datasets](https://github.com/PhasesResearchLab/ESPEI-datasets), which
  is licensed under CC BY 4.0. The phase names were changed to those of the
  database, and the six δ/γ arrests were left without a phase, for the reason
  given in the file header. The solid–liquid tie lines at 1500 °C are from
  Chabot et al.
  ([*Meteorit. Planet. Sci.* 52, 2017](https://doi.org/10.1111/maps.12864)).
