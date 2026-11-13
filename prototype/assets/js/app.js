/* ==========================================================================
   INTELLIGENZ — Application: rendering + interactions
   Classic script. No modules, no fetch, no build step.
   ========================================================================== */

(function () {
  "use strict";

  var D = window.IZData;

  var S = {
    route: { module: "overview", id: null, query: {} },
    state: "live",          // live | empty | loading | error | permission | offline | degraded
    density: "default",
    theme: "light",
    approvals: [],
    noticeDismissed: false,
    ui: {
      groups: {},
      ov: { sort: "attention", filter: [], sel: {}, open: {} },
      ac: { tab: "activity", id: "agt_eng_04", sort: "attention" },
      ap: { risk: "all", rail: "evidence", diff: false },
      rl: { finding: "fnd_01JB6S4M2Q", tab: "supporting", rail: "sources", filter: [] }
    }
  };

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function icon(name, cls) {
    return '<svg class="iz-icon ' + (cls || "") + '" aria-hidden="true" focusable="false"><use href="#' + name + '"></use></svg>';
  }

  function glyph(state, size) {
    var open = '<svg class="iz-pill__glyph" viewBox="0 0 16 16"' +
      (size ? ' style="width:' + size + 'px;height:' + size + 'px"' : "") +
      ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    var body = "";
    switch (state) {
      case "active":
        body = '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="6" opacity=".35"/>';
        break;
      case "queued":
        body = '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2.2"/>';
        break;
      case "completed":
        body = '<path d="M3.5 8.6l3 3 6-7.2"/>';
        break;
      case "failed":
        body = '<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>';
        break;
      case "awaiting":
        body = '<path d="M6 4.2v7.6M10 4.2v7.6"/>';
        break;
      case "degraded":
        body = '<path d="M8 2.8l5.6 9.6H2.4z"/><path d="M8 6.8v2.6"/>';
        break;
      case "offline":
        body = '<circle cx="8" cy="8" r="5.4"/><path d="M4.3 4.3l7.4 7.4"/>';
        break;
      default:
        body = '<circle cx="8" cy="8" r="5.4" stroke-dasharray="1 2"/>';
    }
    return open + body + "</svg>";
  }

  function pill(state, label, detail) {
    return '<span class="iz-pill" data-state="' + state + '">' + glyph(state) +
      '<span class="iz-sr-only">Status: </span><span>' + esc(label) + "</span>" +
      (detail ? '<span class="iz-pill__detail">· ' + esc(detail) + "</span>" : "") +
      "</span>";
  }

  function riskBadge(level, score) {
    var n = { low: 1, medium: 2, high: 3, critical: 4 }[level] || 1;
    var bars = "";
    for (var i = 0; i < 4; i++) bars += '<span class="iz-risk__bar' + (i < n ? " is-on" : "") + '"></span>';
    return '<span class="iz-risk" data-risk="' + level + '">' +
      '<span class="iz-sr-only">Risk: </span>' +
      '<span class="iz-risk__bars" aria-hidden="true">' + bars + "</span>" +
      '<span class="iz-risk__label">' + esc(level.charAt(0).toUpperCase() + level.slice(1)) + "</span>" +
      '<span class="iz-risk__sep" aria-hidden="true">·</span>' +
      '<span class="iz-risk__score"><span class="iz-sr-only">score </span>' + esc(score) + "</span></span>";
  }

  function conf(value, band, sources) {
    var n = band === "insufficient" ? 0
      : value >= 0.80 ? 5
      : value >= 0.70 ? 4
      : value >= 0.60 ? 3
      : value >= 0.40 ? 2
      : value >= 0.20 ? 1 : 0;
    var segs = "";
    for (var i = 0; i < 5; i++) segs += '<span class="iz-conf__seg' + (i < n ? " is-on" : "") + '"></span>';
    var label = band.charAt(0).toUpperCase() + band.slice(1);
    return '<span class="iz-conf" data-band="' + band + '">' +
      '<span class="iz-conf__meter" aria-hidden="true">' + segs + "</span>" +
      '<span class="iz-conf__val">' + value.toFixed(2) + "</span>" +
      '<span class="iz-conf__band">' + esc(label) + (sources ? " · " + sources + " sources" : "") + "</span></span>";
  }

  function code(value, opts) {
    opts = opts || {};
    var v = opts.short && value.length > 16 ? value.slice(0, 14) + "…" : value;
    return '<span class="iz-code' + (opts.copy ? " iz-code--copy" : "") + '"' +
      (opts.copy ? ' data-act="copy" data-arg="' + esc(value) + '" role="button" tabindex="0" aria-label="Copy ' + esc(value) + '"' : "") + ">" +
      v + (opts.copy ? icon("i-copy") : "") + "</span>";
  }

  function avatar(initials, opts) {
    opts = opts || {};
    return '<span class="iz-avatar' + (opts.light ? " iz-avatar--light" : "") + (opts.lg ? " iz-avatar--lg" : "") + '" aria-hidden="true">' + esc(initials) + "</span>";
  }

  function money(n) {
    n = Number(n);
    var abs = Math.abs(n);
    var dp = abs > 0 && abs < 1 ? 4 : 2;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  function spark(points, label) {
    var max = Math.max.apply(null, points), min = Math.min.apply(null, points);
    var span = max - min || 1;
    var w = 72, h = 20, step = w / (points.length - 1);
    var d = points.map(function (p, i) {
      var x = (i * step).toFixed(1);
      var y = (h - 2 - ((p - min) / span) * (h - 4)).toFixed(1);
      return (i ? "L" : "M") + x + " " + y;
    }).join(" ");
    return '<svg class="iz-spark" viewBox="0 0 72 20" role="img" aria-label="' + esc(label) + '">' +
      '<path d="' + d + '" fill="none" stroke="var(--iz-viz-1)" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }

  function metric(label, value, unit, sub, cls) {
    return '<div class="iz-metric ' + (cls || "") + '">' +
      '<span class="iz-metric__label">' + esc(label) + "</span>" +
      '<span class="iz-metric__value">' + esc(value) + (unit ? '<span class="iz-metric__unit">' + esc(unit) + "</span>" : "") + "</span>" +
      (sub ? '<span class="iz-metric__delta">' + sub + "</span>" : "") +
      "</div>";
  }

  function panel(title, meta, actions, body, opts) {
    opts = opts || {};
    return '<div class="iz-panel' + (opts.inset ? " iz-panel--inset" : "") + '">' +
      (title ? '<div class="iz-panel__head"><h2 class="iz-panel__title">' + esc(title) + "</h2>" +
        (meta ? '<span class="iz-section__meta">' + esc(meta) + "</span>" : "") +
        (actions ? '<div class="iz-panel__actions">' + actions + "</div>" : "") + "</div>" : "") +
      body + "</div>";
  }

  function sectionHead(title, meta, actions, id) {
    return '<div class="iz-section__head"><h2 class="iz-section__title" id="' + (id || "") + '">' + esc(title) + "</h2>" +
      (meta ? '<span class="iz-section__meta">' + meta + "</span>" : "") +
      (actions ? '<div class="iz-section__actions">' + actions + "</div>" : "") + "</div>";
  }

  function emptyState(title, body, actions, inline) {
    return '<div class="iz-empty' + (inline ? " iz-empty--inline" : "") + '">' +
      '<div class="iz-empty__icon">' + icon("i-inbox", "iz-icon--20") + "</div>" +
      '<div class="iz-empty__title">' + esc(title) + "</div>" +
      '<p class="iz-empty__body">' + esc(body) + "</p>" +
      (actions ? '<div class="iz-empty__actions">' + actions + "</div>" : "") + "</div>";
  }

  function callout(kind, title, text, actions) {
    var ic = kind === "denied" ? "i-lock" : kind === "error" ? "i-warn" : "i-info";
    return '<div class="iz-callout iz-callout--' + kind + '">' +
      '<span class="iz-callout__icon">' + icon(ic) + "</span>" +
      '<div class="iz-callout__body"><div class="iz-callout__title">' + esc(title) + "</div>" +
      '<p class="iz-callout__text">' + esc(text) + "</p>" +
      (actions ? '<div class="iz-callout__actions">' + actions + "</div>" : "") + "</div></div>";
  }

  function skeleton(kind) {
    if (kind === "table") {
      var rows = "";
      for (var i = 0; i < 7; i++) {
        rows += '<div class="iz-row" style="padding:9px 12px;border-bottom:1px solid var(--iz-border-subtle)">' +
          '<span class="iz-sk" style="width:64px;height:14px"></span>' +
          '<span class="iz-sk iz-sk--text" style="flex:1"></span>' +
          '<span class="iz-sk" style="width:52px;height:12px"></span>' +
          '<span class="iz-sk" style="width:40px;height:12px"></span></div>';
      }
      return rows;
    }
    if (kind === "metrics") {
      var m = "";
      for (var j = 0; j < 4; j++) m += '<div><span class="iz-sk" style="width:70px;height:10px;display:block;margin-bottom:8px"></span><span class="iz-sk" style="width:90px;height:24px;display:block"></span></div>';
      return m;
    }
    return '<span class="iz-sk iz-sk--text" style="width:100%"></span>';
  }

  function stateBanners() {
    if (S.state === "offline") {
      return '<div class="iz-banner iz-banner--offline" role="status">' + icon("i-warn") +
        "<span><b>Offline</b> — showing data from 04:12Z. 2 approvals queued and will submit when reconnected.</span>" +
        '<span class="iz-banner__actions"><button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="retry-sync">Retry now</button></span></div>';
    }
    if (S.state === "degraded") {
      return '<div class="iz-banner iz-banner--degraded" role="status">' + icon("i-warn") +
        "<span><b>Model router degraded</b> — 2 of 5 providers responding. New runs queue rather than fail. Approvals are unaffected.</span>" +
        '<span class="iz-banner__actions"><button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="view-status">View status</button></span></div>';
    }
    if (S.state === "permission") {
      return '<div class="iz-banner iz-banner--degraded" role="status">' + icon("i-lock") +
        "<span><b>Preview: permission denied</b> — this screen is rendering the state a Viewer role without <code>approval:decide</code> or <code>billing:read</code> would see.</span></div>";
    }
    return "";
  }

  /* ------------------------------------------------------------------ */
  /* shell                                                              */
  /* ------------------------------------------------------------------ */

  var MODULES = {
    overview: { label: "Overview", purpose: "Posture, live runs, human blockers, spend" },
    approvals: { label: "Approvals", purpose: "Risk-ranked governance queue with evidence" },
    agents: { label: "Agent Command Centre", purpose: "Registry, execution, handoffs, recovery" },
    projects: { label: "Projects", purpose: "Goals, plans, repositories, runs per project" },
    code: { label: "Code Intelligence", purpose: "Repository understanding, refactor proposals" },
    design: { label: "Design Intelligence", purpose: "UI audits and design-system drift" },
    creative: { label: "Creative Studio", purpose: "Brand assets with licence provenance" },
    workflows: { label: "Workflow Studio", purpose: "Author the graphs agents execute" },
    schedules: { label: "Schedules", purpose: "Triggers, fire times, missed runs" },
    research: { label: "Research Lab", purpose: "Campaigns, provenance, findings, confidence" },
    models: { label: "Model Intelligence", purpose: "Routing policy, cost and quality history" },
    knowledge: { label: "Knowledge Base", purpose: "Durable project memory and decisions" },
    security: { label: "Security", purpose: "Policies, grants, isolation, audit export" },
    reports: { label: "Reports", purpose: "Delivery and cost reports per client or period" },
    integrations: { label: "Integrations", purpose: "Connected providers and their health" },
    marketplace: { label: "Marketplace", purpose: "Installable agents, skills, templates" }
  };

  function navMarkup() {
    var out = "";
    D.navGroups.forEach(function (g) {
      if (g.pinned) {
        out += "<ul>" + g.items.map(navItem).join("") + "</ul>";
        return;
      }
      var open = S.ui.groups[g.id] !== false;
      out += '<div class="iz-nav__group">' +
        '<button class="iz-nav__groupbtn" data-act="group-toggle" data-arg="' + g.id + '" aria-label="' + esc(g.label) + ' navigation group" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="grp-' + g.id + '">' +
        icon("i-chev-down") + "<span>" + esc(g.label) + "</span></button>" +
        '<ul class="iz-nav__grouplist" id="grp-' + g.id + '"' + (open ? "" : " hidden") + ">" +
        g.items.map(navItem).join("") + "</ul></div>";
    });
    return out;
  }

  function navItem(it) {
    var cur = S.route.module === it.id ? ' aria-current="page"' : "";
    var rail = window.innerWidth < 1280;
    return '<li><a class="iz-nav__item" href="' + it.href + '" data-nav="' + it.id + '"' + cur +
      ' aria-label="' + esc(it.label) + '"' +
      (rail ? ' data-tip="' + esc(it.label) + '"' : "") +
      ' title="' + esc(it.label) + '">' +
      icon(it.icon) + '<span class="iz-nav__label">' + esc(it.label) + "</span>" +
      (it.badge ? '<span class="iz-badge iz-badge--awaiting" aria-label="' + it.badge + ' awaiting">' + it.badge + "</span>" : "") + "</a></li>";
  }

  function scopebarMarkup() {
    var budgetPct = Math.round((D.posture.spend.today / D.posture.spend.ceiling) * 100);
    var restricted = S.state === "permission";
    var budgetText = restricted ? "budget restricted" : "budget " + budgetPct + "%";
    var awaiting = S.approvals.filter(function (a) { return a.state === "awaiting"; }).length;
    var statusLabel = awaiting + " approvals awaiting, " +
      (restricted ? "budget restricted" : "budget " + budgetPct + " percent used") +
      ", updated 04:19:02Z";
    return '<button class="iz-chip" data-act="workspace" aria-haspopup="menu">' +
      '<span class="iz-avatar iz-avatar--light" style="width:18px;height:18px;font-size:11px">RC</span>' +
      '<span class="iz-truncate">' + esc(D.workspace.name) + "</span>" + icon("i-chev-down") + "</button>" +
      '<span class="iz-scope-sep" aria-hidden="true">›</span>' +
      '<button class="iz-chip iz-chip--project" data-act="project" aria-haspopup="menu">' +
      '<span class="iz-mono" style="font-size:11px;color:var(--iz-ink-3)">prj_control-plane</span>' +
      '<span class="iz-truncate">' + esc(D.project.name) + "</span>" + icon("i-chev-down") + "</button>" +
      '<span class="iz-scope-sep iz-chip--project" aria-hidden="true">›</span>' +
      '<button class="iz-chip iz-chip--env" data-env="' + D.environment + '" data-act="env" aria-haspopup="menu">' +
      icon("i-branch", "iz-icon--12") + esc(D.environment) + "</button>" +
      '<button class="iz-chip iz-chip--branch" data-act="branch" aria-haspopup="menu">' + esc(D.branch.name) + " @ " + esc(D.branch.sha) + "</button>" +
      '<span class="iz-chip iz-chip--simulated" data-act="notice">' + icon("i-info", "iz-icon--12") + "Simulated data</span>" +
      '<a class="iz-chip iz-chip--status" href="#/approvals" aria-label="' + esc(statusLabel) + '" title="' + esc(statusLabel) + '">' +
      '<span class="iz-dot iz-dot--awaiting" aria-hidden="true"></span>' +
      '<span class="iz-status-full">' + awaiting + " awaiting · " + (restricted ? "restricted" : budgetPct + "%") + "</span>" +
      '<span class="iz-status-mini">' + awaiting + "</span></a>" +
      '<div class="iz-scopebar__right">' +
      "<span>" + esc(S.approvals.filter(function (a) { return a.state === "awaiting"; }).length) + " awaiting · " + budgetText + "</span>" +
      '<span class="iz-scope-sep iz-sep-dot" aria-hidden="true"></span><span>updated 04:19:02Z</span></div>';
  }

  function modeMarkup() {
    var opts = D.modes.map(function (m) {
      return '<button class="iz-mode__opt" aria-label="' + esc(m.label) + '" aria-pressed="' + (m.id === "copilot" ? "true" : "false") + '" data-act="mode" data-arg="' + m.id + '" data-tip="' + esc(m.hint) + '">' +
        icon(m.icon) + "<span>" + esc(m.label) + "</span></button>";
    }).join("");
    return '<div class="iz-mode" role="group" aria-label="Operating mode">' + opts + "</div>";
  }

  function shellSync() {
    var nav = document.getElementById("nav");
    if (nav) nav.innerHTML = navMarkup();
    var sb = document.getElementById("scopebar");
    if (sb) sb.innerHTML = scopebarMarkup();
    var mode = document.getElementById("mode-slot");
    if (mode) mode.innerHTML = modeMarkup();
    var badge = document.getElementById("notif-count");
    if (badge) {
      var unread = D.notifications.filter(function (n) { return n.unread; }).length;
      badge.textContent = unread;
      badge.hidden = unread === 0;
    }
    document.documentElement.setAttribute("data-density", S.density);
    document.documentElement.setAttribute("data-theme", S.theme);
  }

  /* ------------------------------------------------------------------ */
  /* Overview                                                           */
  /* ------------------------------------------------------------------ */

  function overviewEmpty() {
    return '<div class="iz-page">' + screenHeader("Overview", "No runs yet in this workspace") +
      '<div class="iz-posture" data-posture="offline">' +
      metricCell("Posture", "—", "Waiting for the first run") +
      metricCell("Running", "0", "Nothing executing") +
      metricCell("Awaiting approval", "0", "Queue is clear") +
      metricCell("Failed · 24h", "0", "No failures") +
      metricCell("Spend today", "—", "No spend recorded") +
      "</div>" +
      '<div class="iz-grid12" style="margin-top:var(--iz-space-20)">' +
      '<div class="iz-col-8">' + panel("Live runs", "", "",
        emptyState("No runs in this workspace",
          "Runs appear when a workflow is triggered, scheduled, or started by hand. Start with a template to see the execution trace, guardrails, and evidence chain.",
          '<button class="iz-btn iz-btn--primary" data-act="run-workflow">Run a workflow</button><button class="iz-btn iz-btn--secondary" data-act="browse-templates">Browse templates</button>')) + "</div>" +
      '<div class="iz-col-4">' + panel("Needs you", "", "",
        emptyState("No approvals waiting", "Nothing needs a human decision. The queue was last cleared at 04:02Z by M. Okafor.", "", true)) + "</div>" +
      "</div>" + "</div>";
  }

  function metricCell(label, value, sub) {
    return '<div class="iz-posture__cell">' + metric(label, value, "", sub, "iz-metric--sm") + "</div>";
  }

  function screenHeader(title, sub, actions) {
    return '<header class="iz-screen-header"><div class="iz-screen-header__main">' +
      '<div class="iz-screen-header__title"><h1 class="iz-h1">' + esc(title) + "</h1></div>" +
      '<div class="iz-screen-header__sub">' + sub + "</div></div>" +
      '<div class="iz-screen-header__actions">' + (actions || "") + "</div></header>";
  }

  function runsTable() {
    var rows = D.runs.slice();
    var f = S.ui.ov.filter;
    if (f.length) rows = rows.filter(function (r) { return f.indexOf(r.state) !== -1; });
    if (S.ui.ov.sort === "cost") rows.sort(function (a, b) { return b.cost - a.cost; });
    else {
      var rank = { awaiting: 0, failed: 1, degraded: 2, active: 3, queued: 4, completed: 5 };
      rows.sort(function (a, b) { return rank[a.state] - rank[b.state]; });
    }

    var body = rows.map(function (r) {
      var sel = S.ui.ov.sel[r.id] ? " is-selected" : "";
      var open = !!S.ui.ov.open[r.id];
      var detailId = "detail-" + r.id;
      return '<tr class="iz-run-row' + sel + '" data-run="' + r.id + '" data-search="' + esc((r.title + " " + r.agent + " " + r.repo + " " + r.stateLabel).toLowerCase()) + '">' +
        '<td><label class="iz-check-hit"><input type="checkbox" data-act="select-run" data-arg="' + r.id + '" aria-label="Select run ' + esc(r.title) + '"' + (sel ? " checked" : "") + "></label></td>" +
        "<td>" + pill(r.state, r.stateLabel) + "</td>" +
        '<td><div class="iz-row" style="gap:6px;flex-wrap:nowrap;min-width:0">' +
        '<button class="iz-row-toggle" data-act="row-expand" data-arg="' + r.id + '" aria-expanded="' + (open ? "true" : "false") + '" aria-controls="' + detailId + '" aria-label="' + (open ? "Hide" : "Show") + ' details for ' + esc(r.title) + '" data-tip="' + (open ? "Hide" : "Show") + ' details">' +
        '<span class="iz-caret">' + icon("i-chev-right") + "</span></button>" +
        '<div class="iz-stack" style="gap:1px;min-width:0"><span class="iz-truncate" style="font-weight:500">' + esc(r.title) + "</span>" +
        '<span class="iz-meta" style="font-size:11px">' + code(r.short, { short: true }) + "</span></div></div></td>" +
        '<td><span class="iz-row" style="gap:6px">' + avatar(r.avatar, { light: true }) + '<span class="iz-truncate">' + esc(r.agent) + "</span></span></td>" +
        '<td class="iz-td--num">' + (r.cost ? money(r.cost) : "—") + "</td>" +
        '<td class="iz-td--num">' + esc(r.duration) + "</td>" +
        '<td class="iz-td--actions"><button class="iz-iconbtn" data-act="run-menu" data-arg="' + r.id + '" aria-label="Actions for ' + esc(r.id) + '" data-tip="Run actions">' + icon("i-more") + "</button></td>" +
        "</tr>" +
        '<tr class="iz-row-detail" id="' + detailId + '"' + (open ? "" : " hidden") + '><td colspan="7"><div class="iz-row-detail__inner">' +
        '<div class="iz-grid12" style="gap:16px">' +
        '<div class="iz-col-4">' + metric("Step", esc(r.step.split("·")[0].trim()), "", esc(r.step.split("·")[1] || ""), "iz-metric--sm") + "</div>" +
        '<div class="iz-col-4">' + metric("Tokens", (r.tokensIn / 1000).toFixed(1) + "k", "in / " + (r.tokensOut / 1000).toFixed(1) + "k out", "per run", "iz-metric--sm") + "</div>" +
        '<div class="iz-col-4">' + metric("Cost", r.cost ? money(r.cost) : "—", "", "runtime spend for this run", "iz-metric--sm") + "</div>" +
        "</div>" +
        '<div class="iz-row iz-gap-12" style="margin-top:12px;flex-wrap:wrap;font-size:11px;color:var(--iz-ink-3)">' +
        '<span>Repository <span class="iz-mono" style="color:var(--iz-ink-2)">' + esc(r.repo) + "</span></span>" +
        '<span>Model <span class="iz-mono" style="color:var(--iz-ink-2)">' + esc(r.model) + "</span></span>" +
        '<span>Started <span class="iz-mono" style="color:var(--iz-ink-2)">' + esc(r.started) + "</span></span>" +
        '<span>Duration <span class="iz-mono" style="color:var(--iz-ink-2)">' + esc(r.duration) + "</span></span>" +
        '<span>Branch <span class="iz-mono" style="color:var(--iz-ink-2)">' + esc(r.branch) + "</span></span>" +
        '<span>Task ' + code(r.task, { short: true }) + " · " + esc(r.project) + "</span></div>" +
        '<p class="iz-body" style="margin-top:10px">' + esc(r.detail) + "</p>" +
        '<div class="iz-row iz-gap-12" style="margin-top:12px">' +
        '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="toast" data-arg="Run detail is out of scope in this prototype slice">' + icon("i-external") + "Open run</button>" +
        '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="copy" data-arg="' + esc(r.id) + '">' + icon("i-copy") + "Copy ID</button></div>" +
        "</div></td></tr>";
    }).join("");

    return '<div class="iz-filters">' +
      '<div class="iz-row iz-gap-12" style="flex:1;min-width:0">' +
      '<label class="iz-sr-only" for="run-filter">Filter runs</label>' +
      '<input class="iz-input iz-filters__search" id="run-filter" type="search" placeholder="Filter runs…">' +
      '<div class="iz-chips" role="group" aria-label="Filter by state">' + stateChips() + "</div></div>" +
      '<span class="iz-filters__count" id="run-count">' + rows.length + " of " + D.runs.length + " runs</span>" +
      "</div>" +
      '<div class="iz-table-wrap"><table class="iz-table" id="runs-table">' +
      '<caption class="iz-sr-only">Live runs, ' + rows.length + " of " + D.runs.length + ", sorted by " + esc(S.ui.ov.sort) + "</caption>" +
      '<colgroup><col style="width:36px"><col style="width:134px"><col><col style="width:118px"><col style="width:70px"><col style="width:88px"><col style="width:34px"></colgroup>' +
      "<thead><tr>" +
      '<th><label class="iz-check-hit"><input type="checkbox" data-act="select-all" aria-label="Select all runs"></label></th>' +
      "<th>Status</th>" +
      '<th aria-sort="' + (S.ui.ov.sort === "attention" ? "ascending" : "none") + '"><button class="iz-sortbtn" data-act="sort" data-arg="attention" data-fk="sort-attention">Run ' + icon("i-sort") + "</button></th>" +
      "<th>Agent</th>" +
      '<th class="iz-th--num" aria-sort="' + (S.ui.ov.sort === "cost" ? "descending" : "none") + '"><button class="iz-sortbtn" data-act="sort" data-arg="cost" data-fk="sort-cost">Cost ' + icon("i-sort") + "</button></th>" +
      '<th class="iz-th--num">Duration</th><th class="iz-th--actions"><span class="iz-sr-only">Actions</span></th>' +
      "</tr></thead><tbody>" +
      (body || '<tr><td colspan="7">' + emptyState("No runs match these filters", "Clear the status filters or the text filter to see the full set.", '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="clear-run-filter">Clear filters</button>', true) + "</td></tr>") +
      "</tbody></table></div>" +
      '<div class="iz-table-foot"><span id="run-bulk">0 selected</span>' +
      '<div class="iz-table-foot__right">' +
      '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="toast" data-arg="Bulk copy is disabled in the prototype">Copy IDs</button>' +
      '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="toast" data-arg="CSV export is simulated">Export CSV</button>' +
      '<span class="iz-meta">Rows 1–' + rows.length + " of " + D.runs.length + "</span></div></div>";
  }

  function stateChips() {
    var defs = [
      { s: "active", l: "Running" },
      { s: "awaiting", l: "Awaiting" },
      { s: "failed", l: "Failed" },
      { s: "queued", l: "Queued" }
    ];
    var on = S.ui.ov.filter;
    var html = defs.map(function (d) {
      var active = on.indexOf(d.s) !== -1;
      if (active) {
        return '<span class="iz-fchip is-active">' + icon("i-check", "iz-icon--12") + esc(d.l) +
          '<button data-act="filter-state" data-arg="' + d.s + '" data-fk="f-' + d.s + '" aria-label="Remove filter: ' + esc(d.l) + '">' +
          icon("i-x", "iz-icon--12") + "</button></span>";
      }
      return '<button class="iz-fchip" data-act="filter-state" data-arg="' + d.s + '" data-fk="f-' + d.s + '" aria-pressed="false">' + esc(d.l) + "</button>";
    }).join("");
    if (on.length) html += '<button class="iz-linkbtn" data-act="clear-run-filter">Clear all</button>';
    return html;
  }

  function minutesFromAge(age) {
    var h = /(\d+)h/.exec(age || ""), m = /(\d+)m/.exec(age || "");
    return (h ? Number(h[1]) : 0) * 60 + (m ? Number(m[1]) : 0);
  }

  function isoBefore(iso, mins) {
    var d = new Date(iso);
    d.setUTCMinutes(d.getUTCMinutes() - mins);
    return d.toISOString().replace(/\.\d+Z$/, "Z");
  }

  function evidenceSource(e, a) {
    var n = (e.id || "").split("_").pop();
    switch (e.kind) {
      case "test-run": return "ci://github-actions/reveilchat/backend/run/8841";
      case "diff": return "git://reveilchat/backend@" + D.branch.sha;
      case "log": return "s3://northwind-evidence/" + a.id + "/" + n + "/transcript.log";
      case "policy-eval": return "policy-engine://" + a.policies[0].id + "@" + a.requestedAt;
      case "artifact": return "s3://northwind-artifacts/" + a.id + "/" + n + "/";
      case "human-note": return "workspace://northwind/members/m.okafor/notes";
      default: return "workspace://northwind/evidence/" + e.id;
    }
  }

  function openEvidence(id) {
    var found = null, appr = null;
    S.approvals.forEach(function (a) {
      (a.evidenceItems || []).forEach(function (e) { if (e.id === id) { found = e; appr = a; } });
    });
    if (!found) { toast("warning", "Evidence record not found", id); return; }
    var produced = isoBefore(appr.requestedAt, minutesFromAge(found.age));
    var verdict = found.state === "verified" ? "Verified" : found.state === "failed" ? "Failed" : "Unverified";
    var body = '<div class="iz-row iz-row--between" style="margin-bottom:12px">' +
      '<span class="iz-code">' + esc(found.id) + "</span>" +
      pill(found.state === "verified" ? "completed" : found.state === "failed" ? "failed" : "awaiting", verdict) + "</div>" +
      '<h2 class="iz-h2" style="margin-bottom:8px">' + esc(found.label) + "</h2>" +
      '<dl class="iz-guardrail">' +
      "<dt>Producer</dt><dd>" + esc(found.producer) + "</dd>" +
      "<dt>Produced</dt><dd><time datetime=\"" + esc(produced) + "\">" + esc(produced) + "</time> · " + esc(found.age) + " before the proposal</dd>" +
      "<dt>Kind</dt><dd>" + esc(found.kind) + " · verdict " + esc(verdict.toLowerCase()) + "</dd>" +
      "<dt>Source</dt><dd><span class=\"iz-mono\">" + esc(evidenceSource(found, appr)) + "</span></dd>" +
      "<dt>Retrieval</dt><dd>In-workspace artifact · retained 400 days</dd>" +
      "<dt>Approval</dt><dd><a href=\"#/approvals/" + esc(appr.id) + "\" data-act=\"drawer-close\" style=\"text-decoration:underline\">" + esc(appr.id) + "</a></dd>" +
      "</dl>" +
      '<p class="iz-body" style="margin-top:12px"><span class="iz-meta">Claim it supports</span><br>' +
      esc("That " + appr.title.charAt(0).toLowerCase() + appr.title.slice(1) + " is safe to " + appr.actionVerb + ".") + "</p>" +
      '<div class="iz-callout" style="margin-top:12px">' + icon("i-info") +
      '<div class="iz-callout__body"><div class="iz-callout__title">Evidence is immutable</div><p class="iz-callout__text">The record is content-addressed and cannot be edited after the fact. A failed record stays visible to every reviewer.</p></div></div>' +
      '<div class="iz-row iz-gap-8" style="margin-top:16px">' +
      '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="toast" data-arg="Artifact viewer is out of scope in this prototype">' + "Open full artifact" + "</button>" +
      '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="copy" data-arg="' + esc(found.id) + '">Copy evidence ID</button></div>';
    openDrawer("Evidence · " + found.id, body);
  }

  function needsPanel() {
    var awaiting = S.approvals.filter(function (a) { return a.state === "awaiting"; });
    if (!awaiting.length) {
      return panel("", "", "", emptyState("No approvals waiting", "The queue is clear. The last decision was recorded at 04:02Z.", "", true));
    }
    var cards = awaiting.slice(0, 3).map(function (a) {
      return '<a class="iz-approval' + (a.risk.level === "critical" ? " is-critical" : "") + '" href="#/approvals/' + a.id + '">' +
        '<div class="iz-approval__top">' + riskBadge(a.risk.level, a.risk.score) + "</div>" +
        '<div class="iz-approval__title">' + esc(a.title) + "</div>" +
        '<div class="iz-approval__meta">' + avatar(a.requestedBy.avatar, { light: true }) + esc(a.requestedBy.name) + "<span>·</span><span>" + esc(a.age) + "</span>" +
        "<span>·</span>" + pill(a.state, "Awaiting") + "</div>" +
        '<div class="iz-approval__blast">' + a.blast.files + " files · " + a.blast.repos.length + " repo · " + esc(a.blast.envs.join(", ")) + "</div>" +
        '<div class="iz-approval__guard">' + esc(a.guardrails.permission) + "</div></a>";
    }).join("");
    var alerts = D.alerts.map(function (al) {
      return '<a class="ov-alert" href="#/overview">' + icon(al.kind === "degraded" ? "i-warn" : "i-clock", "iz-icon--12") +
        '<span class="ov-alert__text"><b>' + esc(al.title) + "</b> — " + esc(al.detail) + "</span>" +
        '<span class="ov-alert__age">' + esc(al.age) + "</span></a>";
    }).join("");
    return panel("", "", "",
      '<div class="iz-divide-y">' + cards + "</div>" +
      '<div class="iz-panel__head" style="min-height:32px;border-top:1px solid var(--iz-border-default)"><span class="iz-section__meta">Recent alerts</span></div>' +
      '<div class="ov-alerts">' + alerts + "</div>");
  }

  function costPanel() {
    if (S.state === "permission") {
      return panel("Cost and usage", "", "", callout("denied", "Cost data requires the Finance viewer role",
        "Your role can see run-level spend but not workspace totals. Ask M. Okafor (workspace owner) for access.", ""));
    }
    var d = D.posture.spend, m = D.posture.monthly;
    var dp = Math.round((d.today / d.ceiling) * 100), mp = Math.round((m.used / m.ceiling) * 100);
    return panel("Cost and usage", "USD · " + dp + "% of daily ceiling", '<a class="iz-linkbtn" href="#/reports">Usage detail</a>',
      '<div class="ov-cost">' +
      '<div class="ov-cost__bars">' + meter("Daily", d.today, d.ceiling, dp, "Forecast " + money(d.forecast) + " by 18:00") +
      meter("Monthly", m.used, m.ceiling, mp, "Resets 1 Dec") + "</div>" +
      distribution() +
      '<div class="iz-row iz-gap-12"><span class="iz-meta">Spend, last 7 days</span>' + spark([142, 168, 151, 204, 187, 219, 186], "Daily spend, last 7 days, 1,257 dollars total") + "</div>" +
      "</div>");
  }

  function meter(label, used, limit, pct, note) {
    var level = pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
    return '<div class="iz-meter" data-level="' + level + '">' +
      '<div class="iz-meter__top"><span class="iz-meter__val">' + money(used) + '</span><span class="iz-meter__lim">of ' + money(limit) + "</span>" +
      '<span class="iz-meter__pct">' + pct + "%</span></div>" +
      '<div class="iz-meter__track"><span class="iz-meter__fill" style="width:' + Math.min(pct, 100) + '%"></span>' +
      '<span class="iz-meter__tick" style="left:80%"></span></div>' +
      '<span class="iz-meter__note">' + esc(note) + "</span></div>";
  }

  function distribution() {
    var segs = [
      { l: "Claude Sonnet 4.5", v: 98.2, c: "var(--iz-viz-1)" },
      { l: "GPT-5.1", v: 41.6, c: "var(--iz-viz-2)" },
      { l: "Gemini 2.5 Pro", v: 26.4, c: "var(--iz-viz-3)" },
      { l: "Embeddings", v: 12.1, c: "var(--iz-viz-4)" },
      { l: "Other", v: 8.1, c: "var(--iz-viz-6)" }
    ];
    var total = segs.reduce(function (a, b) { return a + b.v; }, 0);
    var bars = segs.map(function (s) {
      return '<span class="iz-dist__seg" style="width:' + ((s.v / total) * 100).toFixed(1) + "%;background:" + s.c + '" title="' + esc(s.l) + " " + money(s.v) + '"></span>';
    }).join("");
    var key = segs.map(function (s) {
      return '<span class="iz-dist__key"><span class="iz-dist__swatch" style="background:' + s.c + '"></span>' + esc(s.l) + " " + Math.round((s.v / total) * 100) + "%</span>";
    }).join("");
    return '<div class="iz-dist"><div class="iz-dist__bar" role="img" aria-label="Spend by model: Claude Sonnet 4.5 53 percent, GPT-5.1 22 percent, Gemini 2.5 Pro 14 percent">' + bars + "</div>" +
      '<div class="iz-dist__legend">' + key + "</div></div>";
  }

  function decisionsPanel() {
    var rows = D.decisions.map(function (d) {
      return '<div class="ov-decision"><span class="ov-decision__time">' + esc(d.at) + "</span>" +
        '<span class="ov-decision__body"><b>' + esc(d.actor) + "</b> <span class=\"ov-decision__verb\">" + esc(d.verb.toLowerCase()) + "</span> " + esc(d.note) + "</span>" +
        '<span>' + (d.actorKind === "human" ? '<span class="iz-stamp">Human</span>' : d.actorKind === "policy" ? '<span class="iz-meta">policy</span>' : '<span class="iz-meta">agent</span>') + "</span></div>";
    }).join("");
    return panel("Recent decisions", "6", '<a class="iz-linkbtn" href="#/security">Audit trail</a>', '<div class="ov-decisions">' + rows + "</div>");
  }

  function fleetPanel() {
    var cards = D.agents.slice(0, 8).map(function (a) {
      return '<a class="iz-agentcard" href="#/agents/' + a.id + '">' +
        '<span class="iz-agentcard__top">' + avatar(a.avatar, { light: true }) + '<span class="iz-agentcard__name">' + esc(a.name) + "</span>" +
        '<span style="margin-left:auto">' + pill(a.state, a.stateLabel) + "</span></span>" +
        '<span class="iz-agentcard__assign">' + esc(a.assign) + "</span>" +
        '<span class="iz-agentcard__foot">' + esc(a.runtime) + "<span>·</span>" + esc(a.success) + "<span style=\"margin-left:auto\">" + esc(a.elapsed) + "</span></span></a>";
    }).join("");
    return panel("Agent fleet", "12 agents", '<a class="iz-linkbtn" href="#/agents">Registry</a>', '<div class="ov-fleet">' + cards + "</div>");
  }

  function schedulesPanel() {
    var rows = D.schedules.map(function (s) {
      return '<div class="ov-sched__row"><span class="ov-sched__name">' + esc(s.name) + "</span>" +
        '<span class="ov-sched__bar"><span class="ov-sched__fill" data-s="' + (s.state === "failed" ? "missed" : "") + '" style="left:' + s.offset + "%;width:" + s.width + '%"></span></span>' +
        '<span class="ov-sched__time">' + esc(s.next) + "</span></div>";
    }).join("");
    return panel("Schedules · next 24h", "5 schedules", '<a class="iz-linkbtn" href="#/schedules">Open</a>', '<div class="ov-sched">' + rows + "</div>");
  }

  function renderOverview() {
    if (S.state === "empty") return overviewEmpty();
    if (S.state === "loading") {
      return '<div class="iz-page">' + screenHeader("Overview", "Loading posture and runs…", "") +
        '<div class="iz-posture">' + [1, 2, 3, 4, 5].map(function () {
          return '<div class="iz-posture__cell">' + skeleton("metrics") + "</div>";
        }).join("") + "</div>" +
        '<div class="iz-grid12" style="margin-top:20px"><div class="iz-col-8">' + panel("Live runs", "", "", '<div style="padding:12px">' + skeleton("table") + "</div>") + "</div>" +
        '<div class="iz-col-4">' + panel("Needs you", "", "", '<div style="padding:12px">' + skeleton("table") + "</div>") + "</div></div></div>";
    }

    var p = D.posture;
    var awaitingCount = S.approvals.filter(function (a) { return a.state === "awaiting"; }).length;
    var postureWord = S.state === "degraded" ? "Degraded" : p.word;
    var postureState = S.state === "degraded" ? "degraded" : (S.state === "offline" ? "offline" : "nominal");
    var postureReason = S.state === "degraded"
      ? "model-router degraded: 2 of 5 providers responding"
      : S.state === "offline" ? "no heartbeat from the control plane · cached data" : p.reason;

    var runsBody;
    if (S.state === "error") {
      runsBody = '<div style="padding:16px">' + callout("error", "Could not load runs",
        "The runs service returned 503 after 3 retries. Other regions on this screen are unaffected.",
        '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="retry-region">Retry</button><button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="copy" data-arg="trace_7f2c91a4">Copy trace ID</button>') + "</div>";
    } else {
      runsBody = runsTable();
    }

    var firstRun = S.noticeDismissed ? "" : '<div class="iz-callout" style="margin-bottom:var(--iz-space-20)" role="note">' +
      icon("i-info") + '<div class="iz-callout__body"><div class="iz-callout__title">Simulated prototype — no backend</div>' +
      '<p class="iz-callout__text">Every run, cost, approval, agent, and source on these screens comes from <span class="iz-code">assets/js/data.js</span>. Interactions mutate memory only; reloading resets everything.</p>' +
      '<div class="iz-callout__actions"><button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="notice">How this works</button>' +
      '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="dismiss-notice">Dismiss</button></div></div></div>';

    return '<div class="iz-page">' +
      firstRun +
      stateBanners() +
      screenHeader("Overview",
        '<a href="#/overview">' + esc(D.workspace.id) + "</a> › " + esc(D.project.id) + " › " + esc(D.environment) +
        ' <span class="iz-sep-dot" style="color:var(--iz-ink-disabled)" aria-hidden="true"></span> <span>updated 04:19:02Z</span>',
        '<div class="iz-seg" role="group" aria-label="Time window">' +
        ["24h", "7d", "30d"].map(function (w, i) {
          return '<button class="iz-seg__opt" data-act="window" aria-pressed="' + (i === 0 ? "true" : "false") + '">' + w + "</button>";
        }).join("") + "</div>" +
        '<button class="iz-btn iz-btn--secondary" data-act="run-workflow">' + icon("i-play") + "<span>Run a workflow</span></button>") +

      '<div class="iz-posture" data-posture="' + postureState + '">' +
      '<div class="iz-posture__cell"><div class="iz-posture__posture">' + glyph(postureState === "nominal" ? "completed" : postureState, 20) +
      '<span class="iz-posture__word">' + esc(postureWord) + "</span></div>" +
      '<div class="iz-posture__sub">' + esc(postureReason) + " · since 04:12Z</div></div>" +
      '<div class="iz-posture__cell">' + metric("Live runs", String(p.activeRuns), "", (S.state === "degraded" ? "3 queued (provider backpressure)" : p.queuedRuns + " queued")) + "</div>" +
      '<div class="iz-posture__cell">' + metric("Awaiting approval", String(awaitingCount), "", "oldest 1h 04m") + "</div>" +
      '<div class="iz-posture__cell">' + metric("Failed · 24h", String(p.failed24h), "", "1 recovered after retry") + "</div>" +
      '<div class="iz-posture__cell">' + (S.state === "permission"
        ? metric("Spend today", "Restricted", "", "requires the Finance viewer role")
        : metric("Spend today", money(p.spend.today), "", "of " + money(p.spend.ceiling) + " · " + Math.round((p.spend.today / p.spend.ceiling) * 100) + "%")) + "</div>" +
      "</div>" +

      '<div class="iz-constraints"><span>Mode</span><b>' + (S.state === "degraded" ? "Copilot" : "Copilot") + "</b><span class=\"iz-sep iz-sep-dot\" aria-hidden=\"true\"></span>" +
      "<span>max risk</span><b>" + esc(D.constraints.maxRisk) + "</b><span class=\"iz-sep iz-sep-dot\" aria-hidden=\"true\"></span>" +
      "<span>budget</span><b>" + esc(D.constraints.dailyBudget) + "</b><span class=\"iz-sep iz-sep-dot\" aria-hidden=\"true\"></span>" +
      "<span>repos</span><b>" + esc(D.constraints.repos) + "</b><span class=\"iz-sep iz-sep-dot\" aria-hidden=\"true\"></span>" +
      "<span>env</span><b>" + esc(D.constraints.environment) + "</b><span class=\"iz-sep iz-sep-dot\" aria-hidden=\"true\"></span>" +
      "<span>rollback</span><b>" + esc(D.constraints.rollback) + "</b></div>" +

      '<div class="iz-grid12 ov-grid" style="margin-top:var(--iz-space-20)">' +
      '<section class="iz-col-8 iz-section" aria-labelledby="h-runs">' +
      sectionHead("Live runs", "", '<a class="iz-linkbtn" href="#/agents">All runs</a>', "h-runs") +
      panel("", "", "", runsBody) + "</section>" +
      '<section class="iz-col-4 iz-section" aria-labelledby="h-needs">' + sectionHead("Needs you", awaitingCount + " awaiting", '<a class="iz-linkbtn" href="#/approvals">View queue</a>', "h-needs") + needsPanel() + "</section>" +
      '<div class="iz-col-4">' + costPanel() + "</div>" +
      '<div class="iz-col-4">' + decisionsPanel() + "</div>" +
      '<div class="iz-col-4">' + fleetPanel() + "</div>" +
      '<div class="iz-col-12">' + schedulesPanel() + "</div>" +
      "</div></div>";
  }

  /* ------------------------------------------------------------------ */
  /* Agent Command Centre                                               */
  /* ------------------------------------------------------------------ */

  var AGENT_RANK = { failed: 0, degraded: 1, awaiting: 2, active: 3, queued: 4, offline: 5 };

  function sortedAgents() {
    var list = D.agents.slice();
    if (S.ui.ac.sort === "name") {
      list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (S.ui.ac.sort === "runtime") {
      list.sort(function (a, b) { return a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name); });
    } else {
      list.sort(function (a, b) {
        return (AGENT_RANK[a.state] - AGENT_RANK[b.state]) || a.name.localeCompare(b.name);
      });
    }
    return list;
  }

  function agentRow(a) {
    var cur = a.id === S.ui.ac.id ? ' aria-current="true"' : "";
    return '<a class="ac-row" href="#/agents/' + a.id + '"' + cur + ">" +
      '<span class="ac-row__name">' + avatar(a.avatar, { light: true }) + esc(a.name) +
      '<span style="margin-left:auto">' + pill(a.state, a.stateLabel) + "</span></span>" +
      '<span class="ac-row__assign">' + esc(a.assign) + "</span>" +
      '<span class="ac-row__foot">' + esc(a.runtime) + "<span>·</span>" + esc(a.success) +
      (a.state === "failed" ? '<span class="iz-flag">Needs intervention</span>' : "") +
      '<span class="ac-row__elapsed">' + esc(a.elapsed) + "</span></span></a>";
  }

  function agentDetailPanel(a) {
    var isAtlas = a.id === "agt_eng_04";
    var d = D.agentDetail;
    var tab = S.ui.ac.tab;
    var tabs = [
      { id: "activity", label: "Activity" },
      { id: "runs", label: "Runs" },
      { id: "artifacts", label: "Artifacts" },
      { id: "handoffs", label: "Handoffs" },
      { id: "config", label: "Config" }
    ];
    var tabbar = '<div class="iz-tabs" role="tablist" aria-label="Agent views">' + tabs.map(function (t) {
      return '<button class="iz-tab" role="tab" data-act="ac-tab" data-arg="' + t.id + '" data-fk="ac-tab-' + t.id + '" aria-selected="' + (tab === t.id ? "true" : "false") + '">' + t.label + "</button>";
    }).join("") + "</div>";

    var body = "";
    if (!isAtlas) {
      body = '<div class="ac-tabbody">' + callout("info", "Full trace is included for Atlas only",
        "This prototype slice ships a complete execution trace, logs, handoffs, and routing config for Atlas (agt_eng_04). Registry data for the other 11 agents is live in this view.",
        '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="select-atlas">Open Atlas</button>') + "</div>";
    } else if (tab === "activity") {
      body = '<div class="ac-tabbody">' +
        '<div class="ac-metrics">' + d.metrics.map(function (m) { return metric(m.label, m.value, "", m.sub, "iz-metric--sm"); }).join("") + "</div>" +
        '<div class="ac-split"><div>' +
        '<h2 class="iz-h3" style="margin-bottom:8px">Execution steps</h2>' +
        '<ol class="iz-timeline">' + d.steps.map(function (s) {
          return '<li class="iz-timeline__item" data-s="' + s.state + '"><span class="iz-timeline__time">' + (s.state === "active" ? "now" : "") + '</span><span class="iz-timeline__dot"></span>' +
            '<span class="iz-timeline__body"><span class="iz-timeline__title">' + s.n + ". " + esc(s.title) + "</span>" +
            (s.meta ? '<span class="iz-timeline__meta">' + esc(s.meta) + "</span>" : "") + "</span>" +
            '<span class="iz-timeline__dur">' + esc(s.dur) + "</span></li>";
        }).join("") + "</ol></div>" +
        '<div><h3 class="iz-h3" style="margin-bottom:8px">Tool calls</h3>' +
        '<table class="iz-table" style="min-width:0"><caption class="iz-sr-only">Recent tool calls</caption>' +
        '<colgroup><col style="width:52px"><col style="width:86px"><col><col style="width:48px"></colgroup>' +
        '<thead><tr><th scope="col">Time</th><th scope="col">Tool</th><th scope="col">Target</th><th scope="col" class="iz-th--num">Took</th></tr></thead><tbody>' +
        [["04:18:44", "read_file", "services/auth/token.ts", "8ms"],
          ["04:18:41", "apply_patch", "services/auth/rotate.ts", "41ms"],
          ["04:17:02", "run_tests", "--suite auth --shard 2", "running"],
          ["04:15:19", "grep", "refresh_token", "1.2s"],
          ["04:12:33", "read_file", "services/auth/session.ts", "6ms"]].map(function (r) {
          return '<tr><td class="iz-mono" style="font-size:11px;color:var(--iz-ink-3)">' + r[0] + '</td><td class="iz-mono" style="font-size:11px">' + esc(r[1]) + '</td><td class="iz-truncate" style="font-size:11px;color:var(--iz-ink-2)">' + esc(r[2]) + '</td><td class="iz-td--num" style="font-size:11px;color:var(--iz-ink-3)">' + esc(r[3]) + "</td></tr>";
        }).join("") + "</tbody></table></div></div>" +
        '<div><div class="iz-row iz-row--between" style="margin-bottom:6px"><h3 class="iz-h3">Log tail</h3><button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="toast" data-arg="Full log viewer opens in the run detail (out of scope here)">Open full log</button></div>' +
        '<div class="iz-log" role="log" tabindex="0" aria-label="Agent log tail">' + d.log.map(function (l) {
          return '<div class="iz-log__line"><span class="iz-log__t">' + l.t + "</span>" +
            '<span class="iz-log__lv" data-lv="' + (l.lv === "WARN" ? "WARN" : "INFO") + '">' + l.lv + "</span>" +
            '<span class="iz-log__m">' + esc(l.m) + "</span></div>";
        }).join("") + "</div></div></div>";
    } else if (tab === "runs") {
      body = '<div class="ac-tabbody">' + panel("Recent runs", d.runs.length, "",
        '<div class="iz-table-wrap"><table class="iz-table" style="min-width:440px"><caption class="iz-sr-only">Runs for Atlas</caption>' +
        '<thead><tr><th>Run</th><th>Status</th><th class="iz-th--num">Cost</th><th class="iz-th--num">Duration</th></tr></thead><tbody>' +
        d.runs.map(function (r) {
          return '<tr><td><div class="iz-stack" style="gap:1px"><span class="iz-truncate">' + esc(r.title) + "</span>" + code(r.id, { short: true }) + "</div></td>" +
            "<td>" + pill(r.state, { active: "Running", completed: "Completed", failed: "Failed" }[r.state]) + "</td>" +
            '<td class="iz-td--num">' + money(r.cost) + '</td><td class="iz-td--num">' + esc(r.dur) + "</td></tr>";
        }).join("") + "</tbody></table></div>") + "</div>";
    } else if (tab === "artifacts") {
      body = '<div class="ac-tabbody">' + panel("Artifacts", "4", "",
        '<div class="iz-table-wrap"><table class="iz-table" style="min-width:460px"><caption class="iz-sr-only">Artifacts produced by Atlas</caption>' +
        '<thead><tr><th>Artifact</th><th>Kind</th><th class="iz-th--num">Size</th><th>Verified</th></tr></thead><tbody>' +
        [["art_01JB7Q3A1", "diff · 7 files", "12.4 KB", "completed"],
          ["art_01JB7Q3B2", "test report · 214 tests", "88 KB", "completed"],
          ["art_01JB7Q3C3", "coverage · auth 91.4%", "4.1 KB", "completed"],
          ["art_01JB7Q3D4", "benchmark · p95 118ms", "2.8 KB", "awaiting"]].map(function (r) {
          return '<tr><td class="iz-mono" style="font-size:11px">' + r[0] + '</td><td style="color:var(--iz-ink-2)">' + esc(r[1]) + '</td><td class="iz-td--num">' + esc(r[2]) + "</td><td>" + pill(r[3], r[3] === "completed" ? "Verified" : "Unverified") + "</td></tr>";
        }).join("") + "</tbody></table></div>") + "</div>";
    } else if (tab === "handoffs") {
      body = '<div class="ac-tabbody">' + panel("Task handoffs", "5", "",
        '<div class="iz-table-wrap"><table class="iz-table" style="min-width:520px"><caption class="iz-sr-only">Task handoffs from and to Atlas</caption>' +
        '<thead><tr><th>From → To</th><th>Task</th><th>Reason</th><th>State</th><th class="iz-th--num">At</th></tr></thead><tbody>' +
        d.handoffs.map(function (h) {
          return "<tr><td>" + esc(h.from) + " → " + esc(h.to) + "</td><td class=\"iz-truncate\">" + esc(h.task) + "</td>" +
            '<td class="iz-ink-3">' + esc(h.reason) + "</td><td>" +
            pill(h.state === "completed" ? "completed" : h.state === "failed" ? "failed" : "awaiting", h.state.charAt(0).toUpperCase() + h.state.slice(1)) +
            '</td><td class="iz-td--num iz-ink-3">' + esc(h.at) + "</td></tr>" +
            (h.note ? '<tr><td></td><td colspan="4" class="iz-ink-3" style="font-size:11px;padding-top:0">' + esc(h.note) + "</td></tr>" : "");
        }).join("") + "</tbody></table></div>") + "</div>";
    } else {
      body = '<div class="ac-tabbody">' +
        '<div class="ac-split"><div>' +
        "<h2 class=\"iz-h3\" style=\"margin-bottom:10px\">Guardrails in force</h2>" +
        '<dl class="iz-guardrail">' +
        "<dt>Permission</dt><dd><span class=\"iz-mono\">" + esc(d.guardrails.permission) + "</span></dd>" +
        "<dt>Budget</dt><dd>" + money(d.guardrails.budget.perRun) + " / run · " + money(d.guardrails.budget.used) + " used · " + money(d.guardrails.budget.perDay) + " / day</dd>" +
        "<dt>Repositories</dt><dd>" + d.guardrails.repos.map(function (r) { return '<span class="iz-code">' + esc(r) + "</span>"; }).join(" ") + "</dd>" +
        "<dt>Environment</dt><dd><span class=\"iz-mono\">" + esc(d.guardrails.environment) + "</span></dd>" +
        "<dt>Rollback</dt><dd>" + esc(d.guardrails.rollback) + "</dd></dl>" +
        '<div class="iz-callout" style="margin-top:16px">' + icon("i-lock") + '<div class="iz-callout__body"><div class="iz-callout__title">Independent verification is enforced</div><p class="iz-callout__text">The verifier role cannot be served by the executing model. Changing the verifier requires the Platform admin role and is recorded in the audit trail.</p></div></div>' +
        "</div><div>" +
        "<h2 class=\"iz-h3\" style=\"margin-bottom:10px\">Model routing</h2>" +
        '<table class="iz-table" style="min-width:0"><caption class="iz-sr-only">Routing rules</caption><thead><tr><th scope="col">Role</th><th scope="col">Model</th></tr></thead><tbody>' +
        [["Reasoner", "claude-opus-4-5"], ["Engineer", "claude-sonnet-4-5"], ["Verifier", "gpt-5.1"], ["Fallback", "gemini-2.5-pro on 429/5xx"]].map(function (r) {
          return '<tr><td class="iz-ink-3" style="font-size:11px">' + r[0] + '</td><td class="iz-mono" style="font-size:11px">' + esc(r[1]) + "</td></tr>";
        }).join("") + "</tbody></table>" +
        '<div class="iz-row iz-gap-12" style="margin-top:12px"><button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="toast" data-arg="Routing changes require the Platform admin role">Change routing</button>' +
        '<span class="iz-meta">Last changed 2026-11-04 by M. Okafor</span></div>' +
        "</div></div></div>";
    }

    return '<div class="ac-head">' +
      '<div class="ac-head__top">' + avatar(a.avatar, { light: true, lg: true }) +
      '<div style="min-width:0"><div class="ac-head__name">' + esc(a.name) + "</div>" +
      '<div class="ac-head__meta">' + code(a.id) + "<span>·</span><span>" + esc(a.runtime) + "</span><span>·</span>" + pill(a.state, a.stateLabel) + "</div></div>" +
      '<div class="ac-head__actions">' +
      '<button class="iz-btn iz-btn--secondary" data-act="pause-agent" data-arg="' + a.id + '">' + icon("i-pause") + "<span>" + (a.state === "offline" ? "Resume" : "Pause") + "</span></button>" +
      '<button class="iz-iconbtn" data-act="agent-menu" data-arg="' + a.id + '" aria-label="More actions for ' + esc(a.name) + '" data-tip="More actions">' + icon("i-more") + "</button>" +
      "</div></div>" +
      '<div class="ac-route"><span class="ac-route__label">Route</span>' + d.route.map(function (r, i) {
        return (i ? '<span class="ac-route__arrow">→</span>' : "") +
          '<span class="ac-route__chip" title="' + esc(r.role) + '">' + esc(r.model) + "</span>";
      }).join("") + '<span class="ac-route__label" style="margin-left:6px">reasoner → engineer → verifier</span></div>' +
      "</div>" + tabbar + body;
  }

  function renderAgents() {
    var id = S.route.id || S.ui.ac.id;
    var a = D.agents.filter(function (x) { return x.id === id; })[0] || D.agents[0];
    S.ui.ac.id = a.id;

    if (S.state === "loading") {
      return '<div class="iz-page">' + screenHeader("Agent Command Centre", "Loading registry…", "") +
        '<div class="iz-grid12"><div class="iz-col-4">' + panel("", "", "", '<div style="padding:12px">' + skeleton("table") + "</div>") + "</div>" +
        '<div class="iz-col-8">' + panel("", "", "", '<div style="padding:12px">' + skeleton("table") + skeleton("table") + "</div>") + "</div></div></div>";
    }

    var listBody = S.state === "empty"
      ? emptyState("No agents registered", "An agent is a runtime plus a model route plus a permission ceiling.", '<button class="iz-btn iz-btn--primary" data-act="toast" data-arg="Agent registration is out of scope in this prototype">Register an agent</button>')
      : '<div class="ac-list"' + (window.innerWidth < 1024 ? ' role="region" tabindex="0" aria-label="Agent registry, scrollable"' : "") + ">" + sortedAgents().map(agentRow).join("") + "</div>";

    var detail = S.state === "empty"
      ? panel("", "", "", emptyState("Nothing selected", "Register an agent to see live execution, artifacts, handoffs, and routing.", "", true))
      : '<div class="ac-detail-inner">' + agentDetailPanel(a) + "</div>";

    var summary = '<div class="iz-posture" style="border-top:0">' +
      metricCell("Agents", "12", "4 runtimes") +
      metricCell("Running", S.state === "degraded" ? "3" : "7", S.state === "degraded" ? "4 queued · provider backpressure" : "2 awaiting approval") +
      metricCell("Stuck", "1", "Forge · step 4 of 9") +
      metricCell("Success · 24h", "94.1%", "118 runs") +
      metricCell("Cost today", "$412.80", "of $900 ceiling") + "</div>";

    return '<div class="iz-page" style="padding-bottom:0">' + stateBanners() +
      screenHeader("Agent Command Centre",
        "12 agents · 4 runtimes · <span>" + (S.state === "offline" ? "last heartbeat 04:12Z" : "stream connected") + "</span>",
        '<button class="iz-btn iz-btn--secondary" data-act="filter-agents">' + icon("i-filter") + "<span>Filter</span></button>" +
        '<button class="iz-btn iz-btn--primary" data-act="toast" data-arg="Agent registration is out of scope in this prototype">' + icon("i-plus") + "<span>Register agent</span></button>") +
      summary +
      '<div class="iz-fullheight ac" style="margin-top:0">' +
      '<div class="iz-pane ac-list-pane" role="region" aria-label="Agents">' +
      '<div class="iz-pane__head"><span class="iz-pane__title">Registry</span>' +
      '<button class="iz-btn iz-btn--ghost iz-btn--sm" style="margin-left:auto" data-act="ac-sort-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Sort agents, currently ' + esc(S.ui.ac.sort) + '">' +
      (S.ui.ac.sort === "attention" ? "Attention" : S.ui.ac.sort === "name" ? "Name" : "Runtime") + " " + icon("i-chev-down", "iz-icon--12") + "</button></div>" +
      '<div class="iz-pane--scroll" style="flex:1">' + listBody + "</div></div>" +
      '<div class="iz-pane iz-pane--scroll ac-detail" role="region" aria-label="Agent detail">' + detail + "</div>" +
      '<aside class="iz-pane iz-pane--scroll ac-rail" aria-label="Live activity">' +
      '<div class="ac-railhead"><span class="iz-streaming"><span class="iz-dot"></span>Streaming</span>' +
      '<span class="iz-meta" style="margin-left:auto">42 events/min</span></div>' +
      '<div class="iz-pane__body">' + activityStream() + "</div></aside>" +
      "</div></div>";
  }

  function activityStream() {
    if (S.state === "empty") return emptyState("No activity", "Events appear when an agent starts work.", "", true);
    var rows = D.activity.map(function (e, i) {
      var ic = e.kind === "fail" ? "i-warn" : e.kind === "write" ? "i-pen" : e.kind === "queue" ? "i-clock" : e.kind === "warn" ? "i-warn" : "i-check";
      return '<li class="iz-stream__row' + (i === 0 ? " is-new" : "") + '">' +
        '<span class="iz-stream__time">' + e.t + "</span>" +
        '<span class="iz-stream__glyph" style="color:' + (e.kind === "fail" ? "var(--iz-status-failed-fg)" : e.kind === "warn" ? "var(--iz-status-awaiting-fg)" : "var(--iz-ink-3)") + '">' + icon(ic, "iz-icon--12") + "</span>" +
        '<span class="iz-stream__text"><b>' + esc(e.agent) + "</b> " + e.text + "</span></li>";
    }).join("");
    return '<ol class="iz-stream" aria-live="polite" aria-label="Live agent activity">' + rows + "</ol>" +
      (S.state === "offline" ? '<div class="iz-stream__paused">Paused — 14 new events pending</div>' : "");
  }

  /* ------------------------------------------------------------------ */
  /* Approvals                                                          */
  /* ------------------------------------------------------------------ */

  function approvalById(id) {
    return S.approvals.filter(function (a) { return a.id === id; })[0];
  }

  function queueList() {
    var live = S.approvals.filter(function (a) { return a.state === "awaiting" || a.state === "blocked"; });
    if (S.ui.ap.risk !== "all") live = live.filter(function (a) { return a.risk.level === S.ui.ap.risk; });
    if (!live.length) {
      return emptyState("No approvals in this filter",
        S.ui.ap.risk === "all" ? "The queue is clear. New approvals appear when an agent proposes a material change." : "No " + S.ui.ap.risk + " risk approvals are waiting.",
        '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="ap-risk" data-arg="all">Show all</button>', true);
    }
    return live.map(function (a) {
      var cur = (S.route.id === a.id || (!S.route.id && live[0].id === a.id)) ? ' aria-current="true"' : "";
      return '<a class="iz-approval' + (a.risk.level === "critical" ? " is-critical" : "") + '" href="#/approvals/' + a.id + '" data-list-item' + cur + '>' +
        '<div class="iz-approval__top">' + riskBadge(a.risk.level, a.risk.score) +
        '<span style="margin-left:auto">' + (a.state === "blocked" ? pill("failed", "Blocked") : pill("awaiting", "Awaiting")) + "</span></div>" +
        '<div class="iz-approval__title">' + esc(a.title) + "</div>" +
        '<div class="iz-approval__meta">' + esc(a.requestedBy.name) + "<span>·</span>" + esc(a.age) + "<span>·</span>" + esc(a.blast.envs.join(", ")) + "</div>" +
        '<div class="iz-approval__blast">' + a.blast.files + " files · " + a.blast.repos.length + " repo · " + (a.blast.records ? a.blast.records.toLocaleString("en-US") + " rows" : a.blast.services.length + " services") + "</div>" +
        "</a>";
    }).join("");
  }

  function guardrailBlock(g) {
    return '<dl class="iz-guardrail">' +
      "<dt>Permission</dt><dd><span class=\"iz-mono\">" + esc(g.permission) + "</span></dd>" +
      "<dt>Budget</dt><dd>" + money(g.budget.perRun) + " / run · " + money(g.budget.used) + " used · " + money(g.budget.perDay) + " / day</dd>" +
      "<dt>Repositories</dt><dd>" + g.repos.map(function (r) { return '<span class="iz-code">' + esc(r) + "</span>"; }).join("") + "</dd>" +
      "<dt>Environment</dt><dd><span class=\"iz-mono\">" + esc(g.environment) + "</span></dd>" +
      "<dt>Rollback</dt><dd>" + esc(g.rollback) + "</dd>" +
      "</dl>";
  }

  function policyRows(list) {
    return list.map(function (p) {
      var ic = p.status === "pass" ? "i-check" : p.status === "warn" ? "i-warn" : "i-x";
      return '<div class="iz-policy" data-s="' + p.status + '">' +
        '<span class="iz-policy__icon">' + icon(ic, "iz-icon--12") + "</span>" +
        '<div><div class="iz-policy__name">' + esc(p.name) + " " + code(p.id) + "</div>" +
        '<div class="iz-policy__msg">' + esc(p.message) + "</div></div>" +
        '<span class="iz-stack" style="align-items:flex-end;gap:2px">' +
        '<span class="iz-policy__verdict" data-s="' + p.status + '">' +
        (p.status === "pass" ? "Passed" : p.status === "warn" ? "Warning" : p.status === "fail" ? "Failed" : "Skipped") +
        '</span><span class="iz-meta">' + esc(p.at) + "</span></span></div>";
    }).join("");
  }

  function diffBlock(a) {
    var open = S.ui.ap.diff;
    var head = '<div class="iz-diff__head"><span class="iz-h3" style="font-size:13px">Changes</span>' +
      '<span class="iz-diff__stat"><span class="iz-diff__add">+' + a.diff.additions + '</span><span class="iz-diff__del">−' + a.diff.deletions + "</span></span>" +
      '<span class="iz-diff__files">' + a.diff.files.length + " files</span>" +
      '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="toggle-diff" data-fk="toggle-diff" style="margin-left:8px">' + (open ? "Collapse" : "Review diff") + "</button></div>";
    if (!open) {
      var files = a.diff.files.map(function (f) {
        return '<div class="iz-diff__filehead" style="border-bottom:1px solid var(--iz-border-subtle)">' + icon("i-diff", "iz-icon--12") + esc(f.path) +
          '<span class="iz-diff__stat"><span class="iz-diff__add">+' + f.add + '</span><span class="iz-diff__del">−' + f.del + "</span></span></div>";
      }).join("");
      return '<div class="iz-diff">' + head + files + '<div class="iz-diff__more">Unified diff available on review. 3 hunks shown by default.</div></div>';
    }
    var blocks = a.diff.files.map(function (f) {
      var hunks = f.hunks.map(function (h) {
        return '<div class="iz-diff__hunk">' + esc(h.header) + "</div>" +
          h.lines.map(function (l) {
            var cls = l.t === "add" ? " iz-diff__line--add" : l.t === "del" ? " iz-diff__line--del" : "";
            return '<div class="iz-diff__line' + cls + '">' +
              '<span class="iz-diff__ln" aria-hidden="true">' + esc(l.old) + "</span>" +
              '<span class="iz-diff__ln" aria-hidden="true">' + esc(l.nw) + "</span>" +
              '<span class="iz-diff__mark" aria-hidden="true">' + (l.t === "add" ? "+" : l.t === "del" ? "−" : " ") + "</span>" +
              '<span class="iz-diff__code">' + esc(l.text) + "</span></div>";
          }).join("");
      }).join("");
      return '<div class="iz-diff__file"><div class="iz-diff__filehead">' + icon("i-diff", "iz-icon--12") + esc(f.path) +
        '<span class="iz-diff__stat"><span class="iz-diff__add">+' + f.add + '</span><span class="iz-diff__del">−' + f.del + "</span></span></div>" + hunks + "</div>";
    }).join("");
    return '<div class="iz-diff">' + head + blocks + "</div>";
  }

  function evidenceList(items) {
    return '<div class="iz-evidence">' + items.map(function (e) {
      var ic = e.kind === "test-run" ? "i-check" : e.kind === "diff" ? "i-diff" : e.kind === "log" ? "i-terminal" : e.kind === "policy-eval" ? "i-shield" : e.kind === "human-note" ? "i-user" : "i-doc";
      var verdict = e.state === "verified" ? "Verified" : e.state === "failed" ? "Failed" : "Unverified";
      var inner = '<span class="iz-evidence__icon">' + icon(ic, "iz-icon--14") + "</span>" +
        '<div><div class="iz-evidence__label">' + esc(e.label) + "</div>" +
        '<div class="iz-evidence__meta">' + esc(e.producer) + " · " + esc(e.age) + (e.id ? " · " + esc(e.id) : "") + "</div></div>" +
        '<span class="iz-evidence__state" data-s="' + e.state + '">' + verdict + "</span>";
      if (!e.id) return '<div class="iz-evidence__row">' + inner + "</div>";
      return '<button class="iz-evidence__row" data-act="open-evidence" data-arg="' + esc(e.id) + '" aria-haspopup="dialog" ' +
        'aria-label="Open evidence ' + esc(e.id) + ": " + esc(e.label) + ". " + verdict + '.">' + inner +
        '<span class="iz-evidence__open">' + icon("i-external", "iz-icon--12") + "</span></button>";
    }).join("") + "</div>";
  }

  function lineage(a) {
    return '<div class="iz-trace">' +
      '<div class="iz-trace__group"><span class="iz-trace__label">Upstream</span>' +
      '<div class="iz-trace__row">' + icon("i-doc", "iz-icon--12") + '<a href="#/approvals">' + esc(a.taskId) + "</a><span class=\"iz-trace__count\">task</span></div>" +
      '<div class="iz-trace__row">' + icon("i-nodes", "iz-icon--12") + '<span>pln_01JB7P1C4</span><span class="iz-trace__count">plan</span></div>' +
      '<div class="iz-trace__row">' + icon("i-grid", "iz-icon--12") + '<span>gol_auth-latency</span><span class="iz-trace__count">goal</span></div>' +
      "</div>" +
      '<div class="iz-trace__group"><span class="iz-trace__label">This approval</span>' +
      '<div class="iz-trace__row">' + icon("i-check-badge", "iz-icon--12") + "<b>" + esc(a.id) + "</b><span class=\"iz-trace__count\">" + esc(a.risk.level) + "</span></div>" +
      "</div>" +
      '<div class="iz-trace__group"><span class="iz-trace__label">Downstream</span>' +
      '<div class="iz-trace__row">' + icon("i-play", "iz-icon--12") + '<a href="#/overview">' + esc(a.runId) + "</a><span class=\"iz-trace__count\">run</span></div>" +
      '<div class="iz-trace__row">' + icon("i-doc", "iz-icon--12") + "<span>Artifacts</span><span class=\"iz-trace__count\">" + (a.diff.files.length + 2) + "</span></div>" +
      '<div class="iz-trace__row">' + icon("i-check", "iz-icon--12") + "<span>Evidence</span><span class=\"iz-trace__count\">" + a.evidence.total + "</span></div>" +
      '<div class="iz-trace__row">' + icon("i-shield", "iz-icon--12") + "<span>Audit entries</span><span class=\"iz-trace__count\">2 on decision</span></div>" +
      "</div></div>";
  }

  function approvalDetail(a) {
    var blocked = a.state === "blocked" || !!a.blockedReason;
    var receiving = a.received.length;
    var needMore = a.requiredApprovers > receiving;

    var facts = '<div class="ap-facts">' +
      fact("Blast radius", a.blast.files + " files · " + a.blast.repos.length + " repo") +
      fact("Records", a.blast.records ? a.blast.records.toLocaleString("en-US") : "—") +
      fact("Environment", a.blast.envs.join(", ")) +
      fact("Cost impact", a.cost.monthlyDelta === 0 ? "No change" : (a.cost.monthlyDelta < 0 ? "−" + money(Math.abs(a.cost.monthlyDelta)) + "/mo" : "+" + money(a.cost.monthlyDelta) + "/mo")) +
      "</div>";

    var actionBlock = '<section class="ap-block"><div class="ap-block__head"><h2 class="ap-block__title">What will change</h2>' +
      '<span class="ap-block__meta">' + esc(a.requestedBy.runtime) + " · " + esc(a.requestedBy.name) + "</span></div>" +
      '<p class="iz-body iz-prose">' + esc(a.summary) + "</p>" +
      '<div class="iz-row iz-gap-8" style="flex-wrap:wrap">' + a.blast.repos.map(function (r) { return '<span class="iz-code">' + esc(r) + "</span>"; }).join("") +
      '<span class="iz-meta">services: ' + esc(a.blast.services.join(", ")) + "</span></div>" +
      diffBlock(a) + "</section>";

    var policyBlock = '<section class="ap-block"><div class="ap-block__head"><h2 class="ap-block__title">Policy checks</h2>' +
      '<span class="ap-block__meta">5 evaluated · ' + a.policies.filter(function (p) { return p.status === "pass"; }).length + " passed · " +
      a.policies.filter(function (p) { return p.status !== "pass"; }).length + " need attention</span></div>" +
      '<div>' + policyRows(a.policies) + "</div></section>";

    var rollbackBlock = '<section class="ap-block"><div class="ap-block__head"><h2 class="ap-block__title">Rollback</h2>' +
      '<span class="ap-block__meta">' + (a.guardrails.rollback.indexOf("tested") !== -1 ? "Rehearsed" : "Declared") + "</span></div>" +
      '<div class="iz-callout">' + icon("i-refresh") + '<div class="iz-callout__body"><div class="iz-callout__title">' + esc(a.guardrails.rollback) + "</div>" +
      '<p class="iz-callout__text">Recovery is a condition of approval. If the rollback path is unavailable at execution time, the run stops rather than proceeds.</p></div></div></section>';

    var evidenceBlock = '<section class="ap-block"><div class="ap-block__head"><h2 class="ap-block__title">Evidence</h2>' +
      '<span class="ap-block__meta">' + a.evidence.total + " items · " + a.evidence.verified + " verified · " + a.evidence.failed + " failed · " + a.evidence.unverified + " unverified</span></div>" +
      evidenceList(a.evidenceItems) + "</section>";

    var auditBlock = '<section class="ap-block"><div class="ap-block__head"><h2 class="ap-block__title">Audit history</h2>' +
      '<span class="ap-block__meta">append-only</span></div><div class="ap-audit">' +
      a.audit.map(function (r) {
        return '<div class="ap-audit__row"><span class="ap-audit__t">' + esc(r.at) + '</span><span class="ap-audit__ev">' + esc(r.text) + "</span></div>";
      }).join("") + "</div></section>";

    var bar;
    var decided = a.state === "approved" || a.state === "rejected" || a.state === "changes";
    if (S.state === "permission") {
      bar = '<div class="ap-decisionbar">' + callout("denied", "Approving requires the Approver role",
        "You can read the proposal, diff, evidence, and audit trail. Ask M. Okafor (workspace owner) for the Approver role.", "") + "</div>";
    } else if (decided) {
      var verb = a.state === "approved" ? "Approved" : a.state === "rejected" ? "Rejected" : "Changes requested";
      bar = '<div class="ap-decisionbar"><span class="ap-decisionbar__note"><span class="iz-stamp">' + verb + '</span><span>Recorded by ' + esc(D.user.name) + " · 04:22Z · evidence hash 9f3c…a21e</span></span>" +
        '<button class="iz-btn iz-btn--secondary" data-act="toast" data-arg="Decision record export is simulated">Export decision record</button></div>';
    } else if (blocked) {
      bar = '<div class="ap-decisionbar"><span class="ap-decisionbar__note">' + icon("i-lock", "iz-icon--12") +
        "<span><b>Blocked</b> — " + esc(a.blockedReason || "A policy check failed. Approval is not possible until it is remediated.") + "</span></span>" +
        '<button class="iz-btn iz-btn--secondary" data-act="toast" data-arg="Ask the requesting agent to revise and resubmit">Ask for revision</button>' +
        '<button class="iz-btn iz-btn--primary" disabled aria-describedby="blocked-reason">Approve</button></div>';
    } else {
      bar = '<div class="ap-decisionbar">' +
        '<span class="ap-decisionbar__note">' + icon(a.risk.level === "critical" ? "i-warn" : "i-info", "iz-icon--12") + "<span>" +
        (needMore ? "<b>Approval " + (receiving + 1) + " of " + a.requiredApprovers + "</b> — second approver: S. Idris (Release)" : "Single approver required · recorded in the audit trail") +
        "</span></span>" +
        '<button class="iz-btn iz-btn--ghost" data-act="changes">Request changes</button>' +
        '<button class="iz-btn iz-btn--danger-ghost" data-act="reject">Reject</button>' +
        '<button class="iz-btn iz-btn--primary" data-act="approve">' + (a.actionVerb === "merge" ? "Approve merge" : a.actionVerb === "delete" ? "Approve deletion" : "Approve") + "</button></div>";
    }

    return '<div class="ap-scroll">' +
      '<div class="ap-titleblock">' +
      '<div class="ap-titleblock__id">' + code(a.id, { copy: true }) + riskBadge(a.risk.level, a.risk.score) +
      (blocked ? pill("failed", "Blocked") : pill("awaiting", "Awaiting approval")) +
      '<span style="margin-left:auto" class="iz-meta">' + esc(a.age) + " old</span></div>" +
      '<h2 class="ap-titleblock__title">' + esc(a.title) + "</h2>" +
      '<p class="ap-action">' + esc(a.summary) + "</p>" +
      '<div class="iz-row iz-gap-8" style="font-size:12px;color:var(--iz-ink-3);flex-wrap:wrap;row-gap:4px">' + avatar(a.requestedBy.avatar, { light: true }) +
      '<span>Requested by <b style="font-weight:500;color:var(--iz-ink-1)">' + esc(a.requestedBy.name) + "</b></span>" +
      '<span class="iz-mono" style="font-size:11px">' + esc(a.requestedBy.agentId) + "</span>" +
      '<span aria-hidden="true">·</span><time datetime="' + esc(a.requestedAt) + '">' + esc(a.age) + " ago</time>" +
      '<span aria-hidden="true">·</span><span>run <span class="iz-mono" style="font-size:11px">' + esc(a.runId) + "</span></span></div>" +
      facts + "</div>" +
      '<section class="ap-block" style="padding-top:16px"><div class="ap-block__head"><h2 class="ap-block__title">Guardrails in force</h2>' +
      '<span class="ap-block__meta">declared by the workflow</span></div>' + guardrailBlock(a.guardrails) + "</section>" +
      actionBlock + policyBlock + rollbackBlock + evidenceBlock + auditBlock +
      "</div>" + bar;
  }

  function fact(label, value) {
    return '<div class="ap-fact"><div class="ap-fact__label">' + esc(label) + '</div><div class="ap-fact__value">' + esc(value) + "</div></div>";
  }

  function renderApprovals() {
    if (S.state === "empty") {
      return '<div class="iz-page">' + screenHeader("Approvals", "0 awaiting · median decision 18m", "") +
        '<div class="iz-grid12"><div class="iz-col-5">' + panel("Queue", "0", "", emptyState("No approvals waiting",
          "The queue was cleared at 04:02Z by M. Okafor. Approvals appear when an agent proposes a material change.",
          '<button class="iz-btn iz-btn--secondary" data-act="run-workflow">Run a workflow</button>', true)) + "</div>" +
        '<div class="iz-col-7">' + panel("Approval detail", "", "", emptyState("Select an approval", "The detail view shows the action, blast radius, guardrails, policy checks, diff, evidence, and audit history.", "", true)) + "</div></div></div>";
    }

    var live = S.approvals.filter(function (a) { return a.state === "awaiting" || a.state === "blocked"; });
    var a = S.route.id ? approvalById(S.route.id) : live[0];
    if (!a) a = live[0];

    var queueCount = live.filter(function (x) { return x.state === "awaiting"; }).length;
    var oldest = live.length ? live[0].age : "—";

    var detailHtml;
    if (S.state === "loading") {
      detailHtml = '<div class="ap-scroll">' + skeleton("metrics") + '<div style="height:16px"></div>' + skeleton("table") + "</div>";
    } else if (S.state === "error") {
      detailHtml = '<div class="ap-scroll">' + callout("error", "Could not load approval detail",
        "The approvals service returned 504 after 30s. The queue is showing cached data; evidence cannot be verified.",
        '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="retry-region">Retry</button>') + "</div>";
    } else if (!a) {
      detailHtml = emptyState("Queue is clear", "No approvals are waiting. Decisions are recorded in the audit trail.", "", false);
    } else {
      detailHtml = approvalDetail(a);
    }

    var rail = "";
    if (a && S.state !== "error" && S.state !== "loading") {
      var evTab = S.ui.ap.rail === "evidence";
      rail = '<div class="iz-pane__head" style="padding:0 12px">' +
        '<div class="iz-tabs" style="border-bottom:0;flex:1" role="tablist" aria-label="Evidence or lineage">' +
        '<button class="iz-tab" role="tab" data-act="ap-rail" data-arg="evidence" data-fk="ap-rail-evidence" aria-selected="' + (evTab ? "true" : "false") + '">Evidence</button>' +
        '<button class="iz-tab" role="tab" data-act="ap-rail" data-arg="lineage" data-fk="ap-rail-lineage" aria-selected="' + (!evTab ? "true" : "false") + '">Lineage</button></div></div>' +
        '<div class="ap-rail__body">' + (evTab
          ? '<div class="ap-evhead"><b>' + a.evidence.total + " items</b><span>·</span>" + a.evidence.verified + " verified<span>·</span><span style=\"color:var(--iz-status-failed-fg)\">" + a.evidence.failed + " failed</span><span>·</span>" + a.evidence.unverified + " unverified</div>" +
            evidenceList(a.evidenceItems)
          : lineage(a)) + "</div>";
    }

    var riskDefs = ["all", "critical", "high", "medium"];
    return '<div class="iz-page ap-page" style="padding-bottom:0">' + stateBanners() +
      screenHeader("Approvals",
        queueCount + " awaiting · 1 blocked · oldest " + esc(oldest) + " · <span>median decision 18m</span>",
        '<div class="iz-seg" role="group" aria-label="Filter by risk">' + riskDefs.map(function (r) {
          return '<button class="iz-seg__opt" data-act="ap-risk" data-arg="' + r + '" data-fk="ap-risk-' + r + '" aria-pressed="' + (S.ui.ap.risk === r ? "true" : "false") + '">' + (r === "all" ? "All" : r.charAt(0).toUpperCase() + r.slice(1)) + "</button>";
        }).join("") + "</div>" +
        '<button class="iz-btn iz-btn--secondary" data-act="assign-me">' + icon("i-user") + "<span>Assign to me</span></button>") +
      '<div class="iz-fullheight ap">' +
      '<nav class="iz-pane iz-pane--queue ap-queue" aria-label="Approval queue">' +
      '<div class="iz-pane__head"><span class="iz-pane__title">Queue</span><span class="iz-meta" style="margin-left:auto">risk ↓</span></div>' +
      '<div class="ap-queue__list" id="ap-queue-list">' + queueList() + "</div>" +
      '<div class="ap-queue__foot">' + icon("i-info", "iz-icon--12") + "<span>No bulk approve. Each decision is recorded individually.</span></div></nav>" +
      '<section class="iz-pane ap-main" aria-label="Approval detail">' + detailHtml + "</section>" +
      '<aside class="iz-pane ap-rail" aria-label="Evidence">' + rail + "</aside>" +
      "</div></div>";
  }

  /* ------------------------------------------------------------------ */
  /* Research Lab                                                       */
  /* ------------------------------------------------------------------ */

  function campaignRow(c) {
    var cur = c.id === S.route.id ? ' aria-current="true"' : "";
    return '<a class="rl-row" href="#/research/' + c.id + '"' + cur + ' data-list-item>' +
      '<span class="rl-row__title">' + esc(c.title) + "</span>" +
      '<span class="rl-row__meta">' + pill(c.state, c.stateLabel) + "<span>·</span>" + c.findings + " findings</span>" +
      '<span class="rl-row__meta">' + c.conf.toFixed(2) + " " + (c.conf >= 0.8 ? "High" : c.conf >= 0.6 ? "Moderate" : "Low") + " avg · " + c.coverage + "%" + (c.gaps ? " · " + c.gaps + " gaps" : "") + "</span></a>";
  }

  function sourceRow(s) {
    return '<div class="iz-source">' +
      '<button class="iz-source__title" data-act="toast" data-arg="External sources open in a new tab in the real product">' + esc(s.title) + "</button>" +
      '<div class="iz-source__meta"><span class="iz-source__domain">' + esc(s.domain) + "</span><span>·</span><span>" + esc(s.type) + "</span><span>·</span><span>pub " + esc(s.published) + "</span></div>" +
      '<div class="iz-source__meta"><span>retrieved ' + esc(s.retrieved) + '</span><span>·</span>' +
      '<span style="color:' + (s.statusKind === "failed" ? "var(--iz-status-failed-fg)" : s.statusKind === "warn" ? "var(--iz-status-awaiting-fg)" : "var(--iz-status-completed-fg)") + '">' + esc(s.status) + "</span>" +
      (s.note ? '<span>·</span><span style="color:var(--iz-ink-3)">' + esc(s.note) + "</span>" : "") + "</div></div>";
  }

  function renderResearch() {
    var c = D.campaign;
    var selectedId = S.route.id || c.id;
    var isFull = selectedId === c.id;
    var row = D.campaigns.filter(function (x) { return x.id === selectedId; })[0] || D.campaigns[0];

    if (S.state === "loading") {
      return '<div class="iz-page">' + screenHeader("Research Lab", "Loading campaigns…", "") +
        '<div class="iz-grid12"><div class="iz-col-4">' + panel("", "", "", '<div style="padding:12px">' + skeleton("table") + "</div>") + "</div>" +
        '<div class="iz-col-8">' + panel("", "", "", '<div style="padding:12px">' + skeleton("table") + skeleton("table") + "</div>") + "</div></div></div>";
    }

    var listBody = S.state === "empty"
      ? emptyState("No research campaigns", "A campaign is a question, a retrieval window, and a budget. Findings appear as sources are verified.", '<button class="iz-btn iz-btn--primary" data-act="toast" data-arg="Campaign creation is out of scope in this prototype">New campaign</button>')
      : D.campaigns.map(campaignRow).join("");

    var detail;
    if (!isFull) {
      detail = '<div class="rl-head"><h2 class="rl-head__q">' + esc(row.title) + "</h2>" +
        '<div class="rl-head__meta">' + pill(row.state, row.stateLabel) + "<span>·</span>" + row.findings + " findings<span>·</span>window " + esc(row.window) + "<span>·</span>" + esc(row.budget) + "</div></div>" +
        '<div class="rl-body" style="padding-top:16px">' + callout("info", "Detailed evidence set is included for one campaign",
          "This slice ships the full findings ledger, source provenance, coverage gaps, and comparison table for the runtime adapter campaign. Other campaigns show registry data.",
          '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="open-campaign" data-arg="cmp_01JB6R2T8K">Open runtime comparison</button>') + "</div>";
    } else {
      var gaps = c.gaps.map(function (g) {
        return '<div class="rl-gap">' + icon("i-warn", "iz-icon--12") +
          '<span><b>' + esc(g.title) + "</b> — " + esc(g.detail) + '<span class="rl-gap__mit">Mitigation: ' + esc(g.mit) + "</span></span></div>";
      }).join("");

      var findings = D.findings.filter(function (f) {
        return !S.ui.rl.filter.length || S.ui.rl.filter.indexOf(f.state) !== -1;
      });

      var fRows = findings.map(function (f) {
        var sel = f.id === S.ui.rl.finding;
        var stateMap = { supported: ["completed", "Supported"], contested: ["awaiting", "Contested"], gap: ["degraded", "Coverage gap"], insufficient: ["failed", "Insufficient"] };
        var st = stateMap[f.state];
        return '<button class="rl-frow' + (sel ? " is-selected" : "") + '" data-act="pick-finding" data-arg="' + f.id + '" data-fk="fnd-' + f.id + '">' +
          '<span class="rl-frow__claim">' + esc(f.claim) + "</span>" +
          '<span class="rl-frow__meta">' + pill(st[0], st[1]) + conf(f.conf, f.band, f.sources) +
          '<span class="iz-meta" style="margin-left:auto">verified ' + esc(f.verified) + "</span></span></button>";
      }).join("");

      var fd = D.findingDetail;
      var tab = S.ui.rl.tab;
      var tabBody = "";
      if (tab === "supporting") {
        tabBody = evidenceList(fd.supporting);
      } else if (tab === "contradicting") {
        tabBody = '<div class="rl-contra">' + fd.disconfirming.map(function (d2) {
          return '<div class="rl-contra__item">' + icon("i-warn", "iz-icon--12") + "<span>" + esc(d2.claim) + "</span>" +
            '<span class="rl-contra__strength">' + esc(d2.strength) + "</span></div>";
        }).join("") + "</div>";
      } else {
        tabBody = '<div class="iz-stack iz-gap-12"><div><span class="iz-meta">Reasoning</span><p class="iz-body">' + esc(fd.reasoning) + "</p></div>" +
          '<div><span class="iz-meta">Assumptions</span><ul style="list-style:disc;padding-left:18px;font-size:12px;color:var(--iz-ink-2)">' +
          fd.assumptions.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul></div>" +
          '<div><span class="iz-meta">What would change this finding</span><p class="iz-body">' + esc(fd.whatWouldChangeIt) + "</p></div></div>";
      }

      var comparison = '<div class="iz-table-wrap" role="region" tabindex="0" aria-label="Runtime comparison, scrollable"><table class="iz-table rl-compare" style="min-width:640px"><caption class="iz-sr-only">Runtime comparison across six criteria</caption>' +
        "<thead><tr><th>Criterion</th>" + c.comparison.vendors.map(function (v) { return "<th>" + esc(v) + "</th>"; }).join("") + "</tr></thead><tbody>" +
        c.comparison.rows.map(function (r) {
          return "<tr><th scope=\"row\" style=\"font-weight:500;color:var(--iz-ink-1)\">" + esc(r.c) + "</th>" +
            r.v.map(function (v, i) {
              return "<td" + (r.thin[i] ? ' class="rl-thin" title="Fewer than 3 sources — treat as indicative"' : "") + ">" + esc(v) + "</td>";
            }).join("") + "</tr>";
        }).join("") + "</tbody></table></div>";

      detail = '<div class="rl-head">' +
        '<div class="iz-row iz-gap-8" style="flex-wrap:wrap">' + code(c.id, { copy: true }) + pill("active", "Active") +
        '<span class="iz-meta" style="margin-left:auto">retrieval window ' + esc(c.window.from) + " → " + esc(c.window.to) + "</span></div>" +
        '<h2 class="rl-head__q">' + esc(c.question) + "</h2>" +
        '<div class="rl-head__meta">' + avatar(c.owner.avatar, { light: true }) + "<span>Sift · Pi runtime</span><span>·</span><span>" + esc(c.window.days) + " day window</span>" +
        "<span>·</span>" + meterInline(c.budget) + "</div></div>" +
        '<div class="rl-body">' +
        '<div class="rl-coverage">' +
        '<div class="rl-coverage__cell">' + metric("Coverage", "78%", "", "was 84% on 09 Nov · 3 gaps", "iz-metric--sm") + "</div>" +
        '<div class="rl-coverage__cell" style="padding-left:16px">' + metric("Sources", "42", "", "11 primary · 19 domains", "iz-metric--sm") + "</div>" +
        '<div class="rl-coverage__cell" style="padding-left:16px">' + metric("Freshness", "0.81", "", "6 older than 30d", "iz-metric--sm") + "</div>" +
        '<div class="rl-coverage__cell" style="padding-left:16px">' + metric("Independence", "19", "domains", "top domain 12%", "iz-metric--sm") + "</div>" +
        "</div>" +
        '<section><div class="iz-row iz-row--between" style="margin-bottom:8px"><h2 class="iz-h3">Known gaps · 3</h2>' +
        '<button class="iz-btn iz-btn--ghost iz-btn--sm" data-act="research-rail" data-arg="coverage">Open coverage</button></div>' +
        '<div class="rl-gaps">' + gaps + "</div></section>" +
        '<section><div class="iz-row iz-row--between" style="margin-bottom:8px"><h2 class="iz-h3">Findings ledger</h2>' +
        '<div class="iz-chips" role="group" aria-label="Filter findings">' +
        [["", "All"], ["supported", "Supported"], ["contested", "Contested"], ["gap", "Gaps"]].map(function (f) {
          var on = f[0] === "" ? !S.ui.rl.filter.length : S.ui.rl.filter.indexOf(f[0]) !== -1;
          return '<button class="iz-fchip" data-act="finding-filter" data-arg="' + f[0] + '" data-fk="ff-' + (f[0] || "all") + '" aria-pressed="' + (on ? "true" : "false") + '" style="' + (on ? "background:var(--iz-color-surface-3);color:var(--iz-ink-1)" : "") + '">' + f[1] + "</button>";
        }).join("") + "</div></div>" +
        '<div class="rl-findings" role="group" aria-label="Findings ledger, 6 claims">' +
        (fRows || emptyState("No findings match this filter", "Clear the filter to see all 6 claims.", "", true)) + "</div></section>" +
        '<section class="rl-finding" aria-label="Selected finding">' +
        '<div class="iz-row iz-gap-8" style="flex-wrap:wrap"><h2 class="iz-h3" style="font-size:13px">Selected finding</h2>' +
        '<span class="iz-meta" style="margin-left:auto">' + code(fd.id, { short: true }) + "</span></div>" +
        '<p class="rl-finding__claim">' + esc(fd.claim) + "</p>" +
        '<div class="rl-finding__row">' + conf(fd.conf, fd.band, fd.sources) + '<span style="color:var(--iz-ink-disabled)">·</span>' +
        '<span class="iz-meta">oldest source ' + esc(fd.oldest) + "</span></div>" +
        '<div class="iz-tabs" style="margin-top:4px" role="tablist" aria-label="Finding detail">' +
        [["supporting", "Supporting " + fd.supporting.length], ["contradicting", "Contradicting " + fd.disconfirming.length], ["method", "Method"]].map(function (t) {
          return '<button class="iz-tab" role="tab" data-act="rl-tab" data-arg="' + t[0] + '" data-fk="rl-tab-' + t[0] + '" aria-selected="' + (tab === t[0] ? "true" : "false") + '">' + t[1] + "</button>";
        }).join("") + "</div>" + tabBody + "</section>" +
        '<section><h2 class="iz-h3" style="margin-bottom:8px">Comparison</h2>' + comparison + "</section>" +
        "</div>";
    }

    var rail = "";
    if (isFull && S.state !== "loading" && S.state !== "error") {
      var srcTab = S.ui.rl.rail === "sources";
      var bad = D.sources.filter(function (s) { return s.group === "bad"; });
      var warn = D.sources.filter(function (s) { return s.group === "warn"; });
      var ok = D.sources.filter(function (s) { return s.group === "ok"; });
      var body = srcTab
        ? '<div class="ap-evhead"><b>42 sources</b><span>·</span><span style="color:var(--iz-status-failed-fg)">2 unreachable</span><span>·</span><span style="color:var(--iz-status-awaiting-fg)">6 stale</span><span>·</span>1 paywalled</div>' +
          '<div class="iz-src-group iz-src-group--bad"><div class="iz-src-group__label">' + icon("i-warn", "iz-icon--12") + "Unreachable · 2</div>" + bad.map(sourceRow).join("") + "</div>" +
          '<div class="iz-src-group iz-src-group--warn"><div class="iz-src-group__label">' + icon("i-clock", "iz-icon--12") + "Stale · 2 shown of 6</div>" + warn.map(sourceRow).join("") + "</div>" +
          '<div class="iz-src-group"><div class="iz-src-group__label" style="color:var(--iz-ink-3)">' + icon("i-check", "iz-icon--12") + "Retrieved · 6 of 34</div>" + ok.map(sourceRow).join("") + "</div>"
        : '<div class="iz-stack iz-gap-12">' + c.gaps.map(function (g, i) {
            return '<div class="iz-callout"><span class="iz-callout__icon">' + icon("i-warn") + '</span><div class="iz-callout__body"><div class="iz-callout__title">Gap ' + (i + 1) + " · " + esc(g.title) + '</div><p class="iz-callout__text">' + esc(g.mit) + "</p></div></div>";
          }).join("") +
          '<div class="iz-callout"><span class="iz-callout__icon">' + icon("i-info") + '</span><div class="iz-callout__body"><div class="iz-callout__title">Freshness 0.81</div><p class="iz-callout__text">6 of 42 sources are older than 30 days; 2 are older than 180 days. Oldest is 375 days.</p></div></div>' +
          '<div class="iz-callout"><span class="iz-callout__icon">' + icon("i-info") + '</span><div class="iz-callout__body"><div class="iz-callout__title">Independence</div><p class="iz-callout__text">42 sources across 19 domains. The top domain contributes 12%, below the 25% warning threshold.</p></div></div></div>';

      rail = '<div class="iz-pane__head" style="padding:0 12px"><div class="iz-tabs" style="border-bottom:0;flex:1" role="tablist" aria-label="Sources or coverage">' +
        '<button class="iz-tab" role="tab" data-act="research-rail" data-arg="sources" data-fk="rr-sources" aria-selected="' + (srcTab ? "true" : "false") + '">Sources</button>' +
        '<button class="iz-tab" role="tab" data-act="research-rail" data-arg="coverage" data-fk="rr-coverage" aria-selected="' + (!srcTab ? "true" : "false") + '">Coverage</button></div></div>' +
        '<div class="ap-rail__body">' + body + "</div>";
    }

    return '<div class="iz-page" style="padding-bottom:0">' + stateBanners() +
      screenHeader("Research Lab",
        "9 campaigns · 3 with coverage gaps · <span>retrieval window closes 2026-11-12</span>",
        '<button class="iz-btn iz-btn--secondary" data-act="toast" data-arg="Campaign creation is out of scope in this prototype">' + icon("i-plus") + "<span>New campaign</span></button>") +
      '<div class="iz-fullheight rl">' +
      '<nav class="iz-pane iz-pane--queue rl-list" aria-label="Research campaigns" style="border-right:1px solid var(--iz-border-default)">' +
      '<div class="iz-pane__head"><span class="iz-pane__title">Campaigns</span><span class="iz-meta" style="margin-left:auto">active ↓</span></div>' +
      '<div class="iz-pane--scroll" style="flex:1">' + listBody + "</div></nav>" +
      '<section class="iz-pane iz-pane--scroll rl-detail" aria-label="Campaign detail">' + detail + "</section>" +
      '<aside class="iz-pane rl-rail" aria-label="Sources">' + rail + "</aside>" +
      "</div></div>";
  }

  function meterInline(b) {
    var pct = Math.round((b.used / b.ceiling) * 100);
    return '<span class="iz-row" style="gap:6px"><span>' + money(b.used) + " of " + money(b.ceiling) + "</span>" +
      '<span class="iz-meter__track" style="width:80px"><span class="iz-meter__fill" style="width:' + pct + '%"></span></span>' +
      "<span>" + pct + "%</span></span>";
  }

  /* ------------------------------------------------------------------ */
  /* States + placeholder modules                                       */
  /* ------------------------------------------------------------------ */

  var STATE_DEFS = [
    { id: "live", name: "Live data", desc: "Default fixtures. Nothing is fetched; everything is simulated." },
    { id: "empty", name: "Empty", desc: "First-run / cleared state for every region." },
    { id: "loading", name: "Loading", desc: "Skeletons at final dimensions. Held so it can be inspected." },
    { id: "error", name: "Error", desc: "Region-level failure with retry and trace id." },
    { id: "permission", name: "Permission denied", desc: "Role-restricted regions and actions, with the required role named." },
    { id: "offline", name: "Offline", desc: "Cached data, queued decisions, reconnect affordance." },
    { id: "degraded", name: "Degraded", desc: "A dependency below contract; posture and affected rows change." }
  ];

  function renderStates() {
    return '<div class="iz-page">' +
      screenHeader("State inspector", "Demonstrate every surface state with real fixtures, without a backend.", "") +
      '<div class="iz-callout" style="margin-bottom:20px">' + icon("i-info") +
      '<div class="iz-callout__body"><div class="iz-callout__title">How this works</div>' +
      '<p class="iz-callout__text">Selecting a state applies it to the current screen and shows a persistent preview bar. Loading is held rather than resolved so the skeleton can be inspected. Live data returns instantly.</p></div></div>' +
      '<div class="iz-states-grid">' + STATE_DEFS.map(function (s2) {
        return '<button class="iz-statecard" data-act="state-set" data-arg="' + s2.id + '" aria-pressed="' + (S.state === s2.id ? "true" : "false") + '">' +
          '<span class="iz-row iz-gap-8"><span class="iz-statecard__name">' + esc(s2.name) + "</span>" +
          (S.state === s2.id ? '<span class="iz-badge iz-badge--awaiting" style="margin-left:auto">active</span>' : "") + "</span>" +
          '<span class="iz-statecard__desc">' + esc(s2.desc) + "</span></button>";
      }).join("") + "</div>" +
      '<h2 class="iz-h3" style="margin:24px 0 8px">Where each state is demonstrated</h2>' +
      '<div class="iz-table-wrap" role="region" tabindex="0" aria-label="State coverage per screen, scrollable"><table class="iz-table" style="min-width:560px"><caption class="iz-sr-only">State coverage per screen</caption>' +
      '<thead><tr><th>State</th><th>Overview</th><th>Agent CC</th><th>Approvals</th><th>Research Lab</th></tr></thead><tbody>' +
      ["empty", "loading", "error", "permission", "offline", "degraded"].map(function (st) {
        return "<tr><td>" + pill(st === "permission" ? "offline" : st === "empty" ? "queued" : st === "loading" ? "queued" : st === "error" ? "failed" : st === "offline" ? "offline" : "degraded", st) + "</td>" +
          "<td>empty list, skeleton, region error, denied cost panel, banner, posture change</td><td>empty registry, skeleton, detail error, read-only actions, stream paused, routing fallback</td>" +
          "<td>cleared queue, skeleton, 504 with no evidence, read-only decision bar, queued decisions, blocked critical</td>" +
          "<td>no campaigns, skeleton, incomplete evidence set, restricted titles, cached corpus, stale sources</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }

  function renderPlaceholder(mod) {
    var m = MODULES[mod] || { label: mod, purpose: "" };
    return '<div class="iz-page">' + screenHeader(m.label, "Module specified in <span>INFORMATION-ARCHITECTURE.md</span> · not built in this prototype slice", "") +
      panel("", "", "", '<div style="padding:24px">' + emptyState(m.label + " is not part of this slice",
        m.purpose + ". The navigation, scope model, and component inventory are complete; this prototype implements the four screens specified in BRIEF.md §3: Overview, Agent Command Centre, Approvals, and Research Lab.",
        '<a class="iz-btn iz-btn--secondary" href="#/overview">Back to Overview</a><a class="iz-btn iz-btn--ghost" href="#/states">Open state inspector</a>') + "</div>") + "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Overlays: toast, tooltip, menu, drawer                             */
  /* ------------------------------------------------------------------ */

  function toast(sev, title, desc, actionLabel, actionFn) {
    var root = document.getElementById("toast-root");
    while (root.children.length >= 3) root.removeChild(root.firstChild);
    var el = document.createElement("div");
    el.className = "iz-toast";
    el.setAttribute("data-sev", sev);
    el.setAttribute("role", sev === "error" ? "alert" : "status");
    var ic = sev === "success" ? "i-check" : sev === "error" ? "i-warn" : sev === "warning" ? "i-warn" : "i-info";
    el.innerHTML = '<span class="iz-toast__icon">' + icon(ic) + "</span>" +
      "<div><div class=\"iz-toast__title\">" + esc(title) + "</div>" +
      (desc ? '<div class="iz-toast__desc">' + esc(desc) + "</div>" : "") +
      (actionLabel ? '<div class="iz-toast__action"><button class="iz-btn iz-btn--secondary iz-btn--sm" data-toast-action>' + esc(actionLabel) + "</button></div>" : "") +
      "</div>" +
      '<button class="iz-iconbtn" data-act="toast-close" aria-label="Dismiss notification">' + icon("i-x") + "</button>";
    root.appendChild(el);
    var timer = setTimeout(function () { if (el.parentNode) el.remove(); }, actionLabel ? 8000 : 5000);
    el.querySelector("[data-act='toast-close']").addEventListener("click", function () { clearTimeout(timer); el.remove(); });
    if (actionLabel && actionFn) {
      el.querySelector("[data-toast-action]").addEventListener("click", function () { clearTimeout(timer); el.remove(); actionFn(); });
    }
  }

  var tipEl = null, tipTimer = null;
  function showTip(target) {
    var text = target.getAttribute("data-tip");
    if (!text) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      if (!tipEl) { tipEl = document.getElementById("tip"); }
      tipEl.innerHTML = esc(text);
      tipEl.hidden = false;
      var r = target.getBoundingClientRect();
      var tr = tipEl.getBoundingClientRect();
      var left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8));
      var top = r.bottom + 6;
      if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 6;
      tipEl.style.left = left + "px";
      tipEl.style.top = top + "px";
    }, 380);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) tipEl.hidden = true;
  }

  var menuEl = null, menuAnchor = null, menuJustOpened = false;
  function closeMenuIfStale() {
    if (menuEl && !menuJustOpened) closeMenu();
    menuJustOpened = false;
  }

  function closeMenu() {
    if (menuAnchor) menuAnchor.setAttribute("aria-expanded", "false");
    if (menuEl) { menuEl.remove(); menuEl = null; }
    menuAnchor = null;
  }
  function openMenu(anchor, items) {
    closeMenu();
    var el = document.createElement("div");
    el.className = "iz-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = items.map(function (it) {
      if (it.sep) return '<div class="iz-menu__sep"></div>';
      if (it.label && it.heading) return '<div class="iz-menu__label">' + esc(it.label) + "</div>";
      var inner = (it.icon ? icon(it.icon) : "") + "<span>" + esc(it.label) + "</span>" +
        (it.checked ? '<span class="iz-menu__check">' + icon("i-check") + "</span>" : "") +
        (it.kbd ? '<span class="iz-menu__kbd">' + esc(it.kbd) + "</span>" : "");
      if (it.href) return '<a class="iz-menu__item' + (it.danger ? " iz-menu__item--danger" : "") + '" href="' + it.href + '" role="menuitem">' + inner + "</a>";
      return '<button class="iz-menu__item' + (it.danger ? " iz-menu__item--danger" : "") + '" role="menuitem" data-act="' + (it.act || "noop") + '"' + (it.arg ? ' data-arg="' + esc(it.arg) + '"' : "") + ">" + inner + "</button>";
    }).join("");
    document.body.appendChild(el);
    var r = anchor.getBoundingClientRect();
    var left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8);
    var top = r.bottom + 4;
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 4);
    el.style.left = Math.max(8, left) + "px";
    el.style.top = top + "px";
    menuEl = el;
    menuAnchor = anchor;
    menuJustOpened = true;
    if (anchor && anchor.getAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "true");
    var first = el.querySelector(".iz-menu__item");
    if (first) first.focus();
  }

  function openDrawer(title, bodyHtml) {
    var root = document.getElementById("drawer-root");
    root.hidden = false;
    root.innerHTML = '<div class="iz-scrim iz-scrim--drawer is-open" data-act="drawer-close"></div>' +
      '<aside class="iz-drawer is-open" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="iz-drawer__head"><span class="iz-drawer__title">' + esc(title) + "</span>" +
      '<button class="iz-iconbtn" style="margin-left:auto" data-act="drawer-close" aria-label="Close ' + esc(title) + '">' + icon("i-x") + "</button></div>" +
      '<div class="iz-drawer__body">' + bodyHtml + "</div></aside>";
    var closeBtn = root.querySelector(".iz-drawer__head button");
    if (closeBtn) closeBtn.focus();
    document.body.style.overflow = "hidden";
  }
  function closeDrawer() {
    var root = document.getElementById("drawer-root");
    root.hidden = true;
    root.innerHTML = "";
    document.body.style.overflow = "";
  }

  function notificationBody(tab) {
    var items = D.notifications.filter(function (n) { return tab === "all" || n.unread; });
    if (!items.length) return emptyState("You're all caught up", "Alerts appear here when runs fail or approvals arrive.", "", true);
    return '<div class="iz-tabs" role="tablist" aria-label="Notification filter" style="margin-bottom:12px">' +
      '<button class="iz-tab" role="tab" data-act="ntf-tab" data-arg="unread" aria-selected="' + (tab === "unread" ? "true" : "false") + '">Unread</button>' +
      '<button class="iz-tab" role="tab" data-act="ntf-tab" data-arg="all" aria-selected="' + (tab === "all" ? "true" : "false") + '">All</button></div>' +
      '<div>' + items.map(function (n) {
        return '<a class="iz-evidence__row" href="' + n.href + '" data-act="drawer-close" style="grid-template-columns:16px minmax(0,1fr) auto;padding:10px 0;display:grid">' +
          '<span class="iz-evidence__icon" style="color:' + (n.sev === "P0" || n.sev === "P1" ? "var(--iz-status-failed-fg)" : "var(--iz-ink-3)") + '">' + icon("i-bell", "iz-icon--14") + "</span>" +
          '<div><div class="iz-evidence__label" style="font-weight:500">' + esc(n.title) + "</div>" +
          '<div class="iz-evidence__meta">' + esc(n.cls) + " · " + esc(n.detail) + "</div></div>" +
          '<span class="iz-meta">' + esc(n.age) + "</span></a>";
      }).join("") + "</div>";
  }

  /* ------------------------------------------------------------------ */
  /* Command palette + global search                                    */
  /* ------------------------------------------------------------------ */

  var PAL = { items: [], index: 0 };

  function paletteItems(q) {
    var out = [];
    var query = q.trim().toLowerCase();
    D.commands.forEach(function (c) {
      if (!query || c.label.toLowerCase().indexOf(query) !== -1) {
        out.push({ group: c.group, label: c.label, icon: c.icon, hint: c.hint, href: c.href, act: c.act });
      }
    });
    D.searchIndex.forEach(function (s2) {
      if (query && (s2.title.toLowerCase().indexOf(query) !== -1 || s2.id.toLowerCase().indexOf(query) !== -1)) {
        out.push({ group: s2.type, label: s2.title, sub: s2.id, icon: s2.icon, href: s2.href, object: true });
      }
    });
    return out.slice(0, 18);
  }

  function paletteListHtml(items) {
    if (!items.length) return '<div style="padding:24px;text-align:center;color:var(--iz-ink-3);font-size:13px">No matches. Try a module name, an ID prefix, or an action.</div>';
    var html = "", lastGroup = "";
    items.forEach(function (it, i) {
      if (it.group !== lastGroup) { html += '<div class="iz-palette__group">' + esc(it.group) + "</div>"; lastGroup = it.group; }
      html += '<button class="iz-palette__item' + (i === PAL.index ? " is-active" : "") + '" data-act="palette-pick" data-idx="' + i + '" role="option" aria-selected="' + (i === PAL.index ? "true" : "false") + '">' +
        icon(it.icon) + "<span>" + esc(it.label) + "</span>" +
        (it.sub ? '<span class="iz-palette__hint iz-mono">' + esc(it.sub) + "</span>" : "") +
        (it.hint ? '<span class="iz-palette__hint">' + esc(it.hint) + "</span>" : (it.object ? '<span class="iz-palette__hint">open ↵</span>' : "")) +
        "</button>";
    });
    return html;
  }

  function openPalette() {
    var d = document.createElement("dialog");
    d.className = "iz-dialog iz-palette";
    d.setAttribute("aria-label", "Command palette");
    d.innerHTML = '<div class="iz-palette__inputrow">' + icon("i-command", "iz-icon--20") +
      '<input class="iz-palette__input" id="pal-input" type="text" placeholder="Search, or run a command…" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off">' +
      '<span class="iz-kbd">Esc</span></div>' +
      '<div class="iz-palette__list" id="pal-list" role="listbox" aria-label="Commands and objects"></div>' +
      '<div class="iz-palette__foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span>' +
      '<span style="margin-left:auto">Objects are searched only when you type</span></div>';
    document.body.appendChild(d);
    d.showModal();
    var input = d.querySelector("#pal-input");
    var list = d.querySelector("#pal-list");

    function refresh() {
      PAL.items = paletteItems(input.value);
      PAL.index = 0;
      list.innerHTML = paletteListHtml(PAL.items);
      list.setAttribute("aria-activedescendant", "");
    }
    refresh();
    input.focus();
    input.addEventListener("input", refresh);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); PAL.index = Math.min(PAL.index + 1, PAL.items.length - 1); list.innerHTML = paletteListHtml(PAL.items); }
      else if (e.key === "ArrowUp") { e.preventDefault(); PAL.index = Math.max(PAL.index - 1, 0); list.innerHTML = paletteListHtml(PAL.items); }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(PAL.index, d); }
    });
    d.addEventListener("close", function () { d.remove(); });
  }

  function runPalette(i, dialogEl) {
    var it = PAL.items[i];
    if (!it) return;
    if (dialogEl) dialogEl.close();
    if (it.href) { location.hash = it.href; return; }
    if (it.act) doAction(it.act, null);
  }

  function openSearch() {
    var d = document.createElement("dialog");
    d.className = "iz-dialog iz-dialog--lg";
    d.setAttribute("aria-label", "Global search");
    d.innerHTML = '<div class="iz-palette__inputrow">' + icon("i-search", "iz-icon--20") +
      '<input class="iz-palette__input" id="gs-input" type="search" placeholder="Search runs, approvals, evidence, findings…" autocomplete="off">' +
      '<span class="iz-kbd">⌘⇧F</span></div>' +
      '<div id="gs-results" style="padding:12px 16px 16px;max-height:60vh;overflow:auto"></div>' +
      '<div class="iz-palette__foot"><span>Scope: ReveilChat · all time</span><span style="margin-left:auto">Results exclude 2 items you cannot access</span></div>';
    document.body.appendChild(d);
    d.showModal();
    var input = d.querySelector("#gs-input");
    var res = d.querySelector("#gs-results");
    function draw() {
      var q = input.value.trim().toLowerCase();
      var hits = D.searchIndex.filter(function (s2) {
        return !q || (s2.title + " " + s2.id + " " + s2.type).toLowerCase().indexOf(q) !== -1;
      });
      if (!q) { res.innerHTML = '<p class="iz-meta" style="padding:8px 0">Type to search 8 object types across this workspace. Try <span class="iz-code">apr_</span>, <span class="iz-code">auth</span>, or <span class="iz-code">runtime</span>.</p>'; return; }
      if (!hits.length) { res.innerHTML = emptyState("No results for “" + input.value + "”", "Searching in ReveilChat. Try all workspaces, or check the ID prefix.", '<button class="iz-btn iz-btn--secondary iz-btn--sm" data-act="toast" data-arg="Cross-workspace search is simulated">Search all workspaces</button>', true); return; }
      var groups = {};
      hits.forEach(function (h2) { (groups[h2.type] = groups[h2.type] || []).push(h2); });
      res.innerHTML = Object.keys(groups).map(function (g) {
        return '<div class="iz-palette__group">' + esc(g) + " · " + groups[g].length + "</div>" +
          groups[g].map(function (h3) {
            return '<a class="iz-palette__item" href="' + h3.href + '">' + icon(h3.icon) +
              "<span>" + esc(h3.title) + '</span><span class="iz-palette__hint iz-mono">' + esc(h3.id) + "</span></a>";
          }).join("");
      }).join("");
      res.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { d.close(); }); });
    }
    draw();
    input.focus();
    input.addEventListener("input", draw);
    d.addEventListener("close", function () { d.remove(); });
  }

  /* ------------------------------------------------------------------ */
  /* Dialogs                                                            */
  /* ------------------------------------------------------------------ */

  function dialog(html, cls, label) {
    var d = document.createElement("dialog");
    d.className = "iz-dialog " + (cls || "");
    if (label) d.setAttribute("aria-label", label);
    d.innerHTML = html;
    document.body.appendChild(d);
    d.showModal();
    var auto = d.querySelector(".iz-dialog__foot .iz-btn--secondary") || d.querySelector("[data-autofocus]");
    if (auto) auto.focus();
    d.addEventListener("close", function () { d.remove(); });
    d.querySelectorAll("[data-act='dialog-close']").forEach(function (b) {
      b.addEventListener("click", function () { d.close(); });
    });
    return d;
  }

  function openApprove(id) {
    var a = approvalById(id);
    if (!a) return;
    var critical = a.risk.level === "critical";
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">' + (a.actionVerb === "merge" ? "Approve merge?" : a.actionVerb === "delete" ? "Approve deletion?" : "Approve this action?") + "</div>" +
      '<div class="iz-dialog__sub">' + esc(a.title) + "</div></div>" +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body">' +
      '<div class="iz-callout">' + icon("i-info") + '<div class="iz-callout__body">' +
      '<div class="iz-callout__title">' + a.blast.files + " files · " + a.blast.repos.length + " repo · " + esc(a.blast.envs.join(", ")) + "</div>" +
      '<p class="iz-callout__text">Rollback: ' + esc(a.guardrails.rollback) + "</p></div></div>" +
      "<p class=\"iz-body\">This records your name in the audit trail" + (a.requiredApprovers > 1 ? " as approval " + (a.received.length + 1) + " of " + a.requiredApprovers + ". The second approver (S. Idris) must approve before execution." : ".") + "</p>" +
      (critical ? '<label class="iz-check"><input type="checkbox" id="ap-ack"><span>I have reviewed the failed evidence item (rollback drill, 03:52Z) and the 1 unverified item.</span></label>' +
        '<div><label class="iz-label" for="ap-type">Type <span class="iz-mono">' + esc(a.id.slice(-6).toUpperCase()) + "</span> to confirm</label>" +
        '<input class="iz-input" id="ap-type" style="width:100%" autocomplete="off"></div>' : "") +
      '<div id="ap-err" class="iz-error-text" role="alert" hidden></div>' +
      "</div>" +
      '<div class="iz-dialog__foot"><span class="iz-dialog__note">Approving is recorded permanently. Evidence set hash will be attached to the decision.</span>' +
      '<button class="iz-btn iz-btn--secondary" data-act="dialog-close">Cancel</button>' +
      '<button class="iz-btn iz-btn--primary" id="ap-confirm">' + (a.actionVerb === "merge" ? "Approve merge" : "Approve") + "</button></div>";

    var d = dialog(body, "", "Approve approval");
    var cancel = d.querySelector(".iz-dialog__foot [data-act='dialog-close']");
    if (cancel) cancel.focus();
    d.querySelector("#ap-confirm").addEventListener("click", function () {
      var err = d.querySelector("#ap-err");
      if (critical) {
        var ack = d.querySelector("#ap-ack").checked;
        var typed = (d.querySelector("#ap-type").value || "").trim().toUpperCase();
        if (!ack || typed !== a.id.slice(-6).toUpperCase()) {
          err.hidden = false;
          err.innerHTML = icon("i-warn", "iz-icon--12") + "<span>" + (!ack ? "Confirm you have reviewed the failed evidence." : "The confirmation code does not match " + a.id.slice(-6).toUpperCase() + ".") + "</span>";
          return;
        }
      }
      a.state = "approved";
      a.received.push({ name: D.user.name, role: D.user.role, at: "04:22Z" });
      d.close();
      toast("success", "Approved · " + a.id, a.title + " — decision written to the audit trail.", "Open audit entry", function () { location.hash = "#/security"; });
      gotoNextApproval();
    });
  }

  function openReject(id) {
    var a = approvalById(id);
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">Reject this approval?</div>' +
      '<div class="iz-dialog__sub">' + esc(a.title) + "</div></div>" +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body">' +
      '<div><label class="iz-label" for="rj-reason">Reason (required)</label>' +
      '<select class="iz-select" id="rj-reason" style="width:100%"><option value="">Select a reason…</option><option>Incorrect approach</option><option>Insufficient evidence</option><option>Policy violation</option><option>Out of scope</option><option>Duplicate</option></select></div>' +
      '<div><label class="iz-label" for="rj-note">Note to the requesting agent (min 12 characters)</label>' +
      '<textarea class="iz-input" id="rj-note" rows="3" style="width:100%;height:auto;padding:8px 10px"></textarea></div>' +
      '<p class="iz-meta">Rejection is recorded permanently and returned to the agent as feedback. The run moves to Awaiting input, it is not cancelled.</p>' +
      '<div id="rj-err" class="iz-error-text" role="alert" hidden></div></div>' +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--secondary" data-act="dialog-close">Cancel</button>' +
      '<button class="iz-btn iz-btn--danger" id="rj-confirm">Reject approval</button></div>';
    var d = dialog(body, "", "Reject approval");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#rj-confirm").addEventListener("click", function () {
      var reason = d.querySelector("#rj-reason").value;
      var note = (d.querySelector("#rj-note").value || "").trim();
      var err = d.querySelector("#rj-err");
      if (!reason || note.length < 12) {
        err.hidden = false;
        err.innerHTML = icon("i-warn", "iz-icon--12") + "<span>" + (!reason ? "Select a reason." : "Add at least 12 characters of guidance.") + "</span>";
        return;
      }
      a.state = "rejected";
      d.close();
      toast("info", "Rejected · " + a.id, "Returned to Atlas with reason: " + reason + ".");
      gotoNextApproval();
    });
  }

  function openChanges(id) {
    var a = approvalById(id);
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">Request changes</div>' +
      '<div class="iz-dialog__sub">' + esc(a.title) + "</div></div>" +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body">' +
      '<div><label class="iz-label" for="ch-note">What must change? (min 12 characters)</label>' +
      '<textarea class="iz-input" id="ch-note" rows="3" style="width:100%;height:auto;padding:8px 10px"></textarea></div>' +
      '<div><label class="iz-label" for="ch-step">Re-run from</label>' +
      '<select class="iz-select" id="ch-step" style="width:100%"><option>Step 4 · run tests</option><option>Step 3 · patch files</option><option>Step 1 · plan</option></select></div>' +
      '<p class="iz-meta">A new run is created from the selected step and linked as a child of the original. This approval stays open until the new run is submitted.</p>' +
      '<div id="ch-err" class="iz-error-text" role="alert" hidden></div></div>' +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--secondary" data-act="dialog-close">Cancel</button>' +
      '<button class="iz-btn iz-btn--primary" id="ch-confirm">Request changes</button></div>';
    var d = dialog(body, "", "Request changes");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#ch-confirm").addEventListener("click", function () {
      var note = (d.querySelector("#ch-note").value || "").trim();
      if (note.length < 12) {
        var err = d.querySelector("#ch-err");
        err.hidden = false;
        err.innerHTML = icon("i-warn", "iz-icon--12") + "<span>Add at least 12 characters describing the required change.</span>";
        return;
      }
      a.state = "changes";
      d.close();
      toast("info", "Changes requested · " + a.id, "Atlas will re-run from step 4 and resubmit.");
      gotoNextApproval();
    });
  }

  function gotoNextApproval() {
    var next = S.approvals.filter(function (a) { return a.state === "awaiting" || a.state === "blocked"; })[0];
    var target = next ? "#/approvals/" + next.id : "#/approvals";
    if (location.hash === target) render(window.IZRouter.parse());
    else location.hash = target;
  }

  function openShortcuts() {
    var rows = [
      ["⌘K / Ctrl+K", "Command palette"],
      ["⌘⇧F / Ctrl+Shift+F", "Global search"],
      ["/", "Focus the current filter"],
      ["j / k", "Move through a list or queue"],
      ["Enter", "Open the focused item"],
      ["a", "Approve the focused approval"],
      ["r", "Reject the focused approval"],
      ["c", "Request changes"],
      ["d", "Toggle the diff viewer"],
      ["e / l", "Evidence / lineage rail"],
      ["g then o / a / r / p", "Go to Overview, Approvals, Research, Projects"],
      ["?", "This sheet"],
      ["Esc", "Close the topmost layer"]
    ];
    dialog('<div class="iz-dialog__head"><div><div class="iz-dialog__title">Keyboard shortcuts</div>' +
      '<div class="iz-dialog__sub">Single-key shortcuts are inactive while a text field has focus.</div></div>' +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body"><table class="iz-table" style="min-width:0"><caption class="iz-sr-only">Keyboard shortcuts</caption><tbody>' +
      rows.map(function (r) { return '<tr><td style="width:180px"><span class="iz-kbd">' + esc(r[0]) + "</span></td><td>" + esc(r[1]) + "</td></tr>"; }).join("") +
      "</tbody></table></div>" +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--primary" data-act="dialog-close">Close</button></div>', "", "Keyboard shortcuts");
  }

  function openNotice(force) {
    var d = dialog('<div class="iz-dialog__head"><div><div class="iz-dialog__title">This is a simulated prototype</div>' +
      '<div class="iz-dialog__sub">No backend, no auth, no network requests.</div></div>' +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body">' +
      '<p class="iz-body">Every number, run, approval, agent, and source on these screens comes from <span class="iz-code">assets/js/data.js</span>. Interactions mutate that local fixture in memory only — reloading resets everything.</p>' +
      '<ul style="display:grid;gap:6px;font-size:13px;color:var(--iz-ink-2);list-style:disc;padding-left:18px">' +
      "<li>Nothing is fetched. Nothing is persisted. No credentials exist.</li>" +
      "<li>Approvals, filters, state previews, and toasts are real UI behaviour over fake data.</li>" +
      "<li>Use the account menu → State inspector to demonstrate empty, loading, error, permission, offline, and degraded states.</li>" +
      "</ul></div>" +
      '<div class="iz-dialog__foot"><span class="iz-dialog__note">The persistent “Simulated data” chip stays in the scope bar.</span>' +
      '<button class="iz-btn iz-btn--primary" id="notice-ok">Got it</button></div>', "", "Simulated prototype notice");
    d.querySelector("#notice-ok").addEventListener("click", function () {
      try { localStorage.setItem("iz-notice", "1"); } catch (e) { /* file:// may refuse */ }
      try { sessionStorage.setItem("iz-notice", "1"); } catch (e) { /* file:// may refuse */ }
      d.close();
    });
    if (force) d.querySelector("#notice-ok").addEventListener("click", function () { d.close(); });
  }

  /* ------------------------------------------------------------------ */
  /* State preview                                                      */
  /* ------------------------------------------------------------------ */

  function stateDef(id) {
    return STATE_DEFS.filter(function (s2) { return s2.id === id; })[0] || STATE_DEFS[0];
  }

  function updateStatebar() {
    var bar = document.getElementById("statebar");
    if (!bar) return;
    if (S.state === "live") { bar.hidden = true; bar.innerHTML = ""; return; }
    var def = stateDef(S.state);
    bar.hidden = false;
    bar.innerHTML = icon("i-info", "iz-icon--14") +
      "<span><b>State preview: " + esc(def.name) + "</b> — " + esc(def.desc) + (S.state === "loading" ? " Held so the skeleton can be inspected." : "") + "</span>" +
      '<span style="margin-left:auto"><button class="iz-statebar__btn" data-act="state-set" data-arg="live">Return to live data</button></span>';
  }

  function setState(id) {
    S.state = id;
    updateStatebar();
    render(S.route, null, { keepScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* Render dispatch                                                    */
  /* ------------------------------------------------------------------ */

  function render(route, fk, opts) {
    opts = opts || {};
    S.route = route;
    var main = document.getElementById("main");
    var html = "", title = "Overview";
    switch (route.module) {
      case "overview": html = renderOverview(); title = "Overview"; break;
      case "agents": html = renderAgents(); title = "Agent Command Centre"; break;
      case "approvals": html = renderApprovals(); title = "Approvals"; break;
      case "research": html = renderResearch(); title = "Research Lab"; break;
      case "states": html = renderStates(); title = "State inspector"; break;
      default:
        title = (MODULES[route.module] || {}).label || route.module;
        html = renderPlaceholder(route.module);
    }
    main.innerHTML = html;
    document.body.classList.toggle("iz-has-decisionbar", route.module === "approvals");
    shellSync();
    updateStatebar();
    document.title = title + " · INTELLIGENZ";
    if (!opts.keepScroll) window.scrollTo(0, 0);
    if (fk) {
      var el = document.querySelector('[data-fk="' + fk + '"]');
      if (el) el.focus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                            */
  /* ------------------------------------------------------------------ */

  function doAction(act, arg, el) {
    switch (act) {
      case "group-toggle":
        S.ui.groups[arg] = S.ui.groups[arg] === false;
        shellSync();
        break;
      case "palette": openPalette(); break;
      case "search": openSearch(); break;
      case "notif":
        openDrawer("Notifications", notificationBody("unread"));
        break;
      case "ntf-tab":
        openDrawer("Notifications", notificationBody(arg));
        break;
      case "drawer-close": closeDrawer(); break;
      case "workspace": openWorkspaceMenu(el); break;
      case "project": openProjectMenu(el); break;
      case "env": openEnvMenu(el); break;
      case "branch":
        openMenu(el, [{ heading: true, label: "Revision" }, { label: "main @ 8f2c1a4", icon: "i-branch", checked: true }, { label: "release/2026.11 @ 41bd0e2", icon: "i-branch" }]);
        break;
      case "account": openAccountMenu(el); break;
      case "state-menu": {
        var anchorEl = (el && !el.closest(".iz-menu")) ? el : document.querySelector(".iz-topbar [data-act='account']");
        openStateMenu(anchorEl || el);
        break;
      }
      case "state-set": setState(arg); break;
      case "mode": openModeConfirm(arg); break;
      case "density": S.density = arg; shellSync(); toast("info", "Density: " + arg, "Row height and cell padding updated across tables."); break;
      case "theme": S.theme = S.theme === "light" ? "dark" : "light"; shellSync(); break;
      case "sort":
        S.ui.ov.sort = arg;
        render(S.route, "sort-" + arg, { keepScroll: true });
        break;
      case "filter-state": {
        var i = S.ui.ov.filter.indexOf(arg);
        if (i === -1) S.ui.ov.filter.push(arg); else S.ui.ov.filter.splice(i, 1);
        render(S.route, "f-" + arg, { keepScroll: true });
        break;
      }
      case "clear-run-filter":
        S.ui.ov.filter = [];
        render(S.route, null, { keepScroll: true });
        break;
      case "run-menu": openRunMenu(el, arg); break;
      case "select-run":
        S.ui.ov.sel[arg] = el.checked;
        syncSelection();
        break;
      case "select-all":
        document.querySelectorAll("#runs-table tbody input[type=checkbox]").forEach(function (cb) {
          cb.checked = el.checked;
          S.ui.ov.sel[cb.getAttribute("data-arg")] = el.checked;
        });
        syncSelection();
        break;
      case "ap-risk":
        S.ui.ap.risk = arg;
        render(S.route, "ap-risk-" + arg, { keepScroll: true });
        break;
      case "ap-rail":
        S.ui.ap.rail = arg;
        render(S.route, "ap-rail-" + arg, { keepScroll: true });
        break;
      case "toggle-diff":
        S.ui.ap.diff = !S.ui.ap.diff;
        render(S.route, "toggle-diff", { keepScroll: true });
        break;
      case "approve": openApprove(arg || (S.route.id || (S.approvals.filter(function (a) { return a.state === "awaiting"; })[0] || {}).id)); break;
      case "reject": openReject(arg || (S.route.id || (S.approvals.filter(function (a) { return a.state === "awaiting"; })[0] || {}).id)); break;
      case "changes": openChanges(arg || (S.route.id || (S.approvals.filter(function (a) { return a.state === "awaiting"; })[0] || {}).id)); break;
      case "assign-me": toast("success", "Assigned to you", "Approvals you own appear first in your queue."); break;
      case "ac-tab": S.ui.ac.tab = arg; render(S.route, "ac-tab-" + arg, { keepScroll: true }); break;
      case "select-atlas": location.hash = "#/agents/agt_eng_04"; break;
      case "pause-agent": openPause(el, arg); break;
      case "agent-menu": openAgentMenu(el, arg); break;
      case "pick-finding": S.ui.rl.finding = arg; render(S.route, "fnd-" + arg, { keepScroll: true }); break;
      case "finding-filter": {
        var fi = S.ui.rl.filter.indexOf(arg);
        if (arg === "") S.ui.rl.filter = [];
        else if (fi === -1) S.ui.rl.filter.push(arg); else S.ui.rl.filter.splice(fi, 1);
        render(S.route, "ff-" + (arg || "all"), { keepScroll: true });
        break;
      }
      case "rl-tab": S.ui.rl.tab = arg; render(S.route, "rl-tab-" + arg, { keepScroll: true }); break;
      case "research-rail": S.ui.rl.rail = arg === "coverage" ? "coverage" : "sources"; render(S.route, "rr-" + S.ui.rl.rail, { keepScroll: true }); break;
      case "open-campaign": location.hash = "#/research/" + arg; break;
      case "copy": copyText(arg); break;
      case "row-expand": {
        var wasOpen = !!S.ui.ov.open[arg];
        S.ui.ov.open[arg] = !wasOpen;
        var drow = document.getElementById("detail-" + arg);
        if (drow) { if (wasOpen) drow.setAttribute("hidden", ""); else drow.removeAttribute("hidden"); }
        document.querySelectorAll('[data-act="row-expand"][data-arg="' + arg + '"]').forEach(function (b) {
          b.setAttribute("aria-expanded", String(!wasOpen));
          b.setAttribute("aria-label", (wasOpen ? "Show" : "Hide") + " details");
        });
        break;
      }
      case "open-evidence": openEvidence(arg); break;
      case "ac-sort": S.ui.ac.sort = arg; render(S.route, null, { keepScroll: true }); break;
      case "ac-sort-menu": openAgentSortMenu(el); break;
      case "toast": toast("info", "Simulated", arg); break;
      case "retry-sync": toast("success", "Reconnected", "3 queued approvals submitted. Last sync 04:19:02Z."); setState("live"); break;
      case "retry-region": setState("live"); toast("success", "Region recovered", "Runs service responded in 240ms."); break;
      case "view-status": toast("info", "Status page", "model-router: 2 of 5 providers responding. ETA 20m (simulated)."); break;
      case "run-workflow": openRunWorkflow(); break;
      case "browse-templates": toast("info", "Templates", "Workflow templates live in the Marketplace (not in this slice)."); break;
      case "filter-agents": toast("info", "Filter", "The registry is already sorted by attention: failed, awaiting, degraded, offline, active, queued, idle."); break;
      case "window": toast("info", "Time window", "Window switching is visual only in this prototype."); break;
      case "dismiss-notice": S.noticeDismissed = true; render(S.route, null, { keepScroll: true }); break;
      case "shortcuts": openShortcuts(); break;
      case "notice": openNotice(true); break;
      case "nav-drawer": {
        var sbx = document.getElementById("sidebar");
        var scx = document.getElementById("sidebar-scrim");
        if (sbx) sbx.classList.toggle("is-open");
        if (scx) scx.classList.toggle("is-open");
        break;
      }
      case "density-compact": S.density = "compact"; shellSync(); toast("info", "Density: compact", "28px rows, 12px table type."); break;
      case "density-default": S.density = "default"; shellSync(); toast("info", "Density: default", "32px rows."); break;
      case "theme-toggle": S.theme = S.theme === "light" ? "dark" : "light"; shellSync(); break;
      case "state-open": location.hash = "#/states"; break;
      case "external": toast("info", "External source", "External links are disabled in this offline prototype."); break;
      case "cancel-run": openCancelRun(arg); break;
      case "noop": break;
      default: break;
    }
  }

  function syncSelection() {
    var n = Object.keys(S.ui.ov.sel).filter(function (k) { return S.ui.ov.sel[k]; }).length;
    var el = document.getElementById("run-bulk");
    if (el) el.textContent = n + " selected";
    document.querySelectorAll(".iz-run-row").forEach(function (tr) {
      var id = tr.getAttribute("data-run");
      tr.classList.toggle("is-selected", !!S.ui.ov.sel[id]);
    });
  }

  function copyText(text) {
    function done() { toast("success", "Copied", text); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("warning", "Copy unavailable", "Select the ID and copy manually."); }
      ta.remove();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Menus                                                              */
  /* ------------------------------------------------------------------ */

  function openWorkspaceMenu(el) {
    openMenu(el, [
      { heading: true, label: "Workspaces" },
      { label: "ReveilChat", icon: "i-folder", checked: true, act: "toast", arg: "Already in ReveilChat" },
      { label: "Northwind", icon: "i-folder", act: "toast", arg: "Workspace switching is simulated in this prototype" },
      { label: "INTELLIGENZ", icon: "i-folder", act: "toast", arg: "Workspace switching is simulated in this prototype" },
      { sep: true },
      { label: "New workspace", icon: "i-plus", act: "toast", arg: "Workspace creation is out of scope" }
    ]);
  }
  function openProjectMenu(el) {
    openMenu(el, [
      { heading: true, label: "Projects" },
      { label: "Control Plane", checked: true, icon: "i-grid", act: "toast", arg: "Project scope: prj_control-plane" },
      { label: "Reveil Mobile", icon: "i-grid", act: "toast", arg: "Project switching is simulated" },
      { label: "Infrastructure", icon: "i-grid", act: "toast", arg: "Project switching is simulated" },
      { sep: true },
      { label: "All projects", icon: "i-layers", act: "toast", arg: "All-projects scope is simulated" }
    ]);
  }
  function openEnvMenu(el) {
    openMenu(el, [
      { heading: true, label: "Environment" },
      { label: "Production", checked: true, icon: "i-warning", act: "toast", arg: "prod requires the Release role" },
      { label: "Staging", icon: "i-layers", act: "toast", arg: "staging selected (simulated)" },
      { label: "Development", icon: "i-code", act: "toast", arg: "dev selected (simulated)" }
    ]);
  }
  function openAccountMenu(el) {
    openMenu(el, [
      { heading: true, label: D.user.name + " · " + D.user.role },
      { label: "Preferences · density", icon: "i-layers", act: "density", arg: S.density === "compact" ? "default" : "compact" },
      { label: "Theme: " + (S.theme === "light" ? "light" : "dark"), icon: S.theme === "light" ? "i-moon" : "i-sun", act: "theme" },
      { sep: true },
      { label: "State inspector", icon: "i-layers", act: "state-menu" },
      { label: "Keyboard shortcuts", icon: "i-help", act: "shortcuts" },
      { label: "Simulated data notice", icon: "i-info", act: "notice" },
      { sep: true },
      { label: "Members and billing", icon: "i-user", act: "toast", arg: "Settings are out of scope in this prototype" },
      { label: "Sign out", icon: "i-lock", act: "toast", arg: "There is no authentication in this prototype", danger: true }
    ]);
  }
  function openStateMenu(el) {
    var items = [{ heading: true, label: "Preview state" }];
    STATE_DEFS.forEach(function (s2) {
      items.push({ label: s2.name, icon: "i-layers", checked: S.state === s2.id, act: "state-set", arg: s2.id });
    });
    items.push({ sep: true });
    items.push({ label: "Open state inspector", icon: "i-external", href: "#/states" });
    openMenu(el, items);
  }
  function openRunMenu(el, id) {
    var r = D.runs.filter(function (x) { return x.id === id; })[0];
    openMenu(el, [
      { heading: true, label: r.id },
      { label: S.ui.ov.open[r.id] ? "Hide details" : "Show details", icon: "i-chev-right", act: "row-expand", arg: r.id },
      { label: "Copy run ID", icon: "i-copy", act: "copy", arg: r.id },
      { label: "Open agent", icon: "i-hex", href: "#/agents/" + r.agentId },
      { sep: true },
      { label: r.state === "active" ? "Cancel run" : "Retry run", icon: r.state === "active" ? "i-stop" : "i-refresh", danger: r.state === "active", act: "cancel-run", arg: r.id }
    ]);
  }
  function openAgentSortMenu(el) {
    openMenu(el, [
      { heading: true, label: "Sort registry" },
      { label: "Attention", icon: "i-warn", checked: S.ui.ac.sort === "attention", act: "ac-sort", arg: "attention" },
      { label: "Name", icon: "i-user", checked: S.ui.ac.sort === "name", act: "ac-sort", arg: "name" },
      { label: "Runtime", icon: "i-chip", checked: S.ui.ac.sort === "runtime", act: "ac-sort", arg: "runtime" }
    ]);
  }

  function openAgentMenu(el, id) {
    openMenu(el, [
      { heading: true, label: id },
      { label: "Copy agent ID", icon: "i-copy", act: "copy", arg: id },
      { label: "View audit trail", icon: "i-shield", act: "toast", arg: "Audit filtered to this agent (simulated)" },
      { label: "View runs", icon: "i-play", act: "toast", arg: "Runs list is shown in the Runs tab" },
      { sep: true },
      { label: "Retire agent", icon: "i-trash", danger: true, act: "toast", arg: "Retiring an agent requires typed confirmation (not built)" }
    ]);
  }

  function openModeConfirm(id) {
    if (id === "copilot") { toast("info", "Mode unchanged", "Copilot is already active."); return; }
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">Switch to ' + (id === "autopilot" ? "Autopilot" : "Manual") + "?</div>" +
      '<div class="iz-dialog__sub">This changes what the organisation may do without asking.</div></div>' +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body"><div class="iz-callout">' + icon("i-warn") + '<div class="iz-callout__body">' +
      '<div class="iz-callout__title">' + (id === "autopilot" ? "Autopilot executes bounded tasks without further approval" : "Manual stops all autonomous execution") + "</div>" +
      '<p class="iz-callout__text">' + (id === "autopilot" ? "Risk ceiling Medium · $600 daily budget · 4 repositories · rollback rehearsed. Anything above the ceiling still routes to Approvals." : "Queued runs hold. In-flight runs stop at their next checkpoint. Approvals remain open.") + "</p></div></div>" +
      '<p class="iz-body">Every mode change is recorded in the audit trail with your name.</p></div>' +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--secondary" data-act="dialog-close">Cancel</button>' +
      '<button class="iz-btn iz-btn--primary" id="mode-confirm">Switch to ' + (id === "autopilot" ? "Autopilot" : "Manual") + "</button></div>";
    var d = dialog(body, "", "Change operating mode");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#mode-confirm").addEventListener("click", function () {
      d.close();
      toast("success", "Mode changed", "Operating mode set to " + id + " and recorded in the audit trail.");
    });
  }

  function openPause(el, id) {
    var a = D.agents.filter(function (x) { return x.id === id; })[0];
    var pausing = a.state !== "offline";
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">' + (pausing ? "Pause " + a.name + "?" : "Resume " + a.name + "?") + "</div>" +
      '<div class="iz-dialog__sub">' + esc(a.assign) + "</div></div>" +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body"><p class="iz-body">' + (pausing
        ? "1 run continues to its next checkpoint (max 2m). 2 queued runs will be held. Rollback is unaffected."
        : "Queued runs resume immediately. The next checkpoint starts within 30s.") + "</p>" +
      '<div class="iz-callout">' + icon("i-info") + '<div class="iz-callout__body"><div class="iz-callout__title">Pausing is not cancelling</div><p class="iz-callout__text">Artifacts remain auditable. In-flight work stops at a safe checkpoint rather than mid-write.</p></div></div></div>' +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--secondary" data-act="dialog-close">Keep ' + (pausing ? "running" : "paused") + "</button>" +
      '<button class="iz-btn iz-btn--primary" id="pause-confirm">' + (pausing ? "Pause agent" : "Resume agent") + "</button></div>";
    var d = dialog(body, "", "Pause or resume agent");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#pause-confirm").addEventListener("click", function () {
      d.close();
      toast("success", pausing ? "Agent paused" : "Agent resumed", a.name + " · state change recorded.");
    });
  }

  function openRunWorkflow() {
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">Run a workflow</div>' +
      '<div class="iz-dialog__sub">Guardrails are inherited from the workflow version, not set here.</div></div>' +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body">' +
      '<div><label class="iz-label" for="wf-pick">Workflow</label><select class="iz-select" id="wf-pick" style="width:100%">' +
      "<option>Auth token rotation · v14</option><option>Dependency CVE sweep · v6</option><option>Client delivery report · v3</option><option>WCAG audit · v9</option></select></div>" +
      '<div><label class="iz-label" for="wf-branch">Target branch</label><input class="iz-input" id="wf-branch" style="width:100%" value="feature/token-rotation"></div>' +
      '<div class="iz-callout">' + icon("i-shield") + '<div class="iz-callout__body"><div class="iz-callout__title">Copilot · max risk Medium · $40 per run</div>' +
      '<p class="iz-callout__text">Merge and deploy still require approval. Sandbox: firecracker, egress allowlist (pypi, npm).</p></div></div></div>' +
      '<div class="iz-dialog__foot"><span class="iz-dialog__note">Starting a run is simulated; no worker is dispatched.</span>' +
      '<button class="iz-btn iz-btn--secondary" data-act="dialog-close">Cancel</button>' +
      '<button class="iz-btn iz-btn--primary" id="wf-run">Start run</button></div>';
    var d = dialog(body, "", "Run a workflow");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#wf-run").addEventListener("click", function () {
      d.close();
      toast("success", "Run queued", "run_01JB8A1C7Q · position 3 in the queue · est. start 04:26Z.", "View queue", function () { location.hash = "#/overview"; });
    });
  }

  function openCancelRun(id) {
    var r = D.runs.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    var body = '<div class="iz-dialog__head"><div><div class="iz-dialog__title">Cancel this run?</div>' +
      '<div class="iz-dialog__sub">' + esc(r.title) + "</div></div>" +
      '<button class="iz-iconbtn iz-dialog__close" data-act="dialog-close" aria-label="Close dialog">' + icon("i-x") + "</button></div>" +
      '<div class="iz-dialog__body"><p class="iz-body">' + esc(r.duration) + " elapsed · " + money(r.cost) + " already spent (non-refundable). Completed steps' artifacts are retained and remain auditable.</p>" +
      '<div class="iz-callout">' + icon("i-warn") + '<div class="iz-callout__body"><div class="iz-callout__title">Cancelling stops work, it does not roll back</div><p class="iz-callout__text">Any branch already pushed stays. Use the rollback path if the change must be removed.</p></div></div></div>' +
      '<div class="iz-dialog__foot"><button class="iz-btn iz-btn--secondary" data-act="dialog-close">Keep running</button>' +
      '<button class="iz-btn iz-btn--danger" id="cancel-confirm">Cancel run</button></div>';
    var d = dialog(body, "", "Cancel run");
    d.querySelector("[data-act='dialog-close']").focus();
    d.querySelector("#cancel-confirm").addEventListener("click", function () {
      d.close();
      toast("info", "Run cancelled", r.id + " stopped at step 4. Artifacts retained.");
    });
  }

  /* ------------------------------------------------------------------ */
  /* Global events                                                      */
  /* ------------------------------------------------------------------ */

  function isTyping(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el.isContentEditable;
  }

  function bindGlobal() {
    document.addEventListener("click", function (e) {
      if (menuEl && e.target.closest(".iz-menu a")) closeMenu();
      var t = e.target.closest("[data-act]");
      if (menuEl && !e.target.closest(".iz-menu") && !e.target.closest("[data-act='workspace']") && !e.target.closest("[data-act='account']") && !e.target.closest("[data-act='state-menu']") && !e.target.closest("[data-act='agent-menu']") && !e.target.closest("[data-act='run-menu']") && !e.target.closest("[data-act='branch']") && !e.target.closest("[data-act='env']") && !e.target.closest("[data-act='project']")) {
        closeMenu();
      }
      if (!t) return;
      var act = t.getAttribute("data-act");
      if (act === "noop") return;
      if (act === "drawer-close") { closeDrawer(); return; }
      if (act === "palette-pick") { runPalette(Number(t.getAttribute("data-idx")), t.closest("dialog")); return; }
      if (act === "select-run" || act === "select-all") { doAction(act, t.getAttribute("data-arg"), t); return; }
      if (act === "copy" || act === "toggle-diff" || act === "sort" || act === "filter-state" || act === "ap-risk" || act === "ap-rail" || act === "ac-tab" || act === "rl-tab" || act === "finding-filter" || act === "research-rail" || act === "pick-finding" || act === "state-set" || act === "density") {
        doAction(act, t.getAttribute("data-arg"), t);
        closeMenuIfStale();
        return;
      }
      if (act === "palette-pick") return;
      doAction(act, t.getAttribute("data-arg"), t);
      closeMenuIfStale();
    });

    var skip = document.querySelector(".iz-skip");
    if (skip) skip.addEventListener("click", function (ev) {
      ev.preventDefault();
      var m = document.getElementById("main");
      if (m) m.focus();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target && e.target.matches && e.target.matches("[data-act][tabindex]")) {
        e.preventDefault(); e.target.click(); return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); openSearch(); return; }
      if (e.key === "Escape") { closeMenu(); hideTip(); }
      if (isTyping(e.target)) return;

      if (e.key === "?") { e.preventDefault(); openShortcuts(); return; }
      if (e.key === "/") {
        e.preventDefault();
        var f = document.querySelector("#run-filter") || document.querySelector(".iz-filters__search");
        if (f) f.focus();
        return;
      }
      if (e.key === "a" && S.route.module === "approvals" && S.ui.ap.risk !== "permission") {
        var cur = S.route.id || (S.approvals.filter(function (x) { return x.state === "awaiting"; })[0] || {}).id;
        if (cur) { e.preventDefault(); openApprove(cur); }
        return;
      }
      if (e.key === "r" && S.route.module === "approvals") {
        var cur2 = S.route.id || (S.approvals.filter(function (x) { return x.state === "awaiting"; })[0] || {}).id;
        if (cur2) { e.preventDefault(); openReject(cur2); }
        return;
      }
      if (e.key === "c" && S.route.module === "approvals") {
        var cur3 = S.route.id || (S.approvals.filter(function (x) { return x.state === "awaiting"; })[0] || {}).id;
        if (cur3) { e.preventDefault(); openChanges(cur3); }
        return;
      }
      if (e.key === "d" && S.route.module === "approvals") { e.preventDefault(); S.ui.ap.diff = !S.ui.ap.diff; render(S.route, "toggle-diff", { keepScroll: true }); return; }
      if (e.key === "j" || e.key === "k") {
        var items = Array.prototype.slice.call(document.querySelectorAll("[data-list-item]"));
        if (!items.length) return;
        e.preventDefault();
        var i = items.indexOf(document.activeElement);
        var next = e.key === "j" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
        if (i === -1) next = 0;
        items[next].focus();
        return;
      }
      if (e.key === "[") { e.preventDefault(); var sb = document.getElementById("sidebar"); if (sb) sb.classList.toggle("is-open"); return; }
      if (e.key === "g") { G.pending = Date.now(); return; }
      if (G.pending && Date.now() - G.pending < 1200) {
        var map = { o: "#/overview", a: "#/approvals", r: "#/research", p: "#/projects" };
        if (map[e.key]) { e.preventDefault(); location.hash = map[e.key]; G.pending = 0; }
      }
    });

    document.addEventListener("pointerover", function (e) {
      var t = e.target.closest("[data-tip]");
      if (t) showTip(t);
    });
    document.addEventListener("pointerout", function (e) {
      if (e.target.closest("[data-tip]")) hideTip();
    });
    document.addEventListener("focusin", function (e) {
      var t = e.target.closest("[data-tip]");
      if (t) showTip(t);
    });
    document.addEventListener("focusout", hideTip);
    window.addEventListener("scroll", hideTip, true);

    document.addEventListener("input", function (e) {
      if (e.target.id === "run-filter") {
        var q = e.target.value.toLowerCase().trim();
        var rows = document.querySelectorAll(".iz-run-row");
        var shown = 0;
        rows.forEach(function (tr) {
          var hay = tr.getAttribute("data-search") || "";
          var ok = !q || hay.indexOf(q) !== -1;
          tr.hidden = !ok;
          var det = tr.nextElementSibling;
          if (det && det.classList.contains("iz-row-detail")) det.hidden = true;
          if (ok) shown++;
        });
        var c = document.getElementById("run-count");
        if (c) c.textContent = shown + " of " + D.runs.length + " runs";
        var empty = document.querySelector("#runs-table tbody tr td[colspan]");
        return;
      }
    });

    document.addEventListener("change", function (e) {
      if (e.target.id === "run-all") return;
    });
  }

  var G = { pending: 0 };

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  function mount() {
    S.approvals = JSON.parse(JSON.stringify(D.approvals));
    shellSync();
    bindGlobal();
    updateStatebar();
    var dismiss = document.getElementById("sidebar-scrim");
    if (dismiss) dismiss.addEventListener("click", function () {
      var sb = document.getElementById("sidebar");
      if (sb) sb.classList.remove("is-open");
    });
    /* First-run notice is rendered inline on Overview (no unsolicited modal). */
  }

  window.IZApp = {
    mount: mount,
    render: render,
    setState: setState,
    toast: toast,
    openPalette: openPalette,
    openSearch: openSearch,
    doAction: doAction,
    state: function (k, v) { if (arguments.length === 2) S[k] = v; return S[k]; }
  };
})();
