/*
 * tests.js — unit tests for the comparison engine in core.js.
 * Runs in the browser (see tests.html). Zero dependencies.
 *
 * A tiny test harness collects results into window.__TEST_RESULTS__ so the run
 * can be inspected headlessly (e.g., from an automation harness) as well as
 * visually.
 */
(function () {
  "use strict";

  var results = { passed: 0, failed: 0, total: 0, failures: [], cases: [] };

  function record(name, ok, message) {
    results.total++;
    if (ok) results.passed++;
    else {
      results.failed++;
      results.failures.push({ name: name, message: message });
    }
    results.cases.push({ name: name, ok: ok, message: ok ? "" : message });
  }

  function test(name, fn) {
    try {
      fn();
      record(name, true, "");
    } catch (e) {
      record(name, false, e && e.message ? e.message : String(e));
    }
  }

  function eq(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg || "assertEqual") + ": expected " + JSON.stringify(expected) + " but got " + JSON.stringify(actual));
    }
  }
  function ok(cond, msg) {
    if (!cond) throw new Error(msg || "expected truthy value");
  }
  function deepEq(actual, expected, msg) {
    var a = JSON.stringify(actual);
    var b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error((msg || "assertDeepEqual") + ": expected " + b + " but got " + a);
    }
  }

  var C = window.CDC;

  // ==========================================================================
  // CSV parsing
  // ==========================================================================

  test("parseCSV: basic header + rows", function () {
    var r = C.parseCSV("a,b,c\n1,2,3\n4,5,6");
    deepEq(r.headers, ["a", "b", "c"]);
    eq(r.records.length, 2);
    eq(r.records[0].a, "1");
    eq(r.records[1].c, "6");
  });

  test("parseCSV: quoted field with embedded comma", function () {
    var r = C.parseCSV('a,b\n"hello, world",x');
    eq(r.records[0].a, "hello, world");
    eq(r.records[0].b, "x");
  });

  test("parseCSV: escaped double quotes", function () {
    var r = C.parseCSV('a\n"she said ""hi"""');
    eq(r.records[0].a, 'she said "hi"');
  });

  test("parseCSV: embedded newline inside quotes", function () {
    var r = C.parseCSV('a,b\n"line1\nline2",z');
    eq(r.records[0].a, "line1\nline2");
    eq(r.records[0].b, "z");
    eq(r.records.length, 1);
  });

  test("parseCSV: CRLF line endings", function () {
    var r = C.parseCSV("a,b\r\n1,2\r\n3,4\r\n");
    eq(r.records.length, 2);
    eq(r.records[1].a, "3");
  });

  test("parseCSV: strips BOM", function () {
    var r = C.parseCSV("﻿a,b\n1,2");
    deepEq(r.headers, ["a", "b"]);
  });

  test("parseCSV: skips blank lines", function () {
    var r = C.parseCSV("a,b\n1,2\n\n3,4\n");
    eq(r.records.length, 2);
  });

  test("parseCSV: no trailing newline", function () {
    var r = C.parseCSV("a\n1");
    eq(r.records.length, 1);
    eq(r.records[0].a, "1");
  });

  test("parseCSV: de-duplicates repeated headers", function () {
    var r = C.parseCSV("a,a,b\n1,2,3");
    deepEq(r.headers, ["a", "a.1", "b"]);
    eq(r.records[0]["a.1"], "2");
  });

  test("detectDelimiter: tab", function () {
    eq(C.detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  });

  test("detectDelimiter: semicolon", function () {
    eq(C.detectDelimiter("a;b;c\n1;2;3"), ";");
  });

  test("parseCSV: auto-detect semicolon delimiter", function () {
    var r = C.parseCSV("a;b\n1;2");
    deepEq(r.headers, ["a", "b"]);
    eq(r.records[0].b, "2");
  });

  // ==========================================================================
  // Value classification
  // ==========================================================================

  test("classifyChange: unchanged", function () {
    deepEq(C.classifyChange("5", "5", {}), { changed: false, type: null });
  });

  test("classifyChange: modified", function () {
    var r = C.classifyChange("5", "6", {});
    eq(r.changed, true);
    eq(r.type, "modified");
  });

  test("classifyChange: added (missing -> value)", function () {
    var r = C.classifyChange("", "6", {});
    eq(r.changed, true);
    eq(r.type, "added");
  });

  test("classifyChange: removed (value -> missing)", function () {
    var r = C.classifyChange("6", "", {});
    eq(r.changed, true);
    eq(r.type, "removed");
  });

  test("classifyChange: both missing = unchanged", function () {
    deepEq(C.classifyChange("", "", {}), { changed: false, type: null });
  });

  test("classifyChange: whitespace ignored by default option", function () {
    var r = C.classifyChange("5 ", "5", { ignoreWhitespace: true });
    eq(r.changed, false);
  });

  test("classifyChange: whitespace matters when option off", function () {
    var r = C.classifyChange("5 ", "5", { ignoreWhitespace: false });
    eq(r.changed, true);
  });

  test("classifyChange: case-insensitive option", function () {
    var r = C.classifyChange("Male", "male", { ignoreCase: true });
    eq(r.changed, false);
  });

  test("classifyChange: numericEqual treats 1.0 == 1", function () {
    var r = C.classifyChange("1.0", "1", { numericEqual: true });
    eq(r.changed, false);
  });

  test("classifyChange: numericEqual off keeps 1.0 != 1", function () {
    var r = C.classifyChange("1.0", "1", { numericEqual: false });
    eq(r.changed, true);
  });

  test("classifyChange: extraMissingTokens treats NA as missing", function () {
    var r = C.classifyChange("NA", "", { extraMissingTokens: true });
    eq(r.changed, false);
    var r2 = C.classifyChange("NA", "5", { extraMissingTokens: true });
    eq(r2.type, "added");
  });

  test("numericDelta: computes difference", function () {
    eq(C.numericDelta("5", "8"), 3);
    eq(C.numericDelta("8", "5"), -3);
  });

  test("numericDelta: non-numeric -> null", function () {
    eq(C.numericDelta("high", "low"), null);
  });

  // ==========================================================================
  // Auto-detection
  // ==========================================================================

  test("autoDetectKeys: SDTM lab keys", function () {
    var keys = C.autoDetectKeys(["STUDYID", "DOMAIN", "USUBJID", "LBSEQ", "LBTEST", "LBORRES"]);
    deepEq(keys, ["STUDYID", "DOMAIN", "USUBJID", "LBSEQ"]);
  });

  test("autoDetectKeys: fallback to first column", function () {
    var keys = C.autoDetectKeys(["id", "name", "value"]);
    deepEq(keys, ["id"]);
  });

  test("autoDetectLabels: finds *TEST", function () {
    var labels = C.autoDetectLabels(["STUDYID", "LBSEQ", "LBTEST", "LBORRES"], ["STUDYID", "LBSEQ"]);
    ok(labels.indexOf("LBTEST") !== -1);
  });

  test("autoDetectSubject: USUBJID", function () {
    eq(C.autoDetectSubject(["STUDYID", "USUBJID", "AGE"]), "USUBJID");
  });

  // ==========================================================================
  // inferKeyColumns — standard-agnostic key discovery
  // ==========================================================================

  function ds2(headers, records) {
    return { headers: headers, records: records };
  }

  test("inferKeyColumns: picks a single unique id column", function () {
    var prev = ds2(["id", "name", "score"], [
      { id: "1", name: "Ann", score: "10" },
      { id: "2", name: "Bob", score: "20" },
      { id: "3", name: "Cy", score: "30" },
    ]);
    var curr = ds2(["id", "name", "score"], [
      { id: "1", name: "Ann", score: "11" },
      { id: "2", name: "Bob", score: "20" },
      { id: "4", name: "Di", score: "40" },
    ]);
    var r = C.inferKeyColumns(prev, curr);
    deepEq(r.keyColumns, ["id"]);
    ok(r.unique, "id should be a unique key");
  });

  test("inferKeyColumns: composites two columns when neither is unique alone", function () {
    var prev = ds2(["grp", "seq", "val"], [
      { grp: "A", seq: "1", val: "x" },
      { grp: "A", seq: "2", val: "y" },
      { grp: "B", seq: "1", val: "z" },
    ]);
    var curr = ds2(["grp", "seq", "val"], [
      { grp: "A", seq: "1", val: "x2" },
      { grp: "A", seq: "2", val: "y" },
      { grp: "B", seq: "1", val: "z" },
    ]);
    var r = C.inferKeyColumns(prev, curr);
    ok(r.unique, "grp+seq should be unique");
    ok(r.keyColumns.indexOf("grp") !== -1 && r.keyColumns.indexOf("seq") !== -1, "should include grp and seq");
    ok(r.keyColumns.indexOf("val") === -1, "should not pick the changing value column");
  });

  test("inferKeyColumns: prefers stable identifier over a unique but changing value", function () {
    // 'reading' is unique in each file but changes between files (low overlap);
    // 'sensor' is a stable identifier shared across files.
    var prev = ds2(["sensor", "reading"], [
      { sensor: "S1", reading: "100" },
      { sensor: "S2", reading: "200" },
      { sensor: "S3", reading: "300" },
    ]);
    var curr = ds2(["sensor", "reading"], [
      { sensor: "S1", reading: "101" },
      { sensor: "S2", reading: "202" },
      { sensor: "S3", reading: "303" },
    ]);
    var r = C.inferKeyColumns(prev, curr);
    deepEq(r.keyColumns, ["sensor"]);
  });

  test("inferKeyColumns: reports collisions when data has a true duplicate", function () {
    var prev = ds2(["id", "v"], [
      { id: "1", v: "a" },
      { id: "1", v: "a" },
      { id: "2", v: "b" },
    ]);
    var curr = ds2(["id", "v"], [
      { id: "1", v: "a" },
      { id: "2", v: "b" },
    ]);
    var r = C.inferKeyColumns(prev, curr);
    deepEq(r.keyColumns, ["id"]);
    eq(r.unique, false);
    eq(r.collisions, 1);
  });

  test("inferKeyColumns: no shared columns is reported", function () {
    var prev = ds2(["a"], [{ a: "1" }]);
    var curr = ds2(["b"], [{ b: "1" }]);
    var r = C.inferKeyColumns(prev, curr);
    deepEq(r.keyColumns, []);
    eq(r.unique, false);
  });

  test("inferKeyColumns: works on SDTM-style data", function () {
    var prev = ds2(["STUDYID", "USUBJID", "LBSEQ", "LBORRES"], [
      { STUDYID: "S", USUBJID: "P1", LBSEQ: "1", LBORRES: "5" },
      { STUDYID: "S", USUBJID: "P1", LBSEQ: "2", LBORRES: "6" },
      { STUDYID: "S", USUBJID: "P2", LBSEQ: "1", LBORRES: "7" },
    ]);
    var curr = ds2(["STUDYID", "USUBJID", "LBSEQ", "LBORRES"], [
      { STUDYID: "S", USUBJID: "P1", LBSEQ: "1", LBORRES: "50" },
      { STUDYID: "S", USUBJID: "P1", LBSEQ: "2", LBORRES: "6" },
      { STUDYID: "S", USUBJID: "P2", LBSEQ: "1", LBORRES: "7" },
    ]);
    var r = C.inferKeyColumns(prev, curr);
    ok(r.unique, "inferred key should be unique");
    ok(r.keyColumns.indexOf("LBORRES") === -1, "should not use the result value as a key");
  });

  // ==========================================================================
  // compareDatasets — the heart of the tool
  // ==========================================================================

  function ds(headers, records) {
    return { headers: headers, records: records };
  }

  test("compareDatasets: detects added, removed, changed", function () {
    var prev = ds(
      ["ID", "VAL"],
      [
        { ID: "1", VAL: "10" },
        { ID: "2", VAL: "20" },
        { ID: "3", VAL: "30" },
      ]
    );
    var curr = ds(
      ["ID", "VAL"],
      [
        { ID: "1", VAL: "10" }, // unchanged
        { ID: "2", VAL: "25" }, // changed
        { ID: "4", VAL: "40" }, // added
      ]
      // ID 3 removed
    );
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.counts.addedRecords, 1);
    eq(res.counts.removedRecords, 1);
    eq(res.counts.changedRecords, 1);
    eq(res.counts.unchangedRecords, 1);
    eq(res.counts.changedCells, 1);
    eq(res.addedRecords[0].ID, "4");
    eq(res.removedRecords[0].ID, "3");
    eq(res.changedRecords[0].changes[0].previous, "20");
    eq(res.changedRecords[0].changes[0].current, "25");
    eq(res.changedRecords[0].changes[0].changeType, "modified");
  });

  test("compareDatasets: flags missing->populated (the R na.rm improvement)", function () {
    var prev = ds(["ID", "VAL"], [{ ID: "1", VAL: "" }]);
    var curr = ds(["ID", "VAL"], [{ ID: "1", VAL: "99" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.counts.changedRecords, 1);
    eq(res.cellChanges[0].CHANGE_TYPE, "added");
    eq(res.cellChanges[0].CURRENT_VALUE, "99");
  });

  test("compareDatasets: flags populated->missing", function () {
    var prev = ds(["ID", "VAL"], [{ ID: "1", VAL: "77" }]);
    var curr = ds(["ID", "VAL"], [{ ID: "1", VAL: "" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.cellChanges[0].CHANGE_TYPE, "removed");
  });

  test("compareDatasets: composite key", function () {
    var prev = ds(
      ["STUDYID", "USUBJID", "LBSEQ", "LBORRES"],
      [{ STUDYID: "S1", USUBJID: "P1", LBSEQ: "1", LBORRES: "5.0" }]
    );
    var curr = ds(
      ["STUDYID", "USUBJID", "LBSEQ", "LBORRES"],
      [{ STUDYID: "S1", USUBJID: "P1", LBSEQ: "1", LBORRES: "6.0" }]
    );
    var res = C.compareDatasets(prev, curr, { keyColumns: ["STUDYID", "USUBJID", "LBSEQ"] });
    eq(res.counts.changedRecords, 1);
    eq(res.cellChanges[0].VARIABLE, "LBORRES");
  });

  test("compareDatasets: numeric delta on modified numeric cell", function () {
    var prev = ds(["ID", "GLUC"], [{ ID: "1", GLUC: "90" }]);
    var curr = ds(["ID", "GLUC"], [{ ID: "1", GLUC: "110" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.cellChanges[0].NUMERIC_DELTA, 20);
  });

  test("compareDatasets: schema diff (added/removed columns)", function () {
    var prev = ds(["ID", "OLD"], [{ ID: "1", OLD: "x" }]);
    var curr = ds(["ID", "NEW"], [{ ID: "1", NEW: "y" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    deepEq(res.schema.addedColumns, ["NEW"]);
    deepEq(res.schema.removedColumns, ["OLD"]);
    deepEq(res.schema.commonColumns, ["ID"]);
    // No comparable non-key columns => no cell changes.
    eq(res.counts.changedCells, 0);
  });

  test("compareDatasets: duplicate keys reported", function () {
    var prev = ds(
      ["ID", "VAL"],
      [
        { ID: "1", VAL: "a" },
        { ID: "1", VAL: "b" },
      ]
    );
    var curr = ds(["ID", "VAL"], [{ ID: "1", VAL: "a" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.keyIssues.duplicatePreviousKeys.length, 1);
    eq(res.keyIssues.duplicatePreviousKeys[0].count, 2);
  });

  test("compareDatasets: variable summary tallies", function () {
    var prev = ds(
      ["ID", "A", "B"],
      [
        { ID: "1", A: "1", B: "x" },
        { ID: "2", A: "2", B: "y" },
      ]
    );
    var curr = ds(
      ["ID", "A", "B"],
      [
        { ID: "1", A: "9", B: "x" }, // A changed
        { ID: "2", A: "8", B: "y" }, // A changed
      ]
    );
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    eq(res.variableSummary.length, 1);
    eq(res.variableSummary[0].column, "A");
    eq(res.variableSummary[0].changed, 2);
  });

  test("compareDatasets: subject summary rollup", function () {
    var prev = ds(
      ["USUBJID", "LBSEQ", "LBORRES"],
      [
        { USUBJID: "P1", LBSEQ: "1", LBORRES: "5" },
        { USUBJID: "P1", LBSEQ: "2", LBORRES: "6" },
        { USUBJID: "P2", LBSEQ: "1", LBORRES: "7" },
      ]
    );
    var curr = ds(
      ["USUBJID", "LBSEQ", "LBORRES"],
      [
        { USUBJID: "P1", LBSEQ: "1", LBORRES: "50" }, // changed
        { USUBJID: "P1", LBSEQ: "2", LBORRES: "60" }, // changed
        { USUBJID: "P2", LBSEQ: "1", LBORRES: "7" }, // unchanged
      ]
    );
    var res = C.compareDatasets(prev, curr, {
      keyColumns: ["USUBJID", "LBSEQ"],
      subjectColumn: "USUBJID",
    });
    eq(res.subjectSummary[0].subject, "P1");
    eq(res.subjectSummary[0].changed, 2);
  });

  test("compareDatasets: label column carried into cell changes", function () {
    var prev = ds(
      ["ID", "LBTEST", "LBORRES"],
      [{ ID: "1", LBTEST: "Glucose", LBORRES: "90" }]
    );
    var curr = ds(
      ["ID", "LBTEST", "LBORRES"],
      [{ ID: "1", LBTEST: "Glucose", LBORRES: "110" }]
    );
    var res = C.compareDatasets(prev, curr, {
      keyColumns: ["ID"],
      labelColumns: ["LBTEST"],
    });
    eq(res.cellChanges[0].LBTEST, "Glucose");
  });

  test("compareDatasets: missing key column throws", function () {
    var prev = ds(["ID"], [{ ID: "1" }]);
    var curr = ds(["OTHER"], [{ OTHER: "1" }]);
    var threw = false;
    try {
      C.compareDatasets(prev, curr, { keyColumns: ["ID"] });
    } catch (e) {
      threw = true;
    }
    ok(threw, "expected an error when key column absent from current");
  });

  test("compareDatasets: only compares selected compareColumns", function () {
    var prev = ds(["ID", "A", "B"], [{ ID: "1", A: "1", B: "1" }]);
    var curr = ds(["ID", "A", "B"], [{ ID: "1", A: "2", B: "2" }]);
    var res = C.compareDatasets(prev, curr, { keyColumns: ["ID"], compareColumns: ["A"] });
    eq(res.counts.changedCells, 1);
    eq(res.cellChanges[0].VARIABLE, "A");
  });

  // ==========================================================================
  // CSV export / injection defense
  // ==========================================================================

  test("sanitizeForCSV: neutralizes formula-trigger cells", function () {
    eq(C.sanitizeForCSV("=SUM(A1)"), "'=SUM(A1)");
    eq(C.sanitizeForCSV("+1"), "'+1");
    eq(C.sanitizeForCSV("-1"), "'-1");
    eq(C.sanitizeForCSV("@cmd"), "'@cmd");
    eq(C.sanitizeForCSV("safe"), "safe");
  });

  test("toCSV: quotes fields with commas and quotes", function () {
    var csv = C.toCSV([{ a: "x,y", b: 'he said "hi"' }], ["a", "b"]);
    ok(csv.indexOf('"x,y"') !== -1);
    ok(csv.indexOf('"he said ""hi"""') !== -1);
  });

  test("toCSV: round-trips through parseCSV", function () {
    var rows = [
      { ID: "1", VAL: "hello, world" },
      { ID: "2", VAL: 'quote " here' },
    ];
    var csv = C.toCSV(rows, ["ID", "VAL"]);
    var back = C.parseCSV(csv);
    eq(back.records[0].VAL, "hello, world");
    eq(back.records[1].VAL, 'quote " here');
  });

  // ==========================================================================
  // Finish
  // ==========================================================================

  window.__TEST_RESULTS__ = results;
  if (typeof window.__renderTestResults === "function") {
    window.__renderTestResults(results);
  }
})();
