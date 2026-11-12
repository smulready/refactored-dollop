/*
 * Graph Intelligence: sample endpoint.
 *
 * A stand-in for the live Neo4j endpoint. It accepts the same request body
 * the console sends to a real server ({ statement, parameters }) and answers
 * in the same shape ({ data: { fields, values } } or { errors: [...] }),
 * evaluating a read-only subset of Cypher against GI.sampleGraph.
 *
 * Supported:
 *   MATCH <patterns> [WHERE <expr>]  (one or more MATCH clauses)
 *   RETURN [DISTINCT] <items | *> [ORDER BY ...] [SKIP n] [LIMIT n]
 *   Node and relationship patterns, labels, types, property maps,
 *   direction, variable length ([*], [*2], [*1..3]), path variables,
 *   shortestPath(...), count / collect / sum / avg / min / max, and the
 *   scalar functions listed in FUNCTIONS below.
 *
 * Not supported: writes, WITH, UNWIND, OPTIONAL MATCH, CALL, UNION, CASE,
 * pattern predicates in WHERE. Those need the live endpoint.
 */
(function (root) {
  "use strict";
  var GI = (root.GI = root.GI || {});

  /* ------------------------------------------------------------------ */
  /* Errors                                                              */
  /* ------------------------------------------------------------------ */

  function CypherError(message, code, pos) {
    this.name = "CypherError";
    this.message = message;
    this.code = code || "Neo.ClientError.Statement.SyntaxError";
    this.pos = pos == null ? null : pos;
  }
  CypherError.prototype = Object.create(Error.prototype);

  function unsupported(what, pos) {
    return new CypherError(
      what + " is not available on the sample endpoint. It supports MATCH, WHERE and RETURN. Connect a live endpoint for full Cypher.",
      "GI.Sample.NotSupported",
      pos
    );
  }

  /* ------------------------------------------------------------------ */
  /* Tokenizer                                                           */
  /* ------------------------------------------------------------------ */

  var TWO_CHAR = { "<=": 1, ">=": 1, "<>": 1, "..": 1 };
  var ONE_CHAR = "()[]{}:,.|*=<>-+/%;";

  function tokenize(src) {
    var out = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { var e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      var start = i;
      if (c === "'" || c === '"') {
        var s = "";
        i++;
        while (i < n && src[i] !== c) {
          if (src[i] === "\\" && i + 1 < n) {
            var esc = src[i + 1];
            s += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
            i += 2;
          } else {
            s += src[i++];
          }
        }
        if (i >= n) throw new CypherError("This string is never closed. Add a matching " + c + ".", null, start);
        i++;
        out.push({ t: "str", v: s, pos: start, end: i });
        continue;
      }
      if (c === "`") {
        var close = src.indexOf("`", i + 1);
        if (close < 0) throw new CypherError("This backtick name is never closed.", null, start);
        out.push({ t: "id", v: src.slice(i + 1, close), quoted: true, pos: start, end: close + 1 });
        i = close + 1;
        continue;
      }
      if (/[0-9]/.test(c)) {
        var m = /^\d+(\.\d+)?/.exec(src.slice(i));
        i += m[0].length;
        out.push({ t: "num", v: Number(m[0]), pos: start, end: i });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        i += w[0].length;
        out.push({ t: "id", v: w[0], pos: start, end: i });
        continue;
      }
      if (c === "$") {
        var p = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        if (!p) throw new CypherError("Expected a parameter name after $.", null, start);
        i += p[0].length;
        out.push({ t: "param", v: p[0].slice(1), pos: start, end: i });
        continue;
      }
      var two = src.substr(i, 2);
      if (TWO_CHAR[two]) { i += 2; out.push({ t: "op", v: two, pos: start, end: i }); continue; }
      if (ONE_CHAR.indexOf(c) >= 0) { i++; out.push({ t: "op", v: c, pos: start, end: i }); continue; }
      throw new CypherError("Unexpected character " + JSON.stringify(c) + ".", null, start);
    }
    out.push({ t: "eof", v: "", pos: n, end: n });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Parser                                                              */
  /* ------------------------------------------------------------------ */

  var WRITE_CLAUSES = { CREATE: 1, MERGE: 1, DELETE: 1, DETACH: 1, SET: 1, REMOVE: 1, DROP: 1, LOAD: 1, FOREACH: 1 };
  var OTHER_CLAUSES = { WITH: 1, UNWIND: 1, OPTIONAL: 1, CALL: 1, UNION: 1, USE: 1, SHOW: 1 };
  var RESERVED = {
    MATCH: 1, WHERE: 1, RETURN: 1, ORDER: 1, BY: 1, SKIP: 1, LIMIT: 1, AND: 1, OR: 1, NOT: 1, XOR: 1,
    AS: 1, IN: 1, IS: 1, CONTAINS: 1, STARTS: 1, ENDS: 1, DISTINCT: 1, ASC: 1, DESC: 1,
    ASCENDING: 1, DESCENDING: 1
  };
  var AGGREGATES = { count: 1, collect: 1, sum: 1, avg: 1, min: 1, max: 1 };

  function Parser(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.i = 0;
    this.vars = [];
  }

  Parser.prototype.peek = function (k) { return this.toks[this.i + (k || 0)]; };
  Parser.prototype.next = function () { return this.toks[this.i++]; };
  Parser.prototype.isOp = function (v, k) { var t = this.peek(k); return t.t === "op" && t.v === v; };
  Parser.prototype.isKw = function (v, k) { var t = this.peek(k); return t.t === "id" && !t.quoted && t.v.toUpperCase() === v; };
  Parser.prototype.eatOp = function (v) { if (this.isOp(v)) { this.i++; return true; } return false; };
  Parser.prototype.eatKw = function (v) { if (this.isKw(v)) { this.i++; return true; } return false; };
  Parser.prototype.describe = function (t) {
    if (t.t === "eof") return "the end of the query";
    if (t.t === "str") return "the string '" + t.v + "'";
    return "'" + t.v + "'";
  };
  Parser.prototype.fail = function (expected) {
    var t = this.peek();
    throw new CypherError("Expected " + expected + " but found " + this.describe(t) + ".", null, t.pos);
  };
  Parser.prototype.expectOp = function (v) { if (!this.eatOp(v)) this.fail("'" + v + "'"); };
  Parser.prototype.ident = function (what) {
    var t = this.peek();
    if (t.t !== "id") this.fail(what);
    this.i++;
    return t.v;
  };
  Parser.prototype.declare = function (name) {
    if (name && this.vars.indexOf(name) < 0) this.vars.push(name);
  };

  Parser.prototype.parseQuery = function () {
    var clauses = [];
    var ret = null;
    for (;;) {
      var t = this.peek();
      if (t.t === "eof") break;
      if (t.t !== "id") this.fail("MATCH or RETURN");
      var kw = t.v.toUpperCase();
      if (kw === "MATCH") {
        this.i++;
        var patterns = [this.parsePattern()];
        while (this.eatOp(",")) patterns.push(this.parsePattern());
        var where = this.eatKw("WHERE") ? this.parseExpr() : null;
        clauses.push({ patterns: patterns, where: where });
      } else if (kw === "RETURN") {
        this.i++;
        ret = this.parseReturn();
        this.eatOp(";");
        if (this.peek().t !== "eof") this.fail("the end of the query after RETURN");
        break;
      } else if (WRITE_CLAUSES[kw]) {
        throw new CypherError(
          "The sample endpoint is read-only, so " + kw + " can't run here. Use MATCH and RETURN to read from the graph.",
          "GI.Sample.ReadOnly",
          t.pos
        );
      } else if (OTHER_CLAUSES[kw]) {
        throw unsupported(kw, t.pos);
      } else {
        this.fail("MATCH or RETURN");
      }
    }
    if (!ret) {
      throw new CypherError("A query needs a RETURN clause to say what comes back. Try adding RETURN * at the end.", null, this.peek().pos);
    }
    return { clauses: clauses, ret: ret, vars: this.vars };
  };

  /* ----- patterns ----- */

  Parser.prototype.parsePattern = function () {
    var pathVar = null;
    if (this.peek().t === "id" && this.isOp("=", 1)) {
      pathVar = this.next().v;
      this.i++;
    }
    var shortest = false;
    if (this.peek().t === "id" && this.isOp("(", 1)) {
      var fn = this.peek().v.toLowerCase();
      if (fn === "shortestpath") {
        shortest = true;
        this.i += 2;
      } else if (fn === "allshortestpaths") {
        throw unsupported("allShortestPaths", this.peek().pos);
      } else {
        this.fail("a pattern such as (n:Label)");
      }
    }
    var startPos = this.peek().pos;
    var chain = this.parseChain();
    if (shortest) {
      this.expectOp(")");
      if (chain.rels.length !== 1) {
        throw new CypherError("shortestPath takes exactly one relationship between two nodes, for example shortestPath((a)-[*..6]-(b)).", null, startPos);
      }
    }
    this.declare(pathVar);
    return { pathVar: pathVar, shortest: shortest, chain: chain };
  };

  Parser.prototype.parseChain = function () {
    var nodes = [this.parseNode()];
    var rels = [];
    while (this.isOp("-") || (this.isOp("<") && this.isOp("-", 1))) {
      rels.push(this.parseRel());
      nodes.push(this.parseNode());
    }
    return { nodes: nodes, rels: rels };
  };

  Parser.prototype.parseNode = function () {
    if (!this.isOp("(")) this.fail("a node pattern such as (n:Label)");
    this.i++;
    var v = null;
    if (this.peek().t === "id") v = this.next().v;
    var labels = [];
    while (this.eatOp(":")) {
      var group = [this.ident("a label name")];
      while (this.eatOp("|")) { this.eatOp(":"); group.push(this.ident("a label name")); }
      labels.push(group);
    }
    var props = this.isOp("{") ? this.parseMap() : null;
    this.expectOp(")");
    this.declare(v);
    return { v: v, labels: labels, props: props };
  };

  Parser.prototype.parseRel = function () {
    var left = this.eatOp("<");
    this.expectOp("-");
    var r = { v: null, types: [], varlen: false, min: 1, max: 1, props: null, dir: "both" };
    if (this.eatOp("[")) {
      if (this.peek().t === "id") r.v = this.next().v;
      if (this.eatOp(":")) {
        r.types.push(this.ident("a relationship type"));
        while (this.eatOp("|")) { this.eatOp(":"); r.types.push(this.ident("a relationship type")); }
      }
      if (this.eatOp("*")) {
        r.varlen = true;
        r.min = 1;
        r.max = Infinity;
        if (this.peek().t === "num") {
          r.min = r.max = this.next().v;
          if (this.eatOp("..")) r.max = this.peek().t === "num" ? this.next().v : Infinity;
        } else if (this.eatOp("..")) {
          r.max = this.peek().t === "num" ? this.next().v : Infinity;
        }
      }
      if (this.isOp("{")) r.props = this.parseMap();
      this.expectOp("]");
    }
    this.expectOp("-");
    var right = this.eatOp(">");
    if (left && right) throw new CypherError("A relationship can point one way or neither, not both. Use -[r]-> or <-[r]- or -[r]-.", null, this.peek().pos);
    r.dir = left ? "in" : right ? "out" : "both";
    this.declare(r.v);
    return r;
  };

  Parser.prototype.parseMap = function () {
    this.expectOp("{");
    var entries = [];
    if (!this.isOp("}")) {
      do {
        var k = this.ident("a property name");
        this.expectOp(":");
        entries.push([k, this.parseExpr()]);
      } while (this.eatOp(","));
    }
    this.expectOp("}");
    return entries;
  };

  /* ----- RETURN ----- */

  Parser.prototype.textOf = function (from, to) {
    var parts = [];
    for (var k = from; k < to; k++) {
      var t = this.toks[k];
      parts.push(t.t === "str" ? JSON.stringify(t.v) : t.t === "id" && !t.quoted ? t.v.toLowerCase() : String(t.v));
    }
    return parts.join(" ");
  };

  Parser.prototype.parseReturn = function () {
    var ret = { distinct: this.eatKw("DISTINCT"), star: false, items: [], order: [], skip: null, limit: null };
    if (this.eatOp("*")) {
      ret.star = true;
      if (this.eatOp(",")) this.parseItems(ret);
    } else {
      this.parseItems(ret);
    }
    if (this.eatKw("ORDER")) {
      if (!this.eatKw("BY")) this.fail("BY after ORDER");
      do {
        var from = this.i;
        var expr = this.parseExpr();
        var text = this.textOf(from, this.i);
        var desc = false;
        if (this.eatKw("DESC") || this.eatKw("DESCENDING")) desc = true;
        else if (this.eatKw("ASC") || this.eatKw("ASCENDING")) desc = false;
        ret.order.push({ expr: expr, text: text, desc: desc });
      } while (this.eatOp(","));
    }
    if (this.eatKw("SKIP")) ret.skip = this.parseExpr();
    if (this.eatKw("LIMIT")) ret.limit = this.parseExpr();
    return ret;
  };

  Parser.prototype.parseItems = function (ret) {
    do {
      var from = this.i;
      var startPos = this.peek().pos;
      var expr = this.parseExpr();
      var endPos = this.toks[this.i - 1].end;
      var text = this.textOf(from, this.i);
      var name = this.src.slice(startPos, endPos).trim();
      var alias = null;
      if (this.eatKw("AS")) { alias = this.ident("a column name after AS"); name = alias; }
      ret.items.push({ expr: expr, name: name, alias: alias, text: text });
    } while (this.eatOp(","));
  };

  /* ----- expressions ----- */

  Parser.prototype.parseExpr = function () { return this.parseOr(); };

  Parser.prototype.parseOr = function () {
    var l = this.parseAnd();
    while (this.eatKw("OR")) l = { k: "or", l: l, r: this.parseAnd() };
    return l;
  };

  Parser.prototype.parseAnd = function () {
    var l = this.parseNot();
    while (this.eatKw("AND")) l = { k: "and", l: l, r: this.parseNot() };
    return l;
  };

  Parser.prototype.parseNot = function () {
    if (this.eatKw("NOT")) return { k: "not", e: this.parseNot() };
    return this.parseCmp();
  };

  Parser.prototype.parseCmp = function () {
    var l = this.parseAdd();
    for (;;) {
      var t = this.peek();
      if (t.t === "op" && (t.v === "=" || t.v === "<>" || t.v === "<" || t.v === ">" || t.v === "<=" || t.v === ">=")) {
        this.i++;
        l = { k: "cmp", op: t.v, l: l, r: this.parseAdd() };
      } else if (this.eatKw("IN")) {
        l = { k: "in", l: l, r: this.parseAdd() };
      } else if (this.eatKw("CONTAINS")) {
        l = { k: "str", op: "contains", l: l, r: this.parseAdd() };
      } else if (this.isKw("STARTS") && this.isKw("WITH", 1)) {
        this.i += 2;
        l = { k: "str", op: "starts", l: l, r: this.parseAdd() };
      } else if (this.isKw("ENDS") && this.isKw("WITH", 1)) {
        this.i += 2;
        l = { k: "str", op: "ends", l: l, r: this.parseAdd() };
      } else if (this.eatKw("IS")) {
        var neg = this.eatKw("NOT");
        if (!this.eatKw("NULL")) this.fail("NULL after IS");
        l = { k: "isnull", e: l, neg: neg };
      } else {
        return l;
      }
    }
  };

  Parser.prototype.parseAdd = function () {
    var l = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      var op = this.next().v;
      l = { k: "arith", op: op, l: l, r: this.parseMul() };
    }
    return l;
  };

  Parser.prototype.parseMul = function () {
    var l = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      var op = this.next().v;
      l = { k: "arith", op: op, l: l, r: this.parseUnary() };
    }
    return l;
  };

  Parser.prototype.parseUnary = function () {
    if (this.eatOp("-")) return { k: "neg", e: this.parseUnary() };
    if (this.eatOp("+")) return this.parseUnary();
    return this.parsePostfix();
  };

  Parser.prototype.parsePostfix = function () {
    var e = this.parseAtom();
    for (;;) {
      if (this.isOp(".") && this.peek(1).t === "id") {
        this.i++;
        e = { k: "prop", e: e, name: this.next().v };
      } else if (this.isOp("[")) {
        this.i++;
        var idx = this.parseExpr();
        this.expectOp("]");
        e = { k: "index", e: e, i: idx };
      } else if (this.isOp(":") && e.k === "var" && this.peek(1).t === "id") {
        this.i++;
        e = { k: "haslabel", e: e, label: this.next().v };
      } else {
        return e;
      }
    }
  };

  Parser.prototype.parseAtom = function () {
    var t = this.peek();
    if (t.t === "num" || t.t === "str") { this.i++; return { k: "lit", v: t.v }; }
    if (t.t === "param") { this.i++; return { k: "param", name: t.v, pos: t.pos }; }
    if (t.t === "op" && t.v === "(") {
      this.i++;
      var inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    if (t.t === "op" && t.v === "[") {
      this.i++;
      var items = [];
      if (!this.isOp("]")) {
        do { items.push(this.parseExpr()); } while (this.eatOp(","));
      }
      this.expectOp("]");
      return { k: "list", items: items };
    }
    if (t.t === "op" && t.v === "{") return { k: "map", entries: this.parseMap() };
    if (t.t === "id") {
      var up = t.v.toUpperCase();
      if (!t.quoted) {
        if (up === "TRUE") { this.i++; return { k: "lit", v: true }; }
        if (up === "FALSE") { this.i++; return { k: "lit", v: false }; }
        if (up === "NULL") { this.i++; return { k: "lit", v: null }; }
        if (up === "CASE" || up === "EXISTS") throw unsupported(up, t.pos);
        if (RESERVED[up] || WRITE_CLAUSES[up] || OTHER_CLAUSES[up]) this.fail("a value or variable");
      }
      if (this.isOp("(", 1) && !t.quoted) {
        this.i += 2;
        var call = { k: "call", name: t.v.toLowerCase(), raw: t.v, args: [], distinct: false, star: false, pos: t.pos };
        if (this.eatOp("*")) {
          call.star = true;
        } else if (!this.isOp(")")) {
          call.distinct = this.eatKw("DISTINCT");
          do { call.args.push(this.parseExpr()); } while (this.eatOp(","));
        }
        this.expectOp(")");
        return call;
      }
      this.i++;
      return { k: "var", name: t.v, pos: t.pos };
    }
    this.fail("a value or variable");
  };

  /* ------------------------------------------------------------------ */
  /* Values                                                              */
  /* ------------------------------------------------------------------ */

  function isNode(v) { return v && v.kind === "node"; }
  function isRel(v) { return v && v.kind === "rel"; }
  function isPath(v) { return v && v.kind === "path"; }

  function keyOf(v) {
    if (v == null) return "null";
    if (isNode(v)) return "n:" + v.elementId;
    if (isRel(v)) return "r:" + v.elementId;
    if (isPath(v)) return "p:" + v.nodes.map(function (n) { return n.elementId; }).join(">") + "|" + v.rels.map(function (r) { return r.elementId; }).join(">");
    if (Array.isArray(v)) return "[" + v.map(keyOf).join(",") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return k + ":" + keyOf(v[k]); }).join(",") + "}";
    return typeof v + ":" + String(v);
  }

  function equal(a, b) {
    if (a == null || b == null) return null;
    return keyOf(a) === keyOf(b);
  }

  function typeRank(v) {
    if (v == null) return 9;
    if (typeof v === "number") return 1;
    if (typeof v === "string") return 2;
    if (typeof v === "boolean") return 3;
    return 5;
  }

  function order(a, b) {
    var ra = typeRank(a);
    var rb = typeRank(b);
    if (ra !== rb) return ra - rb;
    if (typeof a === "number") return a - b;
    if (typeof a === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
    var ka = keyOf(a);
    var kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Evaluator                                                           */
  /* ------------------------------------------------------------------ */

  var FUNCTIONS = {
    tolower: function (a) { return typeof a[0] === "string" ? a[0].toLowerCase() : null; },
    toupper: function (a) { return typeof a[0] === "string" ? a[0].toUpperCase() : null; },
    tostring: function (a) { return a[0] == null ? null : String(a[0]); },
    tointeger: function (a) { var n = parseInt(a[0], 10); return isNaN(n) ? null : n; },
    tofloat: function (a) { var n = parseFloat(a[0]); return isNaN(n) ? null : n; },
    trim: function (a) { return typeof a[0] === "string" ? a[0].trim() : null; },
    abs: function (a) { return typeof a[0] === "number" ? Math.abs(a[0]) : null; },
    round: function (a) { return typeof a[0] === "number" ? Math.round(a[0]) : null; },
    size: function (a) { return a[0] == null ? null : a[0].length == null ? null : a[0].length; },
    length: function (a) { return isPath(a[0]) ? a[0].rels.length : a[0] == null ? null : a[0].length == null ? null : a[0].length; },
    head: function (a) { return Array.isArray(a[0]) && a[0].length ? a[0][0] : null; },
    last: function (a) { return Array.isArray(a[0]) && a[0].length ? a[0][a[0].length - 1] : null; },
    coalesce: function (a) { for (var i = 0; i < a.length; i++) if (a[i] != null) return a[i]; return null; },
    type: function (a) { return isRel(a[0]) ? a[0].type : null; },
    labels: function (a) { return isNode(a[0]) ? a[0].labels.slice() : null; },
    keys: function (a) { return isNode(a[0]) || isRel(a[0]) ? Object.keys(a[0].properties) : a[0] && typeof a[0] === "object" ? Object.keys(a[0]) : null; },
    properties: function (a) { return isNode(a[0]) || isRel(a[0]) ? Object.assign({}, a[0].properties) : null; },
    id: function (a) { return isNode(a[0]) || isRel(a[0]) ? Number(a[0].elementId.split(":").pop()) : null; },
    elementid: function (a) { return isNode(a[0]) || isRel(a[0]) ? a[0].elementId : null; },
    nodes: function (a) { return isPath(a[0]) ? a[0].nodes.slice() : null; },
    relationships: function (a) { return isPath(a[0]) ? a[0].rels.slice() : null; },
    startnode: function (a, ctx) { return isRel(a[0]) ? ctx.db.nodeById[a[0].start] : null; },
    endnode: function (a, ctx) { return isRel(a[0]) ? ctx.db.nodeById[a[0].end] : null; }
  };

  function hasAggregate(e) {
    if (!e || typeof e !== "object") return false;
    if (e.k === "call" && AGGREGATES[e.name]) return true;
    for (var key in e) {
      var v = e[key];
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) {
          if (Array.isArray(v[i])) { if (hasAggregate(v[i][1])) return true; }
          else if (hasAggregate(v[i])) return true;
        }
      } else if (v && typeof v === "object" && hasAggregate(v)) return true;
    }
    return false;
  }

  function aggregate(e, ctx) {
    if (!ctx.group) {
      throw new CypherError(e.raw + "() can only be used in RETURN or ORDER BY.", null, e.pos);
    }
    var inner = { db: ctx.db, params: ctx.params, group: null };
    if (e.name === "count" && e.star) return ctx.group.length;
    if (e.args.length !== 1) throw new CypherError(e.raw + "() takes one argument.", null, e.pos);
    var vals = [];
    var seen = {};
    for (var i = 0; i < ctx.group.length; i++) {
      var v = evaluate(e.args[0], ctx.group[i], inner);
      if (v == null) continue;
      if (e.distinct) {
        var k = keyOf(v);
        if (seen[k]) continue;
        seen[k] = true;
      }
      vals.push(v);
    }
    switch (e.name) {
      case "count": return vals.length;
      case "collect": return vals;
      case "sum": return vals.reduce(function (a, b) { return a + b; }, 0);
      case "avg": return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      case "min": return vals.length ? vals.reduce(function (a, b) { return order(a, b) <= 0 ? a : b; }) : null;
      case "max": return vals.length ? vals.reduce(function (a, b) { return order(a, b) >= 0 ? a : b; }) : null;
    }
    return null;
  }

  function evaluate(e, env, ctx) {
    switch (e.k) {
      case "lit": return e.v;
      case "param":
        if (!ctx.params || !(e.name in ctx.params)) {
          throw new CypherError("Parameter $" + e.name + " was not supplied.", "Neo.ClientError.Statement.ParameterMissing", e.pos);
        }
        return ctx.params[e.name];
      case "var":
        if (!(e.name in env)) {
          throw new CypherError("Variable `" + e.name + "` is not defined. Name it in a MATCH pattern first.", null, e.pos);
        }
        return env[e.name];
      case "list": return e.items.map(function (x) { return evaluate(x, env, ctx); });
      case "map": {
        var m = {};
        e.entries.forEach(function (en) { m[en[0]] = evaluate(en[1], env, ctx); });
        return m;
      }
      case "prop": {
        var o = evaluate(e.e, env, ctx);
        if (o == null) return null;
        if (isNode(o) || isRel(o)) return o.properties[e.name] == null ? null : o.properties[e.name];
        if (typeof o === "object" && !Array.isArray(o)) return o[e.name] == null ? null : o[e.name];
        return null;
      }
      case "index": {
        var arr = evaluate(e.e, env, ctx);
        var ix = evaluate(e.i, env, ctx);
        if (arr == null || ix == null) return null;
        if (Array.isArray(arr)) { if (ix < 0) ix += arr.length; return arr[ix] == null ? null : arr[ix]; }
        if (typeof arr === "object") return arr[ix] == null ? null : arr[ix];
        return null;
      }
      case "haslabel": {
        var n = evaluate(e.e, env, ctx);
        return isNode(n) ? n.labels.indexOf(e.label) >= 0 : null;
      }
      case "neg": {
        var x = evaluate(e.e, env, ctx);
        return typeof x === "number" ? -x : null;
      }
      case "not": {
        var b = evaluate(e.e, env, ctx);
        return b == null ? null : !b;
      }
      case "and": {
        var l = evaluate(e.l, env, ctx);
        if (l === false) return false;
        var r = evaluate(e.r, env, ctx);
        if (r === false) return false;
        return l == null || r == null ? null : true;
      }
      case "or": {
        var l2 = evaluate(e.l, env, ctx);
        if (l2 === true) return true;
        var r2 = evaluate(e.r, env, ctx);
        if (r2 === true) return true;
        return l2 == null || r2 == null ? null : false;
      }
      case "isnull": {
        var z = evaluate(e.e, env, ctx);
        return e.neg ? z != null : z == null;
      }
      case "cmp": {
        var a = evaluate(e.l, env, ctx);
        var c = evaluate(e.r, env, ctx);
        if (e.op === "=") return equal(a, c);
        if (e.op === "<>") { var eq = equal(a, c); return eq == null ? null : !eq; }
        if (a == null || c == null || typeof a !== typeof c || (typeof a !== "number" && typeof a !== "string")) return null;
        if (e.op === "<") return a < c;
        if (e.op === ">") return a > c;
        if (e.op === "<=") return a <= c;
        return a >= c;
      }
      case "in": {
        var item = evaluate(e.l, env, ctx);
        var list = evaluate(e.r, env, ctx);
        if (item == null || !Array.isArray(list)) return null;
        var ki = keyOf(item);
        return list.some(function (v) { return keyOf(v) === ki; });
      }
      case "str": {
        var s = evaluate(e.l, env, ctx);
        var t = evaluate(e.r, env, ctx);
        if (typeof s !== "string" || typeof t !== "string") return null;
        if (e.op === "contains") return s.indexOf(t) >= 0;
        if (e.op === "starts") return s.slice(0, t.length) === t;
        return t.length <= s.length && s.slice(s.length - t.length) === t;
      }
      case "arith": {
        var p = evaluate(e.l, env, ctx);
        var q = evaluate(e.r, env, ctx);
        if (p == null || q == null) return null;
        if (e.op === "+") {
          if (Array.isArray(p)) return p.concat(q);
          if (Array.isArray(q)) return [p].concat(q);
          if (typeof p === "string" || typeof q === "string") return String(p) + String(q);
          return p + q;
        }
        if (typeof p !== "number" || typeof q !== "number") return null;
        if (e.op === "-") return p - q;
        if (e.op === "*") return p * q;
        if (e.op === "/") {
          if (q === 0) throw new CypherError("Division by zero.", "Neo.ClientError.Statement.ArithmeticError");
          return p / q;
        }
        return p % q;
      }
      case "call": {
        if (AGGREGATES[e.name]) return aggregate(e, ctx);
        var fn = FUNCTIONS[e.name];
        if (!fn) throw unsupported("The function " + e.raw + "()", e.pos);
        return fn(e.args.map(function (arg) { return evaluate(arg, env, ctx); }), ctx);
      }
    }
    throw new CypherError("This expression can't be evaluated on the sample endpoint.");
  }

  /* ------------------------------------------------------------------ */
  /* Graph store                                                         */
  /* ------------------------------------------------------------------ */

  function buildDb(graph) {
    var db = { nodes: [], rels: [], nodeById: {}, out: {}, inc: {} };
    graph.nodes.forEach(function (n) {
      var node = { kind: "node", elementId: n.elementId, labels: n.labels, properties: n.properties };
      db.nodes.push(node);
      db.nodeById[node.elementId] = node;
      db.out[node.elementId] = [];
      db.inc[node.elementId] = [];
    });
    graph.relationships.forEach(function (r) {
      var rel = { kind: "rel", elementId: r.elementId, type: r.type, start: r.startNodeElementId, end: r.endNodeElementId, properties: r.properties };
      db.rels.push(rel);
      db.out[rel.start].push(rel);
      db.inc[rel.end].push(rel);
    });
    return db;
  }

  /* ------------------------------------------------------------------ */
  /* Pattern matching                                                    */
  /* ------------------------------------------------------------------ */

  var WORK_BUDGET = 400000;
  var UNBOUNDED_HOPS = 8;
  var SHORTEST_HOPS = 15;

  function spend(ctx) {
    if (++ctx.work > WORK_BUDGET) {
      throw new CypherError(
        "This pattern is too broad for the sample endpoint. Bound the path length, for example [*..3], or add labels to narrow it.",
        "GI.Sample.TooBroad"
      );
    }
  }

  function propsOk(props, entity, row, ctx) {
    if (!props) return true;
    for (var i = 0; i < props.length; i++) {
      var want = evaluate(props[i][1], row, ctx);
      var have = entity.properties[props[i][0]];
      if (have == null || want == null || keyOf(have) !== keyOf(want)) return false;
    }
    return true;
  }

  function nodeOk(np, node, row, ctx) {
    for (var i = 0; i < np.labels.length; i++) {
      var group = np.labels[i];
      var hit = false;
      for (var j = 0; j < group.length; j++) if (node.labels.indexOf(group[j]) >= 0) { hit = true; break; }
      if (!hit) return false;
    }
    return propsOk(np.props, node, row, ctx);
  }

  function candidates(np, row, ctx) {
    if (np.v && np.v in row) {
      var bound = row[np.v];
      return isNode(bound) && nodeOk(np, bound, row, ctx) ? [bound] : [];
    }
    return ctx.db.nodes.filter(function (n) { return nodeOk(np, n, row, ctx); });
  }

  function bind(row, name, value) {
    if (!name) return row;
    if (name in row) return keyOf(row[name]) === keyOf(value) ? row : null;
    var next = Object.assign({}, row);
    next[name] = value;
    return next;
  }

  function expand(cur, rp, row, ctx) {
    var found = [];
    function consider(rel, otherId) {
      spend(ctx);
      if (rp.types.length && rp.types.indexOf(rel.type) < 0) return;
      if (!propsOk(rp.props, rel, row, ctx)) return;
      found.push([rel, ctx.db.nodeById[otherId]]);
    }
    var i;
    if (rp.dir !== "in") { var o = ctx.db.out[cur.elementId]; for (i = 0; i < o.length; i++) consider(o[i], o[i].end); }
    if (rp.dir !== "out") {
      var inc = ctx.db.inc[cur.elementId];
      for (i = 0; i < inc.length; i++) {
        if (rp.dir === "both" && inc[i].start === inc[i].end) continue;
        consider(inc[i], inc[i].start);
      }
    }
    return found;
  }

  function makePath(nodes, rels) { return { kind: "path", nodes: nodes, rels: rels }; }

  function* matchChain(row, pattern, used, ctx) {
    var chain = pattern.chain;

    function* step(r, i, cur, pn, pr) {
      if (i === chain.rels.length) {
        var done = pattern.pathVar ? bind(r, pattern.pathVar, makePath(pn, pr)) : r;
        if (done) yield done;
        return;
      }
      var rp = chain.rels[i];
      var np = chain.nodes[i + 1];
      if (rp.varlen) {
        yield* walk(r, i, cur, pn, pr, [], 0);
        return;
      }
      var hops = expand(cur, rp, r, ctx);
      for (var h = 0; h < hops.length; h++) {
        var rel = hops[h][0];
        var other = hops[h][1];
        if (used.has(rel.elementId)) continue;
        if (!nodeOk(np, other, r, ctx)) continue;
        var r2 = bind(r, rp.v, rel);
        r2 = r2 && bind(r2, np.v, other);
        if (!r2) continue;
        used.add(rel.elementId);
        yield* step(r2, i + 1, other, pn.concat([other]), pr.concat([rel]));
        used.delete(rel.elementId);
      }
    }

    function* walk(r, i, cur, pn, pr, acc, depth) {
      var rp = chain.rels[i];
      var np = chain.nodes[i + 1];
      var max = rp.max === Infinity ? UNBOUNDED_HOPS : rp.max;
      if (depth >= rp.min && nodeOk(np, cur, r, ctx)) {
        var r2 = bind(r, rp.v, acc.slice());
        r2 = r2 && bind(r2, np.v, cur);
        if (r2) yield* step(r2, i + 1, cur, pn, pr);
      }
      if (depth >= max) return;
      var hops = expand(cur, rp, r, ctx);
      for (var h = 0; h < hops.length; h++) {
        var rel = hops[h][0];
        if (used.has(rel.elementId)) continue;
        used.add(rel.elementId);
        acc.push(rel);
        yield* walk(r, i, hops[h][1], pn.concat([hops[h][1]]), pr.concat([rel]), acc, depth + 1);
        acc.pop();
        used.delete(rel.elementId);
      }
    }

    var first = chain.nodes[0];
    var starts = candidates(first, row, ctx);
    for (var s = 0; s < starts.length; s++) {
      var r1 = bind(row, first.v, starts[s]);
      if (r1) yield* step(r1, 0, starts[s], [starts[s]], []);
    }
  }

  function* matchShortest(row, pattern, ctx) {
    var a = pattern.chain.nodes[0];
    var b = pattern.chain.nodes[1];
    var rp = pattern.chain.rels[0];
    var max = rp.varlen ? (rp.max === Infinity ? SHORTEST_HOPS : rp.max) : 1;
    var min = rp.varlen ? rp.min : 1;
    var starts = candidates(a, row, ctx);
    for (var s = 0; s < starts.length; s++) {
      var start = starts[s];
      var rowA = bind(row, a.v, start);
      if (!rowA) continue;
      var ends = {};
      candidates(b, rowA, ctx).forEach(function (n) { ends[n.elementId] = n; });
      var prev = {};
      prev[start.elementId] = null;
      var frontier = [start];
      var depth = 0;
      var reached = [];
      if (min === 0 && ends[start.elementId]) reached.push(start);
      while (frontier.length && depth < max) {
        var nextFrontier = [];
        for (var f = 0; f < frontier.length; f++) {
          var hops = expand(frontier[f], rp, rowA, ctx);
          for (var h = 0; h < hops.length; h++) {
            var other = hops[h][1];
            if (other.elementId in prev) continue;
            prev[other.elementId] = { rel: hops[h][0], from: frontier[f] };
            nextFrontier.push(other);
            if (ends[other.elementId]) reached.push(other);
          }
        }
        frontier = nextFrontier;
        depth++;
      }
      for (var e = 0; e < reached.length; e++) {
        var nodes = [reached[e]];
        var rels = [];
        var cur = reached[e];
        while (prev[cur.elementId]) {
          rels.unshift(prev[cur.elementId].rel);
          cur = prev[cur.elementId].from;
          nodes.unshift(cur);
        }
        var out = bind(rowA, b.v, reached[e]);
        out = out && bind(out, rp.v, rp.varlen ? rels : rels[0]);
        out = out && bind(out, pattern.pathVar, makePath(nodes, rels));
        if (out) yield out;
      }
    }
  }

  function* matchPatterns(row, clause, i, used, ctx) {
    if (i === clause.patterns.length) {
      if (!clause.where || evaluate(clause.where, row, ctx) === true) yield row;
      return;
    }
    var pattern = clause.patterns[i];
    var source = pattern.shortest ? matchShortest(row, pattern, ctx) : matchChain(row, pattern, used, ctx);
    for (var r of source) yield* matchPatterns(r, clause, i + 1, used, ctx);
  }

  function* matchClauses(query, ci, row, ctx) {
    if (ci === query.clauses.length) { yield row; return; }
    for (var r of matchPatterns(row, query.clauses[ci], 0, new Set(), ctx)) {
      yield* matchClauses(query, ci + 1, r, ctx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Projection                                                          */
  /* ------------------------------------------------------------------ */

  var MAX_ROWS = 1000;

  function wholeNumber(expr, ctx, what) {
    var v = evaluate(expr, {}, ctx);
    if (typeof v !== "number" || v < 0 || Math.floor(v) !== v) {
      throw new CypherError(what + " needs a whole number, zero or more.", "Neo.ClientError.Statement.ArgumentError");
    }
    return v;
  }

  function project(query, ctx) {
    var ret = query.ret;
    var items = [];
    if (ret.star) {
      if (!query.vars.length) throw new CypherError("RETURN * needs at least one variable in a MATCH pattern.");
      query.vars.forEach(function (v) { items.push({ expr: { k: "var", name: v }, name: v, alias: null, text: v.toLowerCase() }); });
    }
    items = items.concat(ret.items);
    var fields = items.map(function (it) { return it.name; });
    var skip = ret.skip ? wholeNumber(ret.skip, ctx, "SKIP") : 0;
    var limit = ret.limit ? wholeNumber(ret.limit, ctx, "LIMIT") : Infinity;
    var grouped = items.some(function (it) { return hasAggregate(it.expr); }) ||
      ret.order.some(function (o) { return hasAggregate(o.expr); });
    var source = matchClauses(query, 0, {}, ctx);
    var out = []; // { vals, env, group }

    if (grouped) {
      var groups = {};
      var orderOfGroups = [];
      var keyItems = items.filter(function (it) { return !hasAggregate(it.expr); });
      for (var row of source) {
        var gk = keyItems.map(function (it) { return keyOf(evaluate(it.expr, row, ctx)); }).join("\u0001");
        if (!groups[gk]) { groups[gk] = []; orderOfGroups.push(gk); }
        groups[gk].push(row);
      }
      if (!orderOfGroups.length && !keyItems.length) { groups[""] = []; orderOfGroups.push(""); }
      orderOfGroups.forEach(function (gk) {
        var g = groups[gk];
        var gctx = { db: ctx.db, params: ctx.params, group: g, work: 0 };
        var env = g[0] || {};
        out.push({ vals: items.map(function (it) { return evaluate(it.expr, env, gctx); }), env: env, ctx: gctx });
      });
    } else {
      var lazy = !ret.order.length && !ret.distinct;
      var need = skip + Math.min(limit, MAX_ROWS + 1);
      for (var row2 of source) {
        out.push({ vals: items.map(function (it) { return evaluate(it.expr, row2, ctx); }), env: row2, ctx: ctx });
        if (lazy && out.length >= need) break;
      }
    }

    if (ret.distinct) {
      var seen = {};
      out = out.filter(function (r) {
        var k = r.vals.map(keyOf).join("\u0001");
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
    }

    if (ret.order.length) {
      var sorters = ret.order.map(function (o) {
        var col = -1;
        items.forEach(function (it, idx) {
          if (col < 0 && (it.text === o.text || (it.alias && o.expr.k === "var" && o.expr.name === it.alias))) col = idx;
        });
        return { col: col, expr: o.expr, desc: o.desc };
      });
      out.forEach(function (r) {
        var env = Object.assign({}, r.env);
        items.forEach(function (it, idx) { if (it.alias) env[it.alias] = r.vals[idx]; });
        r.sort = sorters.map(function (s) { return s.col >= 0 ? r.vals[s.col] : evaluate(s.expr, env, r.ctx); });
      });
      out.sort(function (x, y) {
        for (var i = 0; i < sorters.length; i++) {
          var c = order(x.sort[i], y.sort[i]);
          if (c !== 0) return sorters[i].desc ? -c : c;
        }
        return 0;
      });
    }

    var rows = out.slice(skip, limit === Infinity ? undefined : skip + limit);
    var truncated = rows.length > MAX_ROWS;
    if (truncated) rows = rows.slice(0, MAX_ROWS);
    return { fields: fields, rows: rows.map(function (r) { return r.vals; }), truncated: truncated };
  }

  /* ------------------------------------------------------------------ */
  /* Serialisation (plain JSON, as the Neo4j Query API returns it)       */
  /* ------------------------------------------------------------------ */

  function serialise(v) {
    if (v == null) return null;
    if (isNode(v)) return { elementId: v.elementId, labels: v.labels.slice(), properties: Object.assign({}, v.properties) };
    if (isRel(v)) {
      return {
        elementId: v.elementId,
        startNodeElementId: v.start,
        endNodeElementId: v.end,
        type: v.type,
        properties: Object.assign({}, v.properties)
      };
    }
    if (isPath(v)) {
      var seq = [serialise(v.nodes[0])];
      for (var i = 0; i < v.rels.length; i++) { seq.push(serialise(v.rels[i])); seq.push(serialise(v.nodes[i + 1])); }
      return seq;
    }
    if (Array.isArray(v)) return v.map(serialise);
    if (typeof v === "object") {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = serialise(v[k]); });
      return o;
    }
    return v;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  var db = null;

  function run(statement, parameters) {
    if (!db) db = buildDb(GI.sampleGraph);
    if (typeof statement !== "string" || !statement.trim()) {
      throw new CypherError("The query is empty. Write a MATCH pattern and a RETURN clause.");
    }
    var query = new Parser(statement).parseQuery();
    var ctx = { db: db, params: parameters || {}, group: null, work: 0 };
    var result = project(query, ctx);
    return {
      data: { fields: result.fields, values: result.rows.map(function (r) { return r.map(serialise); }) },
      bookmarks: ["gi-sample"],
      truncated: result.truncated
    };
  }

  function lineAndColumn(src, pos) {
    var before = src.slice(0, pos).split("\n");
    return { line: before.length, column: before[before.length - 1].length + 1 };
  }

  /*
   * post(body) mirrors an HTTP POST to the query endpoint and resolves to
   * { status, body }. A short delay keeps loading states honest.
   */
  function post(body, options) {
    var delay = options && options.delay != null ? options.delay : 90 + Math.random() * 110;
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          resolve({ status: 202, body: run(body.statement, body.parameters) });
        } catch (err) {
          if (!(err instanceof CypherError)) {
            resolve({ status: 500, body: { errors: [{ code: "GI.Sample.InternalError", message: "The sample endpoint hit an unexpected problem: " + err.message }] } });
            return;
          }
          var message = err.message;
          if (err.pos != null) {
            var lc = lineAndColumn(body.statement, err.pos);
            message += " (line " + lc.line + ", column " + lc.column + ")";
          }
          resolve({ status: 400, body: { errors: [{ code: err.code, message: message }] } });
        }
      }, delay);
    });
  }

  GI.sampleEndpoint = { post: post, run: run, CypherError: CypherError };
})(typeof window !== "undefined" ? window : globalThis);
