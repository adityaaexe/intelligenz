/* ==========================================================================
   INTELLIGENZ — Hash router
   Works on file:// with no server. Deep links and back/forward are preserved.
   ========================================================================== */

(function () {
  "use strict";

  function parse(input) {
    var raw = (input == null ? location.hash : input) || "";
    raw = String(raw).replace(/^#/, "");
    if (!raw || raw === "/") raw = "/overview";
    if (raw.charAt(0) !== "/") raw = "/" + raw;

    var qi = raw.indexOf("?");
    var path = qi === -1 ? raw : raw.slice(0, qi);
    var query = {};
    if (qi !== -1) {
      raw.slice(qi + 1).split("&").forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split("=");
        query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
      });
    }

    var parts = path.split("/").filter(Boolean);
    return {
      raw: raw,
      path: path,
      parts: parts,
      module: parts[0] || "overview",
      id: parts[1] || null,
      sub: parts[2] || null,
      query: query
    };
  }

  function current() {
    return parse(location.hash);
  }

  function go(path) {
    var next = path.charAt(0) === "#" ? path : "#" + path;
    if (location.hash === next) {
      window.IZApp.render(current());
    } else {
      location.hash = next;
    }
  }

  function start() {
    window.addEventListener("hashchange", function () {
      window.IZApp.render(current());
      var sb = document.getElementById("sidebar");
      var scrim = document.getElementById("sidebar-scrim");
      if (sb) sb.classList.remove("is-open");
      if (scrim) scrim.classList.remove("is-open");
    });
    window.IZApp.render(current());
  }

  window.IZRouter = { parse: parse, current: current, go: go, start: start };

  function boot() {
    window.IZApp.mount();
    start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
