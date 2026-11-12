/*
 * Graph Intelligence: page behaviour.
 *
 *   1. client     sends a Cypher statement to the sample or live endpoint
 *   2. highlight  colours Cypher text
 *   3. graph      draws nodes and relationships with Cytoscape
 *   4. console    editor, questions, tabs, table, JSON, inspector
 *   5. schema     label and relationship counts
 */
(function () {
  "use strict";

  var GI = (window.GI = window.GI || {});
  var config = Object.assign({ mode: "sample", endpoint: "", auth: null }, window.GI_CONFIG || {});
  var live = config.mode === "live";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var touch = window.matchMedia("(pointer: coarse)").matches;
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "style") node.style.cssText = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }

  function plural(n, word) { return n.toLocaleString("en-US") + " " + word + (n === 1 ? "" : "s"); }

  function endpointHost() {
    try { return new URL(config.endpoint).host; } catch (e) { return config.endpoint || "the endpoint"; }
  }

  /* ==================================================================== */
  /* 1. Client                                                            */
  /* ==================================================================== */

  function failure(code, message, ms, raw) {
    return { ok: false, errors: [{ code: code, message: message }], ms: ms || 0, raw: raw || { errors: [{ code: code, message: message }] } };
  }

  async function query(statement) {
    var started = performance.now();
    var status;
    var body;
    try {
      if (live) {
        var headers = { "Content-Type": "application/json", Accept: "application/json" };
        var auth = config.auth;
        if (auth && auth.username && auth.password) {
          headers.Authorization = "Basic " + btoa(unescape(encodeURIComponent(auth.username + ":" + auth.password)));
        }
        var response = await fetch(config.endpoint, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ statement: statement, parameters: {} })
        });
        status = response.status;
        var text = await response.text();
        try { body = JSON.parse(text); } catch (e) { body = null; }
      } else {
        var reply = await GI.sampleEndpoint.post({ statement: statement, parameters: {} });
        status = reply.status;
        body = reply.body;
      }
    } catch (err) {
      return failure(
        "GI.Client.Unreachable",
        "Couldn't reach " + endpointHost() + ". Check that the database is running and accepts requests from this page, or set mode back to \"sample\" in the settings file.",
        performance.now() - started
      );
    }
    var ms = performance.now() - started;
    if (body && Array.isArray(body.errors) && body.errors.length) {
      return { ok: false, errors: body.errors, ms: ms, raw: body };
    }
    if (status >= 400) {
      return failure("GI.Client.Http" + status, "The endpoint answered with HTTP " + status + ". Check the endpoint URL and credentials in the settings file.", ms, body);
    }
    if (!body || !body.data || !Array.isArray(body.data.fields) || !Array.isArray(body.data.values)) {
      return failure("GI.Client.BadResponse", "The endpoint replied, but not in the expected shape: { data: { fields, values } }. Check that the endpoint URL points at the query API.", ms, body);
    }
    return { ok: true, fields: body.data.fields, values: body.data.values, truncated: !!body.truncated, ms: ms, raw: body };
  }

  /* ==================================================================== */
  /* Labels: colour and caption                                           */
  /* ==================================================================== */

  var PALETTE = ["#8ab4ff", "#b79cff", "#5fe3b5", "#f2d27a", "#ff9e7a", "#f58fc4", "#7adcf0", "#c3e88d"];
  var labelColors = live ? {} : {
    Person: PALETTE[0], Team: PALETTE[1], Project: PALETTE[2],
    Document: PALETTE[3], Technology: PALETTE[4], Organization: PALETTE[5]
  };

  function colorFor(label) {
    if (!label) return "#bdbdbd";
    if (!labelColors[label]) labelColors[label] = PALETTE[Object.keys(labelColors).length % PALETTE.length];
    return labelColors[label];
  }

  function captionOf(node) {
    var p = node.properties || {};
    var preferred = ["name", "title", "label", "id"];
    for (var i = 0; i < preferred.length; i++) if (p[preferred[i]] != null && p[preferred[i]] !== "") return String(p[preferred[i]]);
    for (var k in p) if (typeof p[k] === "string" && p[k]) return p[k];
    return (node.labels && node.labels[0]) || "Node";
  }

  function isNodeValue(v) {
    return v && typeof v === "object" && typeof v.elementId === "string" && Array.isArray(v.labels) && v.properties && typeof v.properties === "object";
  }
  function isRelValue(v) {
    return v && typeof v === "object" && typeof v.elementId === "string" && typeof v.type === "string" &&
      v.startNodeElementId != null && v.endNodeElementId != null;
  }
  function isPathValue(v) {
    if (!Array.isArray(v) || v.length < 3 || v.length % 2 === 0) return false;
    for (var i = 0; i < v.length; i++) if (i % 2 === 0 ? !isNodeValue(v[i]) : !isRelValue(v[i])) return false;
    return true;
  }

  /* ==================================================================== */
  /* 2. Cypher highlighting                                               */
  /* ==================================================================== */

  var KEYWORDS = {};
  ("MATCH OPTIONAL WHERE RETURN WITH UNWIND ORDER BY SKIP LIMIT AS AND OR NOT XOR IN IS NULL TRUE FALSE DISTINCT " +
    "ASC DESC ASCENDING DESCENDING CONTAINS STARTS ENDS CREATE MERGE DELETE DETACH SET REMOVE CALL YIELD UNION CASE WHEN THEN ELSE END")
    .split(" ").forEach(function (k) { KEYWORDS[k] = true; });

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlight(src) {
    var out = "";
    var i = 0;
    var stack = [];
    var prev = "";
    function emit(cls, text, style) {
      out += "<span class=\"tok-" + cls + "\"" + (style ? " style=\"" + style + "\"" : "") + ">" + escapeHtml(text) + "</span>";
    }
    while (i < src.length) {
      var rest = src.slice(i);
      var m;
      if ((m = /^\s+/.exec(rest))) { out += m[0]; i += m[0].length; continue; }
      if ((m = /^\/\/[^\n]*/.exec(rest)) || (m = /^\/\*[\s\S]*?(\*\/|$)/.exec(rest))) { emit("com", m[0]); i += m[0].length; continue; }
      if ((m = /^'(?:\\.|[^'\\])*'?/.exec(rest)) || (m = /^"(?:\\.|[^"\\])*"?/.exec(rest))) { emit("str", m[0]); i += m[0].length; prev = "v"; continue; }
      if ((m = /^`[^`]*`?/.exec(rest)) || (m = /^\$[A-Za-z_]\w*/.exec(rest))) { emit("id", m[0]); i += m[0].length; prev = "v"; continue; }
      if ((m = /^\d+(\.\d+)?/.exec(rest))) { emit("num", m[0]); i += m[0].length; prev = "v"; continue; }
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
        var word = m[0];
        var top = stack[stack.length - 1];
        if ((prev === ":" || prev === "|") && top === "[") emit("type", word);
        else if ((prev === ":" || prev === "|") && top === "(") emit("label", word, "color:" + colorFor(word));
        else if (prev === ".") emit("id", word);
        else if (KEYWORDS[word.toUpperCase()]) emit("kw", word);
        else if (/^\s*\(/.test(rest.slice(word.length))) emit("fn", word);
        else emit("id", word);
        i += word.length;
        prev = "v";
        continue;
      }
      var c = src[i];
      if (c === "(" || c === "[" || c === "{") stack.push(c);
      else if (c === ")" || c === "]" || c === "}") stack.pop();
      emit("punct", c);
      prev = c;
      i++;
    }
    return out;
  }

  /* ==================================================================== */
  /* 3. Graph view                                                        */
  /* ==================================================================== */

  var MAX_ZOOM = 3.5;
  var FIT_ZOOM = 1.35; /* Small results are not blown up to fill the view. */
  var FIT_PADDING = 64;
  var cy = null;
  var selected = null;
  var graphHandlers = { select: function () {}, expand: function () {} };

  function initGraph(container) {
    if (typeof window.cytoscape !== "function") return null;
    var instance = window.cytoscape({
      container: container,
      elements: [],
      minZoom: 0.25,
      maxZoom: MAX_ZOOM,
      userZoomingEnabled: touch,
      boxSelectionEnabled: false,
      selectionType: "single",
      style: [
        {
          selector: "node",
          style: {
            width: "data(size)",
            height: "data(size)",
            "background-color": "data(color)",
            "border-width": 0,
            label: "data(caption)",
            color: "#cfcfcf",
            "font-family": "Geist, system-ui, sans-serif",
            "font-size": 11,
            "font-weight": 500,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 7,
            "text-wrap": "ellipsis",
            "text-max-width": 130,
            "min-zoomed-font-size": 5,
            "underlay-color": "data(color)",
            "underlay-opacity": 0.13,
            "underlay-padding": 6,
            "underlay-shape": "ellipse",
            "overlay-opacity": 0,
            "transition-property": "opacity, underlay-opacity, underlay-padding, text-opacity",
            "transition-duration": reduceMotion ? "0ms" : "160ms"
          }
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": "#3b3b3b",
            "target-arrow-color": "#525252",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.75,
            "curve-style": "bezier",
            "overlay-opacity": 0,
            "font-family": "Geist Mono, ui-monospace, monospace",
            "font-size": 8,
            color: "#a6a6a6",
            "text-rotation": "autorotate",
            "text-background-color": "#0a0a0a",
            "text-background-opacity": 1,
            "text-background-padding": 3,
            "min-zoomed-font-size": 6,
            "transition-property": "opacity, line-color, target-arrow-color",
            "transition-duration": reduceMotion ? "0ms" : "160ms"
          }
        },
        { selector: "edge.typed", style: { label: "data(type)" } },
        { selector: ".dim", style: { opacity: 0.13 } },
        { selector: "node.dim", style: { "text-opacity": 0 } },
        { selector: "node.lit", style: { color: "#fff", "underlay-opacity": 0.22 } },
        { selector: "edge.lit", style: { "line-color": "#d9d9d9", "target-arrow-color": "#d9d9d9", label: "data(type)", color: "#e6e6e6", "z-index": 10 } },
        { selector: "node:selected", style: { "border-width": 2, "border-color": "#fff", "underlay-opacity": 0.32, "underlay-padding": 11, color: "#fff" } },
        { selector: "edge:selected", style: { width: 1.5, "line-color": "#fff", "target-arrow-color": "#fff", label: "data(type)", color: "#fff" } }
      ]
    });

    instance.on("tap", function (evt) {
      if (evt.target === instance) { selected = null; clearSpotlight(); graphHandlers.select(null); return; }
      selected = evt.target;
      spotlight(selected);
      graphHandlers.select(selected);
    });
    instance.on("dbltap", "node", function (evt) { graphHandlers.expand(evt.target); });
    instance.on("mouseover", "node, edge", function (evt) { container.style.cursor = "pointer"; spotlight(evt.target); });
    instance.on("mouseout", "node, edge", function () {
      container.style.cursor = "";
      if (selected && selected.inside()) spotlight(selected); else clearSpotlight();
    });

    /* Plain scrolling moves the page. Zoom needs Ctrl or the Command key (a trackpad pinch sends Ctrl). */
    container.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      var rect = container.getBoundingClientRect();
      var level = Math.max(instance.minZoom(), Math.min(instance.maxZoom(), instance.zoom() * Math.exp(-e.deltaY * 0.0025)));
      instance.zoom({ level: level, renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top } });
    }, { passive: false });

    return instance;
  }

  function spotlight(ele) {
    if (!cy) return;
    cy.batch(function () {
      cy.elements().removeClass("lit").addClass("dim");
      var hood = ele.isNode() ? ele.closedNeighborhood() : ele.union(ele.connectedNodes());
      hood.removeClass("dim").addClass("lit");
    });
  }

  function clearSpotlight() {
    if (cy) cy.elements().removeClass("dim lit");
  }

  /* Fit the graph into the part of the view the inspector does not cover. */
  function fitView(animate) {
    if (!cy || !cy.elements().length) return;
    var box = cy.elements().boundingBox();
    var width = cy.width();
    var height = cy.height();
    var inspector = document.getElementById("inspector");
    if (inspector && !inspector.hidden && width > 720) width -= inspector.offsetWidth + 14;
    var zoom = Math.min(
      (width - FIT_PADDING * 2) / Math.max(box.w, 1),
      (height - FIT_PADDING * 2) / Math.max(box.h, 1),
      FIT_ZOOM
    );
    zoom = Math.max(zoom, cy.minZoom());
    var pan = { x: width / 2 - zoom * (box.x1 + box.w / 2), y: height / 2 - zoom * (box.y1 + box.h / 2) };
    if (animate && !reduceMotion) cy.animate({ zoom: zoom, pan: pan }, { duration: 260, easing: "ease-out-cubic" });
    else cy.viewport({ zoom: zoom, pan: pan });
  }

  function collectGraph(values) {
    var nodes = new Map();
    var rels = new Map();
    (function walk(v) {
      if (v == null || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (isNodeValue(v)) { nodes.set(v.elementId, v); return; }
      if (isRelValue(v)) { rels.set(v.elementId, v); return; }
      Object.keys(v).forEach(function (k) { walk(v[k]); });
    })(values);
    return { nodes: nodes, rels: rels };
  }

  function layoutOptions(fresh) {
    var hasFcose = false;
    try { hasFcose = !!window.cytoscape("layout", "fcose"); } catch (e) { hasFcose = false; }
    var common = { animate: !reduceMotion, animationDuration: 900, animationEasing: "ease-out-cubic", fit: true, padding: FIT_PADDING, nodeDimensionsIncludeLabels: true };
    if (hasFcose) {
      return Object.assign(common, {
        name: "fcose",
        quality: "default",
        randomize: fresh,
        packComponents: false,
        nodeRepulsion: function () { return 16000; },
        idealEdgeLength: function () { return 92; },
        edgeElasticity: function () { return 0.35; },
        nodeSeparation: 110,
        gravity: 0.22,
        numIter: 2500
      });
    }
    return Object.assign(common, { name: "cose", randomize: fresh, nodeRepulsion: function () { return 9000; }, idealEdgeLength: function () { return 90; } });
  }

  /* Returns { nodes, rels, addedNodes, addedRels, hidden }. */
  function drawGraph(graph, options) {
    var additive = !!(options && options.additive);
    var anchor = options && options.anchor;
    var add = [];
    var addedNodes = 0;
    var addedRels = 0;
    var hidden = 0;

    cy.batch(function () {
      if (!additive) { cy.elements().remove(); selected = null; }
      graph.nodes.forEach(function (n) {
        if (cy.getElementById(n.elementId).nonempty()) return;
        var label = n.labels[0] || "";
        var item = { group: "nodes", data: { id: n.elementId, label: label, caption: captionOf(n), color: colorFor(label), size: 16, raw: n } };
        if (anchor) item.position = { x: anchor.x + (Math.random() - 0.5) * 60, y: anchor.y + (Math.random() - 0.5) * 60 };
        add.push(item);
        addedNodes++;
      });
      var known = function (id) { return graph.nodes.has(id) || cy.getElementById(id).nonempty(); };
      graph.rels.forEach(function (r) {
        if (cy.getElementById(r.elementId).nonempty()) return;
        if (!known(r.startNodeElementId) || !known(r.endNodeElementId)) { hidden++; return; }
        add.push({ group: "edges", data: { id: r.elementId, source: r.startNodeElementId, target: r.endNodeElementId, type: r.type, raw: r } });
        addedRels++;
      });
      cy.add(add);
      cy.nodes().forEach(function (n) { n.data("size", 11 + Math.min(24, Math.sqrt(n.degree(false)) * 5.5)); });
      cy.edges().toggleClass("typed", cy.edges().length <= 14);
    });

    if (add.length) {
      var layout = cy.layout(layoutOptions(!additive));
      cy.maxZoom(FIT_ZOOM);
      layout.one("layoutstop", function () {
        cy.maxZoom(MAX_ZOOM);
        if (additive) fitView(true);
      });
      layout.run();
    }
    return { nodes: cy.nodes().length, rels: cy.edges().length, addedNodes: addedNodes, addedRels: addedRels, hidden: hidden };
  }

  /* ==================================================================== */
  /* 4. Console                                                           */
  /* ==================================================================== */

  var QUESTIONS = [
    {
      ask: "Show me the whole graph",
      cypher: "MATCH (n)-[r]->(m)\nRETURN n, r, m"
    },
    {
      ask: "Who works on Atlas?",
      cypher: "MATCH (p:Person)-[r:WORKS_ON|LEADS]->(proj:Project {name: 'Atlas'})\nRETURN p, r, proj"
    },
    {
      ask: "Which projects depend on each other?",
      cypher: "MATCH (a:Project)-[d:DEPENDS_ON]->(b:Project)\nRETURN a, d, b"
    },
    {
      ask: "How is Priya connected to Vantage Geodata?",
      cypher: "MATCH path = shortestPath(\n  (a:Person {name: 'Priya Raman'})-[*..6]-(o:Organization {name: 'Vantage Geodata'})\n)\nRETURN path"
    },
    {
      ask: "Who can explain entity resolution?",
      cypher: "MATCH (p:Person)-[e:EXPERT_IN]->(t:Technology {name: 'Entity resolution'})\nMATCH (proj:Project)-[u:USES]->(t)\nRETURN p, e, t, u, proj"
    },
    {
      ask: "What has been written about Meridian?",
      cypher: "MATCH (author:Person)-[w:AUTHORED]->(d:Document)-[r:DESCRIBES]->(proj:Project {name: 'Meridian'})\nRETURN author, w, d, r, proj"
    },
    {
      ask: "Which technologies are used most?",
      cypher: "MATCH (proj:Project)-[:USES]->(t:Technology)\nRETURN t.name AS technology, count(proj) AS projects\nORDER BY projects DESC, technology"
    }
  ];

  var ANATOMY_QUERY =
    "MATCH (p:Person)-[:WORKS_ON]->(proj:Project)\n" +
    "WHERE proj.status = 'active'\n" +
    "RETURN p.name AS person, count(proj) AS projects\n" +
    "ORDER BY projects DESC, person";

  var ui = {};
  var runToken = 0;
  var lastResult = null;
  var activeTab = "graph";

  function setEditor(text) {
    ui.input.value = text;
    paintEditor();
  }

  function paintEditor() {
    /* The trailing space keeps the highlight layer as tall as the textarea when the text ends in a newline. */
    ui.highlight.innerHTML = highlight(ui.input.value) + " ";
  }

  function markQuestion(index) {
    Array.prototype.forEach.call(ui.questions.querySelectorAll(".question"), function (b, i) {
      b.setAttribute("aria-pressed", i === index ? "true" : "false");
    });
  }

  function selectTab(name, focus) {
    activeTab = name;
    ["graph", "table", "json"].forEach(function (t) {
      var on = t === name;
      var tab = $("tab-" + t);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      $("view-" + t).hidden = !on;
      if (on && focus) tab.focus();
    });
    if (name === "graph" && cy) { cy.resize(); fitView(false); }
    ui.foot.hidden = name !== "graph";
  }

  function message(state, title, text, code, action) {
    var box = el("div", { class: "view-message", "data-state": state }, [
      el("h4", { text: title }),
      el("p", { text: text }),
      code ? el("code", { text: code }) : null
    ]);
    if (action) {
      var b = el("button", { class: "btn btn-outline btn-small", type: "button", text: action.label });
      b.addEventListener("click", action.run);
      box.appendChild(b);
    }
    return box;
  }

  function showGraphMessage(node) {
    ui.graphMessage.replaceChildren();
    if (!node) { ui.graphMessage.hidden = true; return; }
    /* Reuse the element's own box so it covers the canvas. */
    ui.graphMessage.dataset.state = node.dataset.state;
    while (node.firstChild) ui.graphMessage.appendChild(node.firstChild);
    ui.graphMessage.hidden = false;
  }

  function setBusy(busy) {
    ui.run.disabled = busy;
    ui.run.textContent = busy ? "Running" : "Run query";
    ui.canvas.classList.toggle("is-busy", busy);
  }

  function updateLegend() {
    ui.legend.replaceChildren();
    if (!cy) return;
    var counts = {};
    cy.nodes().forEach(function (n) { var l = n.data("label") || "Unlabelled"; counts[l] = (counts[l] || 0) + 1; });
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); }).forEach(function (l) {
      ui.legend.appendChild(el("li", null, [
        el("span", { class: "swatch", style: "color:" + colorFor(l === "Unlabelled" ? "" : l) }),
        l + " ",
        el("b", { text: String(counts[l]) })
      ]));
    });
  }

  /* ----- value rendering for the table ----- */

  function entityCell(node) {
    return el("span", { class: "cell-entity" }, [
      el("span", { class: "swatch", style: "color:" + colorFor(node.labels[0]) }),
      captionOf(node),
      node.labels[0] ? el("small", { text: node.labels[0] }) : null
    ]);
  }

  function renderValue(v) {
    if (v == null) return el("span", { class: "cell-null", text: "null" });
    if (isNodeValue(v)) return entityCell(v);
    if (isRelValue(v)) return el("span", { class: "cell-rel", text: "[:" + v.type + "]" });
    if (isPathValue(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i += 2) {
        if (i > 0) parts.push(v[i - 1].startNodeElementId === v[i - 2].elementId ? " \u2192 " : " \u2190 ");
        parts.push(captionOf(v[i]));
      }
      return el("span", null, [parts.join(""), " ", el("small", { class: "cell-rel", text: "(" + plural((v.length - 1) / 2, "hop") + ")" })]);
    }
    if (Array.isArray(v)) {
      var wrap = el("span");
      v.forEach(function (item, idx) {
        if (idx) wrap.appendChild(document.createTextNode(", "));
        wrap.appendChild(renderValue(item));
      });
      if (!v.length) wrap.appendChild(el("span", { class: "cell-null", text: "empty list" }));
      return wrap;
    }
    if (typeof v === "object") return el("span", { class: "cell-rel", text: JSON.stringify(v) });
    return document.createTextNode(typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: false }) : String(v));
  }

  var TABLE_ROWS = 500;

  function renderTable(result) {
    var table = el("table", { class: "result-table" });
    var head = el("tr");
    result.fields.forEach(function (f) { head.appendChild(el("th", { scope: "col", text: f })); });
    table.appendChild(el("thead", null, [head]));
    var body = el("tbody");
    result.values.slice(0, TABLE_ROWS).forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (v) {
        var td = el("td", typeof v === "number" ? { class: "is-number" } : null);
        td.appendChild(renderValue(v));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    ui.table.replaceChildren(table);
    if (result.values.length > TABLE_ROWS || result.truncated) {
      ui.table.appendChild(el("p", {
        class: "table-note",
        text: "Showing the first " + Math.min(TABLE_ROWS, result.values.length).toLocaleString("en-US") + " rows. Add a LIMIT, or open the JSON tab for everything returned."
      }));
    }
  }

  function renderJson(raw) {
    var text = JSON.stringify(raw, null, 2) || "";
    var cap = 400000;
    ui.json.textContent = text.length > cap ? text.slice(0, cap) + "\n\n(The rest is left out to keep the page responsive.)" : text;
  }

  /* ----- inspector ----- */

  function closeIcon() {
    var span = el("span");
    span.innerHTML = "<svg viewBox=\"0 0 16 16\" width=\"13\" height=\"13\" aria-hidden=\"true\"><path d=\"M3.5 3.5l9 9M12.5 3.5l-9 9\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></svg>";
    return span.firstChild;
  }

  function propsList(properties) {
    var keys = Object.keys(properties || {});
    if (!keys.length) return el("p", { class: "inspector-sub", text: "No properties." });
    var dl = el("dl", { class: "props" });
    keys.forEach(function (k) {
      var v = properties[k];
      dl.appendChild(el("dt", { text: k }));
      dl.appendChild(el("dd", { text: v != null && typeof v === "object" ? JSON.stringify(v) : String(v) }));
    });
    return dl;
  }

  function showInspector(ele) {
    var box = ui.inspector;
    box.replaceChildren();
    if (!ele) { box.hidden = true; return; }
    var raw = ele.data("raw");
    var close = el("button", { class: "icon-btn inspector-close", type: "button", "aria-label": "Close details" }, [closeIcon()]);
    close.addEventListener("click", function () {
      if (cy) cy.elements().unselect();
      selected = null;
      clearSpotlight();
      showInspector(null);
    });

    if (ele.isNode()) {
      var label = raw.labels[0] || "Unlabelled";
      box.appendChild(el("div", { class: "inspector-head" }, [
        el("p", { class: "inspector-kind" }, [el("span", { class: "swatch", style: "color:" + colorFor(raw.labels[0]) }), raw.labels.join(", ") || label]),
        close
      ]));
      box.appendChild(el("h4", { class: "inspector-title", text: captionOf(raw) }));
      box.appendChild(el("p", { class: "inspector-sub", text: plural(ele.degree(false), "connection") + " in this view" }));
      box.appendChild(propsList(raw.properties));
      var expand = el("button", { class: "btn btn-outline btn-small inspector-action", type: "button", text: "Expand connections" });
      expand.addEventListener("click", function () { graphHandlers.expand(ele); });
      box.appendChild(expand);
    } else {
      box.appendChild(el("div", { class: "inspector-head" }, [
        el("p", { class: "inspector-kind" }, ["Relationship ", el("code", { text: raw.type })]),
        close
      ]));
      box.appendChild(el("h4", { class: "inspector-title", text: ele.source().data("caption") + " \u2192 " + ele.target().data("caption") }));
      box.appendChild(propsList(raw.properties));
    }
    box.hidden = false;
  }

  /* ----- running a query ----- */

  function showError(result) {
    var first = result.errors[0] || { code: "", message: "The query failed." };
    ui.stat.textContent = "Query failed";
    ui.stat.dataset.state = "error";
    showInspector(null);
    showGraphMessage(message("error", "This query didn't run", first.message, first.code));
    ui.table.replaceChildren(message("error", "This query didn't run", first.message, first.code));
    ui.table.firstChild.style.position = "static";
    ui.table.firstChild.style.height = "100%";
    renderJson(result.raw);
  }

  function showResult(result) {
    lastResult = result;
    delete ui.stat.dataset.state;
    var rows = result.values.length;
    var graph = collectGraph(result.values);
    renderTable(result);
    renderJson(result.raw);
    showInspector(null);
    var ms = Math.max(1, Math.round(result.ms));

    if (!rows) {
      if (cy) { cy.elements().remove(); updateLegend(); }
      var empty = message("empty", "No matches", "The query ran, but nothing in the graph fits this pattern. Loosen a filter, or check the label names in the schema below.");
      showGraphMessage(empty);
      ui.stat.textContent = "0 rows in " + ms + " ms";
      return;
    }

    if (!graph.nodes.size) {
      if (cy) { cy.elements().remove(); updateLegend(); }
      showGraphMessage(message("empty", "This result is a table", "The query returned values, not nodes, so there is nothing to draw. Return the nodes themselves to see them as a graph.", null, {
        label: "Show the table",
        run: function () { selectTab("table", true); }
      }));
      ui.stat.textContent = plural(rows, "row") + " in " + ms + " ms";
      if (activeTab === "graph") selectTab("table");
      return;
    }

    if (!cy) {
      showGraphMessage(message("error", "The graph view couldn't load", "The drawing library is missing. Check that the assets/vendor folder sits next to this page. The Table and JSON tabs still work."));
      ui.stat.textContent = plural(rows, "row") + " in " + ms + " ms";
      if (activeTab === "graph") selectTab("table");
      return;
    }

    showGraphMessage(null);
    if (activeTab === "table") selectTab("graph");
    var drawn = drawGraph(graph);
    updateLegend();
    var stat = plural(drawn.nodes, "node") + ", " + plural(drawn.rels, "relationship") + " in " + ms + " ms";
    if (drawn.hidden) stat += ". " + plural(drawn.hidden, "relationship") + " not drawn: return both of its nodes to see it";
    ui.stat.textContent = stat;
  }

  async function run(statement) {
    var token = ++runToken;
    setBusy(true);
    delete ui.stat.dataset.state;
    ui.stat.textContent = "Running";
    var result = await query(statement);
    if (token !== runToken) return result;
    setBusy(false);
    if (result.ok) showResult(result); else showError(result);
    return result;
  }

  async function expandNode(ele) {
    var raw = ele.data("raw");
    var id = String(raw.elementId).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var token = ++runToken;
    setBusy(true);
    var result = await query("MATCH (n)-[r]-(m) WHERE elementId(n) = '" + id + "' RETURN n, r, m");
    if (token !== runToken) return;
    setBusy(false);
    if (!result.ok) { showError(result); return; }
    var drawn = drawGraph(collectGraph(result.values), { additive: true, anchor: ele.position() });
    updateLegend();
    delete ui.stat.dataset.state;
    ui.stat.textContent = drawn.addedNodes || drawn.addedRels
      ? "Added " + plural(drawn.addedNodes, "node") + " and " + plural(drawn.addedRels, "relationship") + " around " + captionOf(raw)
      : "Everything connected to " + captionOf(raw) + " is already shown";
    if (ele.inside()) { selected = ele; ele.select(); spotlight(ele); showInspector(ele); }
  }

  function runInConsole(statement) {
    setEditor(statement);
    markQuestion(-1);
    $("console").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    return run(statement);
  }

  /* ==================================================================== */
  /* 5. Schema                                                            */
  /* ==================================================================== */

  var LABELS_QUERY = "MATCH (n)\nRETURN labels(n)[0] AS label, count(*) AS total\nORDER BY total DESC, label";
  var RELS_QUERY = "MATCH (a)-[r]->(b)\nRETURN labels(a)[0] AS source, type(r) AS type, labels(b)[0] AS target, count(*) AS total\nORDER BY total DESC, type";

  function quoteName(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + String(name).replace(/`/g, "") + "`";
  }

  async function loadSchema() {
    var labelsBox = $("schema-labels");
    var relsBox = $("schema-rels");
    var results = await Promise.all([query(LABELS_QUERY), query(RELS_QUERY)]);
    var labels = results[0];
    var rels = results[1];
    var hero = $("hero-status");

    if (!labels.ok || !rels.ok) {
      var why = ((labels.ok ? rels : labels).errors[0] || {}).message || "The schema couldn't be read.";
      labelsBox.replaceChildren(el("li", { class: "schema-error", text: why }));
      relsBox.replaceChildren(el("li", { class: "schema-error", text: "Relationships will appear here once the endpoint answers." }));
      hero.dataset.state = "error";
      $("endpoint-chip").dataset.state = "error";
      $("hero-status-text").textContent = live ? "Can't reach " + endpointHost() : "The sample graph didn't load";
      return;
    }

    var totalNodes = 0;
    var totalRels = 0;
    var max = labels.values.reduce(function (m, r) { return Math.max(m, r[1]); }, 1);

    labelsBox.replaceChildren();
    labels.values.forEach(function (row) {
      var label = row[0];
      var count = row[1];
      totalNodes += count;
      var name = label == null ? "Unlabelled" : label;
      var button = el("button", { class: "schema-row schema-row-label", type: "button", "aria-label": "Show " + plural(count, name + " node") + " in the console" }, [
        el("span", { class: "schema-name" }, [el("span", { class: "swatch", style: "color:" + colorFor(label) }), name]),
        el("span", { class: "schema-bar", style: "color:" + colorFor(label) }, [el("i", { style: "width:" + Math.max(3, (count / max) * 100).toFixed(1) + "%" })]),
        el("span", { class: "schema-count", text: count.toLocaleString("en-US") })
      ]);
      button.addEventListener("click", function () {
        runInConsole(label == null ? "MATCH (n)\nWHERE size(labels(n)) = 0\nRETURN n\nLIMIT 100" : "MATCH (n:" + quoteName(label) + ")\nRETURN n\nLIMIT 100");
      });
      labelsBox.appendChild(el("li", null, [button]));
    });

    relsBox.replaceChildren();
    rels.values.forEach(function (row) {
      var source = row[0];
      var type = row[1];
      var target = row[2];
      var count = row[3];
      totalRels += count;
      var pattern = el("span", { class: "schema-pattern" }, [
        "(", el("span", { style: "color:" + colorFor(source), text: source || "" }), ")-[",
        el("span", { class: "rel-type", text: type }), "]->(",
        el("span", { style: "color:" + colorFor(target), text: target || "" }), ")"
      ]);
      var button = el("button", {
        class: "schema-row schema-row-rel", type: "button",
        "aria-label": "Show " + (source || "any") + " " + type + " " + (target || "any") + ", " + plural(count, "relationship") + ", in the console"
      }, [pattern, el("span", { class: "schema-count", text: count.toLocaleString("en-US") })]);
      button.addEventListener("click", function () {
        runInConsole(
          "MATCH (a" + (source ? ":" + quoteName(source) : "") + ")-[r:" + quoteName(type) + "]->(b" + (target ? ":" + quoteName(target) : "") + ")\nRETURN a, r, b\nLIMIT 200"
        );
      });
      relsBox.appendChild(el("li", null, [button]));
    });

    hero.dataset.state = live ? "live" : "ready";
    $("hero-status-text").textContent =
      (live ? "Connected to " + endpointHost() : "Sample graph loaded") + ": " + plural(totalNodes, "node") + ", " + plural(totalRels, "relationship");
  }

  /* ==================================================================== */
  /* Start                                                                */
  /* ==================================================================== */

  function renderConfigPreview() {
    function line(key, value, comma) {
      return "  <span class=\"cfg-key\">" + key + "</span>: <span class=\"cfg-val\">" + escapeHtml(JSON.stringify(value)) + "</span>" + (comma ? "," : "") + "\n";
    }
    var hasAuth = !!(config.auth && config.auth.username);
    $("config-preview").innerHTML =
      "window.GI_CONFIG = {\n" +
      line("mode", live ? "live" : "sample", true) +
      line("endpoint", config.endpoint, true) +
      "  <span class=\"cfg-key\">auth</span>: { <span class=\"cfg-key\">username</span>: <span class=\"cfg-val\">" +
      escapeHtml(JSON.stringify(hasAuth ? config.auth.username : "")) +
      "</span>, <span class=\"cfg-key\">password</span>: <span class=\"cfg-val\">" + (hasAuth ? "\"(hidden)\"" : "\"\"") + "</span> }\n" +
      "};";
  }

  function waitForFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = Promise.all([document.fonts.load("450 11px Geist"), document.fonts.load("8px 'Geist Mono'")]).catch(function () {});
    return Promise.race([loads, new Promise(function (r) { setTimeout(r, 1500); })]);
  }

  async function start() {
    ui = {
      input: $("editor-input"),
      highlight: $("editor-highlight"),
      run: $("run-button"),
      questions: $("question-list"),
      stat: $("result-stat"),
      canvas: $("graph-canvas"),
      legend: $("legend"),
      inspector: $("inspector"),
      graphMessage: $("graph-message"),
      table: $("table-scroll"),
      json: $("json-output"),
      foot: $("console-foot")
    };

    /* Static text that depends on the device or the settings. */
    $("run-shortcut").textContent = isMac ? "\u2318" : "Ctrl";
    if (touch) {
      ui.foot.textContent = "Drag to pan. Pinch to zoom. Double-tap a node to expand it.";
    } else {
      ui.foot.querySelector(".mod-key").textContent = isMac ? "\u2318" : "Ctrl";
    }
    $("hero-status").dataset.state = "loading";
    var chip = $("endpoint-chip");
    chip.dataset.state = live ? "live" : "ready";
    $("endpoint-chip-text").textContent = live ? "Live: " + endpointHost() : "Sample endpoint";
    if (live) {
      $("connect-subtitle").textContent = "Queries are going to " + endpointHost() + ".";
      $("footer-note").textContent = "Live mode. Queries are sent to " + endpointHost() + ".";
    }
    renderConfigPreview();
    Array.prototype.forEach.call(document.querySelectorAll("code[data-cypher]"), function (code) {
      code.innerHTML = highlight(code.textContent);
    });

    /* Questions. */
    QUESTIONS.forEach(function (q, index) {
      var button = el("button", { class: "question", type: "button", "aria-pressed": "false", text: q.ask });
      button.addEventListener("click", function () {
        setEditor(q.cypher);
        markQuestion(index);
        run(q.cypher);
      });
      ui.questions.appendChild(el("li", null, [button]));
    });

    /* Editor. */
    ui.input.addEventListener("input", function () { paintEditor(); markQuestion(-1); });
    ui.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(ui.input.value); }
    });
    ui.run.addEventListener("click", function () { run(ui.input.value); });

    /* Tabs. */
    var order = ["graph", "table", "json"];
    order.forEach(function (name) {
      var tab = $("tab-" + name);
      tab.addEventListener("click", function () { selectTab(name); });
      tab.addEventListener("keydown", function (e) {
        var i = order.indexOf(name);
        if (e.key === "ArrowRight") { e.preventDefault(); selectTab(order[(i + 1) % 3], true); }
        if (e.key === "ArrowLeft") { e.preventDefault(); selectTab(order[(i + 2) % 3], true); }
      });
    });

    $("run-anatomy").addEventListener("click", function () { runInConsole(ANATOMY_QUERY); });

    /* Graph. */
    await waitForFonts();
    cy = initGraph(ui.canvas);
    if (cy) {
      graphHandlers.select = showInspector;
      graphHandlers.expand = expandNode;
      var step = function (factor) {
        var level = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * factor));
        var centre = { x: cy.width() / 2, y: cy.height() / 2 };
        if (reduceMotion) cy.zoom({ level: level, renderedPosition: centre });
        else cy.animate({ zoom: { level: level, renderedPosition: centre } }, { duration: 160 });
      };
      $("zoom-in").addEventListener("click", function () { step(1.35); });
      $("zoom-out").addEventListener("click", function () { step(1 / 1.35); });
      $("zoom-fit").addEventListener("click", function () { fitView(true); });
      var resizeTimer;
      window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { if (activeTab === "graph") { cy.resize(); fitView(false); } }, 150);
      });
    }

    GI.app = { run: run, runInConsole: runInConsole, query: query, cy: cy, highlight: highlight };

    /* First paint: the first question, and the schema counts. */
    setEditor(QUESTIONS[0].cypher);
    markQuestion(0);
    run(QUESTIONS[0].cypher);
    loadSchema();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
