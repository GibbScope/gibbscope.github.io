# Example systems

The **Example system** dropdown lists the systems in this folder. Adding,
removing, or replacing an example changes data only.

## Layout

```
examples/
  examples.json              <- the manifest the app reads
  agcu-86hay/
    AgCu-86Hay.tdb           <- the database
    data/
      agcu-heycock1897-subramanian1993-bienzle1992.csv
                             <- experimental data loaded with it
```

Each example has its own folder, with the `.tdb` file at its root and its data
files in a `data/` subfolder. The Rust tests read these same files with
`include_str!`, so the tests validate the databases that the app loads.

## The manifest

`examples.json` is an array of entries, with paths relative to this folder.

| field | required | meaning |
| :--- | :--- | :--- |
| `id` | yes | Short identifier, also used as the `?example=<id>` URL parameter. |
| `label` | yes | The name shown in the dropdown. |
| `tdb` | yes | Path to the database file. |
| `data` | no | Paths to the CSV or JSON files loaded with the database. Omitted when an example has no data. |
| `note` | no | A few sentences shown under the dropdown. `[text](https://…)` becomes a link; cite the source of an example's data this way. |
| `default` | no | `true` on the example loaded at startup, currently Cr–Ni. If no entry is marked, the first one is loaded. |

A link without `example=` opens the default example, so changing the default
also changes what existing links show. `tools/visual-check.mjs` checks that the
default is Cr–Ni.

## Replacing the data

To use other data with an example, place a CSV file in its `data/` folder, list
it under `data`, and reload the page. The file format is described in About,
under *Experimental Data File*: the required columns are `x` and `T`, and the
optional ones are `kind`, `x_err`, `T_err`, `phase`, `weight`, and `source`.

## Sources of the data

- `agcu-86hay/data/agcu-heycock1897-subramanian1993-bienzle1992.csv` holds
  185 measured points from eight studies: the liquidus of Heycock and Neville
  (*Phil. Trans. R. Soc. A* **189**, 25–70, 1897), read from their Tables
  Ia–Ic; six thermal-analysis liquidus studies from 1907 to 1967, as tabulated
  by Subramanian and Perepezko (*J. Phase Equilib.* **14**, 62–75, 1993,
  Table 2); and the Ag-rich solidus and solvus from the EMF measurements of
  Bienzle et al. (*Mater. Trans. JIM* **33**, 51–56, 1992, Table 7). Heycock
  and Neville's eutectic arrests are omitted because they were measured at
  each alloy's overall composition, which the data format cannot score against
  a reaction line. The file header lists this and the other choices made.
- `alsi-97feu/`, `bipb-98boa/`, and `alzn-93mey/` are validation systems. Each
  is a Landolt-Börnstein dataset based on a published assessment: Feufel et al.
  (*J. Alloys Compd.* **247**, 31–42, 1997), Boa and Ansara (*Thermochim.
  Acta* **314**, 79–86, 1998), and an Mey (*Z. Metallkd.* **84**, 451–55,
  1993). Bi–Pb and Al–Zn have no experimental data, because no tabulated
  experimental set was available for them.
- `alsi-97feu/data/alsi-murray1984.csv` holds 101 measured points from the
  tables of Murray and McAlister (*Bull. Alloy Phase Diagrams* **5**, 74–84,
  1984): the liquidus (Table 2), the (Al) solvus (Table 3), and the (Al)
  solidus (Table 4). They come from 17 studies published between 1926 and
  1976 and are identified by that paper's keys. The eutectic arrests are
  omitted for the same reason as in Ag–Cu.
- `cuni-92mey/`, `crni-16tan/`, `cupb-86hay/`, and `feni-03dup/` show types of
  phase diagram that the other examples do not. Their databases are
  byte-identical copies of the files in the collection, so the `$` header of
  each carries its citation: an Mey (*Calphad* **16**, 255–60, 1992), Tang and
  Hallstedt (*Calphad* **55**, 260–69, 2016), Hayes, Lukas, Effenberg, and
  Petzow (*Z. Metallkd.* **77**, 749–54, 1986), and Dupin and Sundman (2003).
- `crni-16tan/data/crni-tang2016-pop.csv` holds the measured phase boundaries
  from the PARROT `.POP` file published with Tang and Hallstedt (2016), read
  by `pop.js` and written out as CSV, together with the eutectic and the CrNi2
  reaction from blocks that `pop.js` does not read. The `source` column keeps
  the study keys of the POP file, and the file header explains what was
  omitted.
- `feni-03dup/data/feni-hellawell1957-chabot2017.csv` holds the liquidus,
  solidus, and δ/γ arrests in the Fe corner from Hellawell and Hume-Rothery
  (1957), as transcribed in PhasesResearchLab/ESPEI-datasets (CC BY 4.0), and
  three solid–liquid tie-lines at 1500 °C from Chabot et al. (2017). The phase
  names are those of FeNi-03Dup (`A1_FCC`), and the file header explains why
  the six δ/γ arrests have no phase.

Of the nine examples in the dropdown, Ag–Cu, Al–Si, Cr–Ni, and Fe–Ni include
measured data. The Cr–Ni points are the data to which that assessment was
fitted (hence the small misfit). The Ag–Cu liquidus studies and all of the
Al–Si studies predate their assessments, which may have been fitted to some of
them. Bienzle et al. (1992) postdates the Ag–Cu assessment and Chabot et al.
(2017) the Fe–Ni assessment, so neither assessment was fitted to those data.

## Purpose of the examples

Every database in the collection can be opened from the **Systems** tab, and
**Compare with** offers the other assessments of the loaded system. The
examples are representative systems that illustrate different types of
phase diagrams. They show a simple eutectic; complete solid solubility
without an invariant reaction; a line compound formed by a peritectoid
reaction; a line compound that melts congruently; a degenerate eutectic;
a eutectic and a peritectic with an intermediate phase of wide homogeneity
range; a solid miscibility gap that ends in a monotectoid; a miscibility
gap in the liquid; and a system whose diagram is shaped by magnetism.
