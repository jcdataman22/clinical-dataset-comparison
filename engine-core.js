/*
 * engine-core.js — orchestration shared by the main thread and the Web Worker.
 *
 * Depends on core.js (global CDC). It holds the parsed datasets and exposes
 * parse / analyze / compare. No DOM access, so the exact same code runs on the
 * main thread (fallback) and inside worker.js.
 */
(function (root) {
  "use strict";

  var C = root.CDC;

  function intersect(a, b) {
    var s = Object.create(null);
    b.forEach(function (x) {
      s[x] = true;
    });
    return a.filter(function (x) {
      return s[x];
    });
  }

  function EngineCore() {
    this.store = { prev: null, curr: null };
  }

  // Parse one file and keep it; return only lightweight metadata.
  EngineCore.prototype.parse = function (which, name, text) {
    var parsed = C.parseCSV(text);
    parsed.name = name;
    this.store[which] = parsed;
    return { headers: parsed.headers, rowCount: parsed.records.length, name: name };
  };

  // Suggest match configuration from the two parsed datasets.
  EngineCore.prototype.analyze = function () {
    var prev = this.store.prev;
    var curr = this.store.curr;
    var common = intersect(curr.headers, prev.headers);

    // SDTM identifiers are a fast path; otherwise infer keys by uniqueness.
    var sdtmKeys = C.autoDetectKeys(common);
    var looksSdtm = sdtmKeys.some(function (k) {
      return /^(STUDYID|DOMAIN|USUBJID|SUBJID)$/i.test(k) || /SEQ$/i.test(k);
    });
    var keys, keyHint;
    if (looksSdtm) {
      keys = sdtmKeys;
      keyHint = "Auto-selected from recognized SDTM identifier columns — adjust if needed.";
    } else {
      var inf = C.inferKeyColumns(prev, curr, { common: common });
      keys = inf.keyColumns;
      keyHint = "Auto-detected by uniqueness — " + inf.reason + " Adjust if needed.";
    }

    return {
      common: common,
      suggestedKeys: keys,
      keyHint: keyHint,
      labels: C.autoDetectLabels(common, keys),
      subject: C.autoDetectSubject(common),
    };
  };

  EngineCore.prototype.compare = function (config) {
    return C.compareDatasets(this.store.prev, this.store.curr, config);
  };

  root.EngineCore = EngineCore;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = EngineCore;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
