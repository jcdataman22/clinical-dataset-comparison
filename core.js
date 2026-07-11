/*
 * core.js — Clinical Data Set Comparison engine (dependency-free)
 *
 * Pure comparison logic with NO DOM and NO network access, so it can be unit
 * tested in isolation (see tests.html) and reused by the UI (app.js).
 *
 * Exposes a single global `CDC` in the browser and, if a CommonJS-like
 * environment is ever present, on module.exports.
 *
 * Design goals: correctness, transparency, and never sending data anywhere.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // Standard SDTM identifier variables used to auto-suggest record keys.
  var SDTM_IDENTIFIERS = ["STUDYID", "DOMAIN", "USUBJID", "SUBJID"];

  // Tokens that clinical transfers commonly use to represent "missing".
  var EXTRA_MISSING_TOKENS = ["NA", "N/A", "NULL", "."];

  // Characters that make a spreadsheet interpret a cell as a formula. Cells
  // beginning with these are neutralized on CSV export (CSV-injection defense).
  var FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

  var KEY_SEP = ""; // separator unlikely to appear in real data

  // ---------------------------------------------------------------------------
  // CSV parsing (RFC 4180-ish: quotes, embedded delimiters/newlines, "" escape)
  // ---------------------------------------------------------------------------

  function detectDelimiter(text) {
    // Look at the first physical line only (approximation; good enough for a
    // header row, which should not contain embedded newlines).
    var firstLine = "";
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === "\n" || c === "\r") break;
      firstLine += c;
    }
    var candidates = [",", "\t", ";", "|"];
    var best = ",";
    var bestCount = -1;
    for (var j = 0; j < candidates.length; j++) {
      var d = candidates[j];
      var count = firstLine.split(d).length - 1;
      if (count > bestCount) {
        bestCount = count;
        best = d;
      }
    }
    return best;
  }

  function parseCSV(text, options) {
    options = options || {};
    var result = { delimiter: options.delimiter || ",", headers: [], records: [] };
    if (text == null || text === "") return result;

    // Strip UTF-8 BOM.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    var delimiter = options.delimiter || detectDelimiter(text);
    result.delimiter = delimiter;

    var rows = [];
    var field = "";
    var row = [];
    var inQuotes = false;
    var started = false; // has the current row seen any character at all?
    var i = 0;
    var n = text.length;

    while (i < n) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        started = true;
        i++;
        continue;
      }
      if (ch === delimiter) {
        row.push(field);
        field = "";
        started = true;
        i++;
        continue;
      }
      if (ch === "\r") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        started = false;
        i += text[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        started = false;
        i++;
        continue;
      }
      field += ch;
      started = true;
      i++;
    }

    // Flush trailing field/row (a file that does not end in a newline).
    if (started || field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    // Drop fully-blank lines (a single empty field).
    rows = rows.filter(function (r) {
      return !(r.length === 1 && r[0] === "");
    });

    if (rows.length === 0) return result;

    // De-duplicate header names so downstream object keys stay unambiguous.
    var rawHeaders = rows[0];
    var seen = {};
    var headers = rawHeaders.map(function (h) {
      var name = h === "" ? "column" : h;
      if (Object.prototype.hasOwnProperty.call(seen, name)) {
        seen[name] += 1;
        return name + "." + seen[name];
      }
      seen[name] = 0;
      return name;
    });

    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      var obj = {};
      for (var k = 0; k < headers.length; k++) {
        obj[headers[k]] = cells[k] !== undefined ? cells[k] : "";
      }
      records.push(obj);
    }

    result.headers = headers;
    result.records = records;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Value comparison
  // ---------------------------------------------------------------------------

  function normalize(v, opts) {
    var s = v == null ? "" : String(v);
    if (opts && opts.ignoreWhitespace) s = s.trim();
    return s;
  }

  function isMissing(normalized, opts) {
    if (normalized === "") return true;
    if (opts && opts.extraMissingTokens) {
      var upper = normalized.toUpperCase();
      for (var i = 0; i < EXTRA_MISSING_TOKENS.length; i++) {
        if (upper === EXTRA_MISSING_TOKENS[i].toUpperCase()) return true;
      }
    }
    return false;
  }

  function toNumber(s) {
    var t = (s == null ? "" : String(s)).trim();
    if (t === "") return NaN;
    return Number(t);
  }

  function valuesEqual(a, b, opts) {
    var x = a;
    var y = b;
    if (opts && opts.ignoreCase) {
      x = x.toLowerCase();
      y = y.toLowerCase();
    }
    if (x === y) return true;
    if (opts && opts.numericEqual) {
      var nx = toNumber(x);
      var ny = toNumber(y);
      if (isFinite(nx) && isFinite(ny) && nx === ny) return true;
    }
    return false;
  }

  /**
   * Classify how a single cell changed between previous and current.
   * Returns { changed, type }, where type is one of:
   *   "added"    — was missing, now populated
   *   "removed"  — was populated, now missing
   *   "modified" — populated in both, values differ
   * (When !changed, type is null.)
   *
   * NOTE: This intentionally flags missing<->populated transitions, which the
   * original R implementation dropped via na.rm=TRUE.
   */
  function classifyChange(prevRaw, currRaw, opts) {
    opts = opts || {};
    var p = normalize(prevRaw, opts);
    var c = normalize(currRaw, opts);
    var pMissing = isMissing(p, opts);
    var cMissing = isMissing(c, opts);

    if (pMissing && cMissing) return { changed: false, type: null };
    if (pMissing && !cMissing) return { changed: true, type: "added" };
    if (!pMissing && cMissing) return { changed: true, type: "removed" };
    if (valuesEqual(p, c, opts)) return { changed: false, type: null };
    return { changed: true, type: "modified" };
  }

  function numericDelta(prevRaw, currRaw) {
    var np = toNumber(String(prevRaw == null ? "" : prevRaw));
    var nc = toNumber(String(currRaw == null ? "" : currRaw));
    if (isFinite(np) && isFinite(nc)) {
      // Round away binary floating-point noise (e.g., 1.5 - 1.8) without
      // losing meaningful precision.
      return Math.round((nc - np) * 1e10) / 1e10;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Key helpers
  // ---------------------------------------------------------------------------

  function makeKey(record, keyColumns) {
    var parts = [];
    for (var i = 0; i < keyColumns.length; i++) {
      var v = record[keyColumns[i]];
      parts.push(v == null ? "" : String(v));
    }
    return parts.join(KEY_SEP);
  }

  function keyValuesObject(record, keyColumns) {
    var obj = {};
    for (var i = 0; i < keyColumns.length; i++) {
      obj[keyColumns[i]] = record[keyColumns[i]] != null ? record[keyColumns[i]] : "";
    }
    return obj;
  }

  /**
   * Build a Map key -> first record, and report duplicate keys.
   */
  function indexByKey(records, keyColumns) {
    var map = new Map();
    var counts = new Map();
    for (var i = 0; i < records.length; i++) {
      var key = makeKey(records[i], keyColumns);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!map.has(key)) map.set(key, records[i]);
    }
    var duplicates = [];
    counts.forEach(function (count, key) {
      if (count > 1) {
        duplicates.push({ key: key, count: count, record: map.get(key) });
      }
    });
    return { map: map, counts: counts, duplicates: duplicates };
  }

  // ---------------------------------------------------------------------------
  // Auto-detection helpers
  // ---------------------------------------------------------------------------

  function autoDetectKeys(headers) {
    var set = {};
    headers.forEach(function (h) {
      set[h.toUpperCase()] = h;
    });
    var keys = [];
    SDTM_IDENTIFIERS.forEach(function (id) {
      if (set[id]) keys.push(set[id]);
    });
    // Add the first *SEQ column (e.g., LBSEQ, VSSEQ) — the SDTM sequence key.
    for (var i = 0; i < headers.length; i++) {
      if (/SEQ$/i.test(headers[i]) && keys.indexOf(headers[i]) === -1) {
        keys.push(headers[i]);
        break;
      }
    }
    // Fallback: if nothing SDTM-ish was found, use the first column.
    if (keys.length === 0 && headers.length > 0) keys.push(headers[0]);
    return keys;
  }

  function autoDetectLabels(headers, keyColumns) {
    var labels = [];
    headers.forEach(function (h) {
      if (keyColumns.indexOf(h) !== -1) return;
      if (/TEST$/i.test(h) || /^VISIT$/i.test(h) || /TESTCD$/i.test(h)) {
        labels.push(h);
      }
    });
    return labels;
  }

  function autoDetectSubject(headers) {
    for (var i = 0; i < headers.length; i++) {
      if (/^USUBJID$/i.test(headers[i])) return headers[i];
    }
    for (var j = 0; j < headers.length; j++) {
      if (/^SUBJID$/i.test(headers[j])) return headers[j];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Main comparison
  // ---------------------------------------------------------------------------

  function defaultConfig() {
    return {
      keyColumns: [],
      compareColumns: null, // null => all common non-key columns
      labelColumns: [],
      subjectColumn: null,
      ignoreWhitespace: true,
      ignoreCase: false,
      numericEqual: false,
      extraMissingTokens: false,
    };
  }

  function intersect(a, b) {
    var setB = {};
    b.forEach(function (x) {
      setB[x] = true;
    });
    return a.filter(function (x) {
      return setB[x];
    });
  }

  function difference(a, b) {
    var setB = {};
    b.forEach(function (x) {
      setB[x] = true;
    });
    return a.filter(function (x) {
      return !setB[x];
    });
  }

  /**
   * Compare two parsed datasets.
   *
   * @param {{headers:string[],records:object[]}} previous
   * @param {{headers:string[],records:object[]}} current
   * @param {object} config
   * @returns {object} rich result (see README / tests for shape)
   */
  function compareDatasets(previous, current, config) {
    config = Object.assign(defaultConfig(), config || {});
    var opts = {
      ignoreWhitespace: config.ignoreWhitespace,
      ignoreCase: config.ignoreCase,
      numericEqual: config.numericEqual,
      extraMissingTokens: config.extraMissingTokens,
    };

    var prevHeaders = previous.headers || [];
    var currHeaders = current.headers || [];
    var keyColumns = config.keyColumns || [];

    if (keyColumns.length === 0) {
      throw new Error("At least one key column is required to compare records.");
    }

    // Validate keys exist in both datasets.
    var missingKeys = { previous: [], current: [] };
    keyColumns.forEach(function (k) {
      if (prevHeaders.indexOf(k) === -1) missingKeys.previous.push(k);
      if (currHeaders.indexOf(k) === -1) missingKeys.current.push(k);
    });
    if (missingKeys.previous.length || missingKeys.current.length) {
      var msg = "Key column(s) not present in both files: ";
      var parts = [];
      if (missingKeys.previous.length)
        parts.push("missing from previous [" + missingKeys.previous.join(", ") + "]");
      if (missingKeys.current.length)
        parts.push("missing from current [" + missingKeys.current.join(", ") + "]");
      throw new Error(msg + parts.join("; "));
    }

    // Schema diff.
    var commonColumns = intersect(currHeaders, prevHeaders);
    var addedColumns = difference(currHeaders, prevHeaders); // in current only
    var removedColumns = difference(prevHeaders, currHeaders); // in previous only

    // Resolve which columns to compare cell-by-cell.
    var candidateCompare = difference(commonColumns, keyColumns);
    var compareColumns;
    if (config.compareColumns && config.compareColumns.length) {
      compareColumns = intersect(config.compareColumns, candidateCompare);
    } else {
      compareColumns = candidateCompare;
    }

    var labelColumns = (config.labelColumns || []).filter(function (c) {
      return commonColumns.indexOf(c) !== -1;
    });

    // Index by key.
    var prevIndex = indexByKey(previous.records || [], keyColumns);
    var currIndex = indexByKey(current.records || [], keyColumns);

    // Added / removed records (by unique key).
    var addedRecords = [];
    currIndex.map.forEach(function (rec, key) {
      if (!prevIndex.map.has(key)) addedRecords.push(rec);
    });
    var removedRecords = [];
    prevIndex.map.forEach(function (rec, key) {
      if (!currIndex.map.has(key)) removedRecords.push(rec);
    });

    // Changed records + cell-level changes.
    var changedRecords = [];
    var cellChanges = [];
    var matchedKeyCount = 0;

    // Per-variable tallies.
    var variableTally = {};
    compareColumns.forEach(function (col) {
      variableTally[col] = { column: col, added: 0, removed: 0, modified: 0, changed: 0 };
    });

    prevIndex.map.forEach(function (prevRec, key) {
      if (!currIndex.map.has(key)) return;
      matchedKeyCount++;
      var currRec = currIndex.map.get(key);
      var changes = [];
      for (var ci = 0; ci < compareColumns.length; ci++) {
        var col = compareColumns[ci];
        var cls = classifyChange(prevRec[col], currRec[col], opts);
        if (!cls.changed) continue;
        var delta = cls.type === "modified" ? numericDelta(prevRec[col], currRec[col]) : null;
        changes.push({
          column: col,
          previous: prevRec[col] != null ? prevRec[col] : "",
          current: currRec[col] != null ? currRec[col] : "",
          changeType: cls.type,
          numericDelta: delta,
        });
        variableTally[col][cls.type]++;
        variableTally[col].changed++;
      }
      if (changes.length > 0) {
        var keyVals = keyValuesObject(currRec, keyColumns);
        var labelVals = {};
        labelColumns.forEach(function (lc) {
          labelVals[lc] = currRec[lc] != null ? currRec[lc] : "";
        });
        changedRecords.push({
          key: key,
          keyValues: keyVals,
          labelValues: labelVals,
          changes: changes,
        });
        for (var ch = 0; ch < changes.length; ch++) {
          var flat = {};
          keyColumns.forEach(function (kc) {
            flat[kc] = keyVals[kc];
          });
          labelColumns.forEach(function (lc) {
            flat[lc] = labelVals[lc];
          });
          flat.VARIABLE = changes[ch].column;
          flat.CHANGE_TYPE = changes[ch].changeType;
          flat.PREVIOUS_VALUE = changes[ch].previous;
          flat.CURRENT_VALUE = changes[ch].current;
          flat.NUMERIC_DELTA = changes[ch].numericDelta;
          cellChanges.push(flat);
        }
      }
    });

    var unchangedRecords = matchedKeyCount - changedRecords.length;

    var variableSummary = compareColumns
      .map(function (col) {
        return variableTally[col];
      })
      .filter(function (v) {
        return v.changed > 0;
      })
      .sort(function (a, b) {
        return b.changed - a.changed;
      });

    // Per-subject rollup.
    var subjectSummary = [];
    if (config.subjectColumn && commonColumns.indexOf(config.subjectColumn) !== -1) {
      var sc = config.subjectColumn;
      var bySubject = {};
      function bump(subject, field) {
        if (subject == null) subject = "";
        if (!bySubject[subject]) {
          bySubject[subject] = { subject: subject, added: 0, removed: 0, changed: 0 };
        }
        bySubject[subject][field]++;
      }
      addedRecords.forEach(function (r) {
        bump(r[sc], "added");
      });
      removedRecords.forEach(function (r) {
        bump(r[sc], "removed");
      });
      changedRecords.forEach(function (r) {
        var currRec = currIndex.map.get(r.key);
        bump(currRec ? currRec[sc] : "", "changed");
      });
      Object.keys(bySubject).forEach(function (s) {
        subjectSummary.push(bySubject[s]);
      });
      subjectSummary.sort(function (a, b) {
        var ta = a.added + a.removed + a.changed;
        var tb = b.added + b.removed + b.changed;
        return tb - ta;
      });
    }

    return {
      config: {
        keyColumns: keyColumns.slice(),
        compareColumns: compareColumns.slice(),
        labelColumns: labelColumns.slice(),
        subjectColumn: config.subjectColumn || null,
        options: opts,
      },
      schema: {
        commonColumns: commonColumns,
        addedColumns: addedColumns,
        removedColumns: removedColumns,
      },
      keyIssues: {
        duplicatePreviousKeys: prevIndex.duplicates,
        duplicateCurrentKeys: currIndex.duplicates,
      },
      counts: {
        previousRows: (previous.records || []).length,
        currentRows: (current.records || []).length,
        previousCols: prevHeaders.length,
        currentCols: currHeaders.length,
        matchedKeys: matchedKeyCount,
        addedRecords: addedRecords.length,
        removedRecords: removedRecords.length,
        changedRecords: changedRecords.length,
        unchangedRecords: unchangedRecords,
        changedCells: cellChanges.length,
      },
      addedRecords: addedRecords,
      removedRecords: removedRecords,
      changedRecords: changedRecords,
      cellChanges: cellChanges,
      variableSummary: variableSummary,
      subjectSummary: subjectSummary,
    };
  }

  // ---------------------------------------------------------------------------
  // CSV export (with CSV-injection defense)
  // ---------------------------------------------------------------------------

  function sanitizeForCSV(value) {
    var s = value == null ? "" : String(value);
    if (s.length > 0 && FORMULA_TRIGGERS.indexOf(s.charAt(0)) !== -1) {
      s = "'" + s;
    }
    return s;
  }

  function quoteField(value, delimiter) {
    var s = sanitizeForCSV(value);
    if (s.indexOf('"') !== -1 || s.indexOf(delimiter) !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Serialize an array of row-objects to CSV text.
   * @param {object[]} rows
   * @param {string[]} columns  explicit column order (defaults to keys of first row)
   */
  function toCSV(rows, columns, delimiter) {
    delimiter = delimiter || ",";
    rows = rows || [];
    if (!columns) {
      columns = rows.length ? Object.keys(rows[0]) : [];
    }
    var lines = [];
    lines.push(
      columns
        .map(function (c) {
          return quoteField(c, delimiter);
        })
        .join(delimiter)
    );
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      lines.push(
        columns
          .map(function (c) {
            return quoteField(row[c], delimiter);
          })
          .join(delimiter)
      );
    }
    return lines.join("\r\n");
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  var CDC = {
    // parsing
    parseCSV: parseCSV,
    detectDelimiter: detectDelimiter,
    // comparison primitives
    normalize: normalize,
    isMissing: isMissing,
    valuesEqual: valuesEqual,
    classifyChange: classifyChange,
    numericDelta: numericDelta,
    makeKey: makeKey,
    indexByKey: indexByKey,
    // detection
    autoDetectKeys: autoDetectKeys,
    autoDetectLabels: autoDetectLabels,
    autoDetectSubject: autoDetectSubject,
    // main
    defaultConfig: defaultConfig,
    compareDatasets: compareDatasets,
    // export
    sanitizeForCSV: sanitizeForCSV,
    toCSV: toCSV,
    // constants (exposed for tests/UI)
    SDTM_IDENTIFIERS: SDTM_IDENTIFIERS,
    EXTRA_MISSING_TOKENS: EXTRA_MISSING_TOKENS,
  };

  root.CDC = CDC;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = CDC;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
