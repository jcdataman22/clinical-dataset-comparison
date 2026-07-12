/*
 * worker.js — runs the CSV parse and comparison off the main thread so the UI
 * stays responsive on large datasets. It loads the same engine used on the main
 * thread and routes messages to it, emitting coarse progress updates.
 *
 * Protocol: main posts { type, id, ... }; worker replies { type:"done", id,
 * result | error } and interleaves { type:"progress", stage }.
 */
importScripts("core.js?v=5", "engine-core.js?v=5");

var engine = new self.EngineCore();

self.onmessage = function (e) {
  var msg = e.data || {};
  var id = msg.id;
  try {
    if (msg.type === "ping") {
      self.postMessage({ type: "done", id: id, result: "pong" });
    } else if (msg.type === "parse") {
      self.postMessage({ type: "progress", stage: "Parsing " + msg.name + "…" });
      var info = engine.parse(msg.which, msg.name, msg.text);
      self.postMessage({ type: "done", id: id, result: info });
    } else if (msg.type === "analyze") {
      self.postMessage({ type: "progress", stage: "Analyzing columns…" });
      var analysis = engine.analyze();
      self.postMessage({ type: "done", id: id, result: analysis });
    } else if (msg.type === "compare") {
      self.postMessage({ type: "progress", stage: "Comparing records…" });
      var result = engine.compare(msg.config);
      self.postMessage({ type: "progress", stage: "Preparing results…" });
      self.postMessage({ type: "done", id: id, result: result });
    } else {
      self.postMessage({ type: "done", id: id, error: "Unknown request: " + msg.type });
    }
  } catch (err) {
    self.postMessage({ type: "done", id: id, error: String((err && err.message) || err) });
  }
};
