/*
 * app.js — UI for the Clinical Data Set Comparison tool.
 * All DOM writes use textContent (never innerHTML with data) to stay XSS-safe,
 * since cell contents come from user-supplied CSV files.
 */
(function () {
  "use strict";

  var C = window.CDC;
  var RENDER_LIMIT = 2000; // cap DOM rows; exports always include everything
  var LARGE_ROWS = 100000; // show a heads-up at/above this row count
  var engine = null; // compute engine: Web Worker when available, else main thread

  var state = {
    prev: null, // { name, headers, rowCount } — parsed records live in the engine
    curr: null,
    keySel: {}, // column -> bool
    labelSel: {},
    compareSel: {},
    result: null,
    tabs: [],
    activeTab: 0,
    search: "",
  };

  // --------------------------------------------------------------------------
  // Small DOM helpers
  // --------------------------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "title") node.title = attrs[k];
        // Assign styles via the CSSOM (not setAttribute) so a strict CSP that
        // forbids inline style attributes still applies them.
        else if (k === "style") node.style.cssText = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  function $(id) {
    return document.getElementById(id);
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // --------------------------------------------------------------------------
  // Compute engine — Web Worker when available, main-thread fallback otherwise
  // --------------------------------------------------------------------------
  function createEngine(onProgress) {
    if (typeof Worker !== "undefined") {
      try {
        var w = new Worker("worker.js?v=5");
        var eng = workerEngine(w, onProgress);
        // Validate the worker (catches CSP / importScripts failures, file://,
        // etc.). If it can't run, quietly downgrade to the main-thread engine.
        eng.__probe().catch(function () {
          engine = mainEngine(onProgress);
        });
        return eng;
      } catch (e) {
        /* Worker constructor blocked — fall through to the main-thread engine. */
      }
    }
    return mainEngine(onProgress);
  }

  function workerEngine(worker, onProgress) {
    var seq = 0;
    var pending = {};
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === "progress") {
        if (onProgress) onProgress(m.stage);
        return;
      }
      if (m.type === "done") {
        var p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
      }
    };
    worker.onerror = function () {
      Object.keys(pending).forEach(function (id) {
        pending[id].reject(new Error("The background worker failed."));
        delete pending[id];
      });
    };
    function send(type, extra) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending[id] = { resolve: resolve, reject: reject };
        var msg = { type: type, id: id };
        if (extra) {
          Object.keys(extra).forEach(function (k) {
            msg[k] = extra[k];
          });
        }
        worker.postMessage(msg);
      });
    }
    return {
      mode: "worker",
      parse: function (which, name, text) {
        return send("parse", { which: which, name: name, text: text });
      },
      analyze: function () {
        return send("analyze");
      },
      compare: function (config) {
        return send("compare", { config: config });
      },
      __probe: function () {
        return Promise.race([
          send("ping"),
          new Promise(function (_, reject) {
            setTimeout(function () {
              reject(new Error("worker timeout"));
            }, 3000);
          }),
        ]);
      },
    };
  }

  function mainEngine(onProgress) {
    var core = new EngineCore();
    function defer(stage, fn) {
      if (onProgress) onProgress(stage);
      return new Promise(function (resolve, reject) {
        // Defer so the progress indicator can paint before a blocking run.
        setTimeout(function () {
          try {
            resolve(fn());
          } catch (e) {
            reject(e);
          }
        }, 0);
      });
    }
    return {
      mode: "main",
      parse: function (which, name, text) {
        return defer("Parsing " + name + "…", function () {
          return core.parse(which, name, text);
        });
      },
      analyze: function () {
        return defer("Analyzing columns…", function () {
          return core.analyze();
        });
      },
      compare: function (config) {
        return defer("Comparing datasets…", function () {
          return core.compare(config);
        });
      },
    };
  }

  // --------------------------------------------------------------------------
  // Progress indicator (revealed only when a run takes long enough to matter)
  // --------------------------------------------------------------------------
  var progressTimer = null;
  function beginProgress(stage) {
    updateProgressText(stage);
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      $("progress").classList.remove("hidden");
    }, 120);
  }
  function updateProgressText(stage) {
    $("progressText").textContent = stage || "Working…";
  }
  function endProgress() {
    clearTimeout(progressTimer);
    $("progress").classList.add("hidden");
  }

  // --------------------------------------------------------------------------
  // Privacy details modal
  // --------------------------------------------------------------------------
  function openPrivacy() {
    $("privacyModal").classList.remove("hidden");
  }
  function closePrivacy() {
    $("privacyModal").classList.add("hidden");
  }

  // --------------------------------------------------------------------------
  // Large-dataset heads-up
  // --------------------------------------------------------------------------
  function renderSizeNotice() {
    var host = $("sizeNotice");
    clear(host);
    var pRows = state.prev.rowCount;
    var cRows = state.curr.rowCount;
    if (pRows < LARGE_ROWS && cRows < LARGE_ROWS) {
      host.classList.add("hidden");
      return;
    }
    var tail =
      engine && engine.mode === "worker"
        ? "The comparison runs in a background worker, so the page stays responsive, but it may take a few seconds and use extra memory."
        : "The comparison may pause the page for a few seconds and use extra memory while it runs.";
    host.appendChild(el("strong", null, ["Large dataset"]));
    host.appendChild(
      document.createTextNode(
        " Previous: " + pRows.toLocaleString() + " rows · Current: " + cRows.toLocaleString() + " rows. " + tail
      )
    );
    host.classList.remove("hidden");
  }

  // --------------------------------------------------------------------------
  // File loading
  // --------------------------------------------------------------------------
  function setupDrop(dropId, inputId, nameId, which) {
    var drop = $(dropId);
    var input = $(inputId);
    var nameEl = $(nameId);

    input.addEventListener("change", function () {
      if (input.files && input.files[0]) readFile(input.files[0], which, nameEl);
    });
    drop.addEventListener("dragover", function (e) {
      e.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", function () {
      drop.classList.remove("dragover");
    });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        readFile(e.dataTransfer.files[0], which, nameEl);
      }
    });
  }

  function readFile(file, which, nameEl) {
    var reader = new FileReader();
    reader.onload = function () {
      beginProgress("Parsing " + file.name + "…");
      engine
        .parse(which, file.name, String(reader.result))
        .then(function (info) {
          endProgress();
          state[which] = { name: file.name, headers: info.headers, rowCount: info.rowCount };
          nameEl.textContent =
            file.name + " · " + info.rowCount + " rows · " + info.headers.length + " cols";
          maybeShowConfig();
        })
        .catch(function (e) {
          endProgress();
          nameEl.textContent = "Could not process file: " + ((e && e.message) || e);
        });
    };
    reader.onerror = function () {
      nameEl.textContent = "Could not read file.";
    };
    reader.readAsText(file);
  }

  // --------------------------------------------------------------------------
  // Configuration UI
  // --------------------------------------------------------------------------
  function maybeShowConfig() {
    if (!state.prev || !state.curr) return;

    beginProgress("Analyzing columns…");
    engine
      .analyze()
      .then(function (a) {
        endProgress();
        var common = a.common;
        state.common = common;
        var keys = a.suggestedKeys;
        var labels = a.labels;

        state.keySel = {};
        state.labelSel = {};
        state.compareSel = {};
        keys.forEach(function (k) {
          state.keySel[k] = true;
        });
        labels.forEach(function (l) {
          state.labelSel[l] = true;
        });
        common.forEach(function (c) {
          if (keys.indexOf(c) === -1) state.compareSel[c] = true;
        });

        buildChips("keyChips", common, state.keySel, function () {
          refreshCompareChips();
        });
        buildChips("labelChips", common, state.labelSel, null);
        refreshCompareChips();

        // Subject dropdown.
        var subjectSel = $("subjectSelect");
        clear(subjectSel);
        subjectSel.appendChild(el("option", { value: "" }, ["(none)"]));
        common.forEach(function (c) {
          subjectSel.appendChild(el("option", { value: c }, [c]));
        });
        if (a.subject) subjectSel.value = a.subject;

        $("keyHint").textContent = a.keyHint;
        renderSizeNotice();
        $("configCard").classList.remove("hidden");
        $("configCard").scrollIntoView({ behavior: "smooth", block: "start" });
        updateConfigHint();
      })
      .catch(function (e) {
        endProgress();
        showError((e && e.message) || String(e));
      });
  }

  function refreshCompareChips() {
    // Compare list = common columns that are not currently keys.
    var common = intersect(state.curr.headers, state.prev.headers);
    var available = common.filter(function (c) {
      return !state.keySel[c];
    });
    // Prune stale selections.
    Object.keys(state.compareSel).forEach(function (c) {
      if (available.indexOf(c) === -1) delete state.compareSel[c];
    });
    available.forEach(function (c) {
      if (!(c in state.compareSel)) state.compareSel[c] = true;
    });
    buildChips("compareChips", available, state.compareSel, updateConfigHint);
    updateConfigHint();
  }

  function buildChips(containerId, columns, selMap, onChange) {
    var container = $(containerId);
    clear(container);
    columns.forEach(function (col) {
      var input = el("input", { type: "checkbox" });
      input.checked = !!selMap[col];
      var chip = el("label", { class: "chip" + (input.checked ? " on" : "") }, [input, col]);
      input.addEventListener("change", function () {
        selMap[col] = input.checked;
        chip.classList.toggle("on", input.checked);
        if (onChange) onChange();
        updateConfigHint();
      });
      container.appendChild(chip);
    });
  }

  function selectedList(selMap) {
    return Object.keys(selMap).filter(function (k) {
      return selMap[k];
    });
  }

  function updateConfigHint() {
    var keys = selectedList(state.keySel);
    var cmp = selectedList(state.compareSel);
    $("compareBtn").disabled = keys.length === 0 || cmp.length === 0;
    $("configHint").textContent =
      keys.length + " key column(s), " + cmp.length + " column(s) to compare";
  }

  // --------------------------------------------------------------------------
  // Run comparison
  // --------------------------------------------------------------------------
  function runCompare() {
    var config = {
      keyColumns: selectedList(state.keySel),
      compareColumns: selectedList(state.compareSel),
      labelColumns: selectedList(state.labelSel),
      subjectColumn: $("subjectSelect").value || null,
      ignoreWhitespace: $("optWhitespace").checked,
      ignoreCase: $("optCase").checked,
      numericEqual: $("optNumeric").checked,
      extraMissingTokens: $("optMissing").checked,
    };
    $("compareBtn").disabled = true;
    beginProgress("Comparing datasets…");
    engine
      .compare(config)
      .then(function (result) {
        endProgress();
        updateConfigHint();
        state.result = result;
        state.search = "";
        buildTabs(result);
        renderResultsShell(result);
        $("resultsCard").classList.remove("hidden");
        $("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function (e) {
        endProgress();
        updateConfigHint();
        showError((e && e.message) || String(e));
      });
  }

  function showError(msg) {
    $("resultsCard").classList.remove("hidden");
    clear($("notices"));
    $("notices").appendChild(
      el("div", { class: "notice warn" }, [el("strong", null, ["Cannot compare"]), msg])
    );
    clear($("statGrid"));
    clear($("tabs"));
    clear($("tabContent"));
    $("toolbar").classList.add("hidden");
  }

  // --------------------------------------------------------------------------
  // Results rendering
  // --------------------------------------------------------------------------
  function renderResultsShell(result) {
    $("toolbar").classList.remove("hidden");

    // Notices: schema changes + duplicate keys.
    var notices = $("notices");
    clear(notices);

    var sch = result.schema;
    if (sch.addedColumns.length || sch.removedColumns.length) {
      var items = [];
      if (sch.addedColumns.length)
        items.push(el("li", null, ["New columns in current: ", el("strong", null, [sch.addedColumns.join(", ")])]));
      if (sch.removedColumns.length)
        items.push(el("li", null, ["Columns dropped since previous: ", el("strong", null, [sch.removedColumns.join(", ")])]));
      notices.appendChild(
        el("div", { class: "notice observation" }, [
          el("strong", null, ["Structure changed between transfers"]),
          el("ul", null, items),
        ])
      );
    }

    var dupPrev = result.keyIssues.duplicatePreviousKeys;
    var dupCurr = result.keyIssues.duplicateCurrentKeys;
    if (dupPrev.length || dupCurr.length) {
      var keyCols = result.config.keyColumns;

      // State which dataset(s) contain the repeated keys.
      var where;
      if (dupPrev.length && dupCurr.length) {
        where =
          "Both datasets have rows that repeat a key value — " +
          dupPrev.length + " in the previous dataset and " +
          dupCurr.length + " in the current dataset.";
      } else if (dupPrev.length) {
        where =
          "The previous dataset has " + dupPrev.length + " key value" +
          (dupPrev.length > 1 ? "s that appear" : " that appears") +
          " on more than one row.";
      } else {
        where =
          "The current dataset has " + dupCurr.length + " key value" +
          (dupCurr.length > 1 ? "s that appear" : " that appears") +
          " on more than one row.";
      }

      // List each repeated key, labeled with the dataset it came from.
      var dupList = [];
      function pushDup(dataset, dups) {
        dups.forEach(function (d) {
          var vals = keyCols
            .map(function (kc) {
              var v = d.record[kc] != null ? d.record[kc] : "";
              return kc + " " + v;
            })
            .join(" · ");
          dupList.push(
            el("li", null, [
              dataset + " — ",
              el("strong", null, [vals]),
              " (" + d.count + " rows)",
            ])
          );
        });
      }
      pushDup("Previous", dupPrev);
      pushDup("Current", dupCurr);

      notices.appendChild(
        el("div", { class: "notice observation" }, [
          el("strong", null, ["Potential duplicate records"]),
          where + " These rows may be duplicates; the comparison matches on the first row for each key.",
          el("ul", null, dupList),
        ])
      );
    }

    // Stat cards.
    var c = result.counts;
    var grid = $("statGrid");
    clear(grid);
    grid.appendChild(stat(c.addedRecords, "Records added", "added"));
    grid.appendChild(stat(c.removedRecords, "Records removed", "removed"));
    grid.appendChild(stat(c.changedRecords, "Records changed", "changed"));
    grid.appendChild(stat(c.changedCells, "Values changed", "changed"));
    grid.appendChild(stat(c.unchangedRecords, "Records unchanged", ""));
    grid.appendChild(stat(c.matchedKeys, "Matched records", ""));
    grid.appendChild(stat(c.previousRows + " → " + c.currentRows, "Rows (prev → curr)", ""));

    renderActiveTab();
  }

  function stat(num, label, cls) {
    return el("div", { class: "stat " + cls }, [
      el("div", { class: "num" }, [String(num)]),
      el("div", { class: "lbl" }, [label]),
    ]);
  }

  function buildTabs(result) {
    var keys = result.config.keyColumns;
    var labels = result.config.labelColumns;

    var changedColumns = keys
      .concat(labels)
      .concat(["VARIABLE", "CHANGE_TYPE", "PREVIOUS_VALUE", "CURRENT_VALUE", "NUMERIC_DELTA"]);

    state.tabs = [
      {
        id: "changed",
        label: "Changed values",
        count: result.cellChanges.length,
        columns: changedColumns,
        rows: result.cellChanges,
        kind: "cells",
        exportName: "changed_values.csv",
      },
      {
        id: "added",
        label: "Added records",
        count: result.addedRecords.length,
        columns: state.curr.headers,
        rows: result.addedRecords,
        kind: "records",
        exportName: "added_records.csv",
      },
      {
        id: "removed",
        label: "Removed records",
        count: result.removedRecords.length,
        columns: state.prev.headers,
        rows: result.removedRecords,
        kind: "records",
        exportName: "removed_records.csv",
      },
      {
        id: "variables",
        label: "By variable",
        count: result.variableSummary.length,
        columns: ["VARIABLE", "changed", "added", "removed", "modified", "share"],
        rows: result.variableSummary.map(function (v) {
          return {
            VARIABLE: v.column,
            changed: v.changed,
            added: v.added,
            removed: v.removed,
            modified: v.modified,
            share: result.counts.matchedKeys ? v.changed / result.counts.matchedKeys : 0,
          };
        }),
        kind: "variables",
        exportName: "variable_summary.csv",
      },
    ];

    if (result.subjectSummary.length) {
      // Use the actual column the user chose to summarize by, so the tab label,
      // column header, and export name reflect that variable's name.
      var summaryVar = result.config.subjectColumn || "group";
      state.tabs.push({
        id: "subjects",
        label: "By " + summaryVar,
        count: result.subjectSummary.length,
        columns: [summaryVar, "added", "removed", "changed", "total"],
        rows: result.subjectSummary.map(function (s) {
          var row = {
            added: s.added,
            removed: s.removed,
            changed: s.changed,
            total: s.added + s.removed + s.changed,
          };
          row[summaryVar] = s.subject;
          return row;
        }),
        kind: "generic",
        exportName: "summary_by_" + summaryVar + ".csv",
      });
    }

    state.activeTab = 0;
    var tabsEl = $("tabs");
    clear(tabsEl);
    state.tabs.forEach(function (t, i) {
      var btn = el("button", { class: "tab" + (i === 0 ? " active" : "") }, [
        t.label + " ",
        el("span", { class: "count" }, ["(" + t.count + ")"]),
      ]);
      btn.addEventListener("click", function () {
        state.activeTab = i;
        state.search = "";
        $("search").value = "";
        Array.prototype.forEach.call(tabsEl.children, function (ch, ci) {
          ch.classList.toggle("active", ci === i);
        });
        renderActiveTab();
      });
      tabsEl.appendChild(btn);
    });
  }

  function currentTab() {
    return state.tabs[state.activeTab];
  }

  function filteredRows() {
    var tab = currentTab();
    if (!state.search) return tab.rows;
    var q = state.search.toLowerCase();
    return tab.rows.filter(function (row) {
      for (var i = 0; i < tab.columns.length; i++) {
        var v = row[tab.columns[i]];
        if (v != null && String(v).toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
  }

  function renderActiveTab() {
    var tab = currentTab();
    var rows = filteredRows();
    var content = $("tabContent");
    clear(content);

    $("rowcount").textContent =
      rows.length === tab.rows.length
        ? rows.length + " rows"
        : rows.length + " of " + tab.rows.length + " rows";

    if (rows.length === 0) {
      content.appendChild(el("div", { class: "empty" }, [
        tab.rows.length === 0 ? "Nothing in this category — nice and clean." : "No rows match your filter.",
      ]));
      return;
    }

    var table = el("table");
    var thead = el("thead");
    var headRow = el("tr");
    tab.columns.forEach(function (col) {
      headRow.appendChild(el("th", null, [prettyHeader(col)]));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el("tbody");
    var limit = Math.min(rows.length, RENDER_LIMIT);
    for (var i = 0; i < limit; i++) {
      tbody.appendChild(renderRow(tab, rows[i]));
    }
    table.appendChild(tbody);

    var scroll = el("div", { class: "table-scroll" }, [table]);
    content.appendChild(scroll);

    if (rows.length > RENDER_LIMIT) {
      content.appendChild(
        el("div", { class: "rowcount", style: "margin-top:8px" }, [
          "Showing first " + RENDER_LIMIT + " of " + rows.length + " rows. Use Export to get them all.",
        ])
      );
    }
  }

  function prettyHeader(col) {
    var map = {
      VARIABLE: "Variable",
      CHANGE_TYPE: "Change",
      PREVIOUS_VALUE: "Previous",
      CURRENT_VALUE: "Current",
      NUMERIC_DELTA: "Δ",
      share: "Share of matched",
      subject: "Subject",
    };
    return map[col] || col;
  }

  function renderRow(tab, row) {
    var tr = el("tr");
    tab.columns.forEach(function (col) {
      tr.appendChild(renderCell(tab, col, row));
    });
    return tr;
  }

  function renderCell(tab, col, row) {
    var val = row[col];

    if (tab.kind === "cells") {
      if (col === "CHANGE_TYPE") {
        return el("td", null, [el("span", { class: "badge " + val }, [val])]);
      }
      if (col === "PREVIOUS_VALUE") {
        return el("td", { class: "mono" }, [el("span", { class: "val-prev" }, [displayVal(val)])]);
      }
      if (col === "CURRENT_VALUE") {
        return el("td", { class: "mono" }, [el("span", { class: "val-curr" }, [displayVal(val)])]);
      }
      if (col === "NUMERIC_DELTA") {
        if (val == null || val === "") return el("td", null, [""]);
        var sign = val > 0 ? "+" : "";
        return el("td", { class: "mono delta" }, [sign + val]);
      }
    }

    if (tab.kind === "variables" && col === "share") {
      var pct = Math.round((val || 0) * 100);
      var barTrack = el("div", { class: "bar-track" }, [
        el("div", { class: "bar", style: "width:" + Math.max(2, pct) + "%" }),
      ]);
      return el("td", null, [
        el("div", { style: "display:flex;align-items:center;gap:8px" }, [barTrack, el("span", { class: "rowcount" }, [pct + "%"])]),
      ]);
    }

    return el("td", { class: isNumericCol(col) ? "mono" : "" }, [displayVal(val)]);
  }

  function isNumericCol(col) {
    return ["changed", "added", "removed", "modified", "total"].indexOf(col) !== -1;
  }

  function displayVal(v) {
    if (v == null || v === "") return "·";
    return String(v);
  }

  // --------------------------------------------------------------------------
  // Export
  // --------------------------------------------------------------------------
  function exportCurrent() {
    var tab = currentTab();
    var rows = filteredRows();
    var csv = C.toCSV(rows, tab.columns);
    downloadText(csv, tab.exportName);
  }

  function downloadText(text, filename) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------
  function intersect(a, b) {
    var setB = {};
    b.forEach(function (x) {
      setB[x] = true;
    });
    return a.filter(function (x) {
      return setB[x];
    });
  }

  // --------------------------------------------------------------------------
  // Sample data
  // --------------------------------------------------------------------------
  function loadPair(prevFile, currFile) {
    beginProgress("Loading demo…");
    Promise.all([
      fetch(prevFile).then(function (r) {
        return r.text();
      }),
      fetch(currFile).then(function (r) {
        return r.text();
      }),
    ])
      .then(function (texts) {
        return engine
          .parse("prev", prevFile, texts[0])
          .then(function (p) {
            state.prev = { name: prevFile, headers: p.headers, rowCount: p.rowCount };
            $("prevName").textContent =
              prevFile + " · " + p.rowCount + " rows · " + p.headers.length + " cols";
            return engine.parse("curr", currFile, texts[1]);
          })
          .then(function (cInfo) {
            state.curr = { name: currFile, headers: cInfo.headers, rowCount: cInfo.rowCount };
            $("currName").textContent =
              currFile + " · " + cInfo.rowCount + " rows · " + cInfo.headers.length + " cols";
            endProgress();
            maybeShowConfig();
          });
      })
      .catch(function () {
        endProgress();
        $("prevName").textContent = "Sample files not found (serve this folder over http).";
      });
  }

  function loadDemoSdtm() {
    loadPair("demo_previous.csv", "demo_current.csv");
  }

  function loadDemoOther() {
    loadPair("demo_other_previous.csv", "demo_other_current.csv");
  }

  // --------------------------------------------------------------------------
  // Wire up
  // --------------------------------------------------------------------------
  function init() {
    engine = createEngine(updateProgressText);

    // Visible build stamp so it's easy to confirm the latest code is loaded
    // (and to diagnose browser caching). Bump alongside the ?v= asset tags.
    var buildTag = $("buildTag");
    if (buildTag) buildTag.textContent = "Build v8";

    setupDrop("dropPrev", "prevFile", "prevName", "prev");
    setupDrop("dropCurr", "currFile", "currName", "curr");
    $("loadDemoSdtm").addEventListener("click", loadDemoSdtm);
    $("loadDemoOther").addEventListener("click", loadDemoOther);
    $("compareBtn").addEventListener("click", runCompare);
    $("exportBtn").addEventListener("click", exportCurrent);
    $("search").addEventListener("input", function (e) {
      state.search = e.target.value;
      renderActiveTab();
    });

    // Privacy details modal
    $("privacyBadge").addEventListener("click", openPrivacy);
    $("privacyModalClose").addEventListener("click", closePrivacy);
    $("privacyModal").addEventListener("click", function (e) {
      if (e.target === $("privacyModal")) closePrivacy();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePrivacy();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
