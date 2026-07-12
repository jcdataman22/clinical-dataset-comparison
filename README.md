# Clinical Data Set Comparison

A small, secure, fully client-side web app that compares a **previous** and a
**current** clinical data transfer and reports exactly what was **added**,
**removed**, and **changed** — record by record and value by value.

It is an open reimplementation and extension of the R workflow described in
Jason Carlson's post *"Current and Previous Clinical Data Set Comparison"*
(<https://jcdataman.quarto.pub/current-and-previous-clinical-data-set-comparison/>).

---

## Why this version

| | Original R script | This web app |
|---|---|---|
| Runs in | R / RStudio | Any modern browser — nothing to install |
| Where data goes | Local R session | **Nowhere.** 100% in-browser; no upload, no network |
| Keys | Hard-coded `STUDYID, DOMAIN, USUBJID, LBSEQ` | Auto-detected **and** fully configurable |
| Context column | Hard-coded `LBTEST` | Any column(s) you choose |
| Missing → populated (`NA`→value) | **Missed** (dropped by `na.rm = TRUE`) | **Detected** and labeled *added* |
| Populated → missing (value→`NA`) | **Missed** | **Detected** and labeled *removed* |
| Column added/removed between transfers | Not reported | Reported as a schema-change notice |
| Duplicate keys | Silently corrupts the join | Detected and warned |
| Extra insight | — | Numeric deltas, per-variable change frequency, per-subject rollups |
| Performance | Row-by-row `map_lgl` loop | Hash-join, O(n) |
| Output | HTML datatables | Summary cards + filterable tabs + CSV export |
| Tests | — | 44 unit tests for the comparison engine |

### The accuracy fix, in detail

The original computes, per cell:

```r
is_modified <- (current != previous) & !(is.na(current) & is.na(previous))
any(is_modified, na.rm = TRUE)
```

When exactly one side is `NA`, `current != previous` evaluates to `NA`, so
`is_modified` is `NA`, and `any(..., na.rm = TRUE)` drops it. As a result a
value that appeared (`NA` → `5`) or disappeared (`5` → `NA`) between transfers
is **not flagged**. This app treats those as first-class changes
("value added" / "value removed"), which is usually exactly what a data manager
needs to see.

---

## Running it

Because the browser blocks `fetch()` of the bundled demo files from
`file://`, serve the folder over HTTP (any static server works):

```bash
cd clinical-dataset-comparison
python3 -m http.server 8722
# then open http://localhost:8722/index.html
```

To run the test suite, open `http://localhost:8722/tests.html` — it shows
`44 passed, 0 failed` and lists every case.

> You can also open `index.html` directly from disk and use the two file
> pickers; only the demo buttons require the local server.

---

## How to use

1. **Load the two transfers.** Drop or browse to your *previous* and *current*
   CSVs (or click **Load SDTM format demo** for clinical lab data, or
   **Load other format demo** for a non-SDTM inventory dataset where the app
   infers the composite key on its own).
2. **Choose how to match records.**
   - **Key columns** — the columns that uniquely identify one record. SDTM
     identifiers (`STUDYID`, `DOMAIN`, `USUBJID`, and the first `*SEQ` column)
     are pre-selected when present; for any other dataset the app infers the
     key by finding the smallest, most-unique combination of columns whose
     values are shared across both files (favoring stable identifiers over
     changing measurements). A short note explains the choice, and you can
     adjust the selection anytime.
   - **Context columns** — extra columns (e.g., `LBTEST`) shown alongside each
     change so a finding reads in plain language.
   - **Columns to compare** — which variables to diff (defaults to every
     shared, non-key column).
   - **Roll up by** — a subject column (defaults to `USUBJID`) for the
     per-subject summary.
   - **Options** — ignore whitespace / case, treat numerically-equal values as
     unchanged (`1.0` = `1`), and treat `NA / N/A / NULL / .` as missing.
3. **Compare.** Review the summary cards and drill into the tabs:
   - **Changed values** — one row per changed cell: keys, context, variable,
     change type, previous value, current value, and numeric Δ.
   - **Added records** / **Removed records** — full rows.
   - **By variable** — how often each variable changed.
   - **By subject** — added / removed / changed counts per subject.
   - Filter any tab and **Export this view (CSV)**.

---

## Deploying to GitHub Pages

This app is just static files, so it can be hosted as-is (no build step). Once
the repository is on GitHub, open **Settings → Pages**, set the source to the
`main` branch (root folder), and save. Your site publishes at
`https://<username>.github.io/<repo>/` within a minute or two. All paths are
relative, so it works correctly under that sub-path, and the demo CSVs
load over same-origin HTTPS. Uploaded files are still read locally in the
visitor's browser — publishing the app does not publish any data.

When you change `styles.css`, `core.js`, or `app.js`, bump the `?v=` number on
their `<link>` / `<script>` tags in `index.html`. Those version tags let a
browser cache the assets normally but fetch the new copy immediately after a
deploy, so visitors never end up on a stale mix of old and new files.

## Security & privacy

- **No network egress.** Files are read with the browser `FileReader`; nothing
  is ever uploaded. A strict Content-Security-Policy (`default-src 'none'`,
  `connect-src 'self'`) blocks any accidental exfiltration.
- **No third-party code.** No CDNs, frameworks, or trackers — just three small
  local files, so the whole thing is auditable in a few minutes.
- **XSS-safe rendering.** All cell values are written with `textContent`, never
  `innerHTML`, so hostile content in a CSV cannot execute.
- **CSV-injection defense.** On export, cells beginning with `= + - @` (or tab /
  CR) are prefixed with `'` so a spreadsheet won't execute them as formulas.

Suitability note: keeping potential PHI in the browser tab is the point of the
design, but you remain responsible for your organization's handling rules for
the files on your own machine.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell and layout |
| `styles.css` | Styling (light/dark aware) |
| `app.js` | UI: file loading, config, rendering, export |
| `core.js` | Dependency-free comparison engine (CSV parse + diff) |
| `tests.html` / `tests.js` | Browser-based unit tests (44 cases) |
| `demo_previous.csv` / `demo_current.csv` | Built-in SDTM lab demo |
| `demo_other_previous.csv` / `demo_other_current.csv` | Built-in non-SDTM inventory demo |

---

## What "changed" means (semantics)

For each matched record and each compared column, a cell is classified as:

- **added** — was missing/empty in previous, populated in current
- **removed** — was populated in previous, missing/empty in current
- **modified** — populated in both but the values differ

Empty string and absent are both treated as *missing*; two missing values are
equal (no change). Comparison honors the whitespace / case / numeric / missing
options you select.

---

*Provided as-is for clinical data management workflows. It shows **what**
changed and approximately **when** — determining **who** changed a value and
**why** still requires the source system's audit trail.*
