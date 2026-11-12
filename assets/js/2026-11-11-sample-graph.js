/*
 * Graph Intelligence: sample knowledge graph.
 *
 * A small, fictional research organisation: people, teams, projects,
 * documents, technologies and partner organisations. It stands in for the
 * live database until a real endpoint is connected (see config.js).
 * Every name here is invented.
 */
(function (root) {
  "use strict";
  var GI = (root.GI = root.GI || {});

  var nodes = [];
  var relationships = [];
  var byKey = {};

  function node(key, label, properties) {
    var n = {
      elementId: "4:gi-sample:" + nodes.length,
      labels: [label],
      properties: properties
    };
    nodes.push(n);
    byKey[key] = n;
  }

  function rel(from, type, to, properties) {
    if (!byKey[from] || !byKey[to]) throw new Error("Unknown node key: " + from + " / " + to);
    relationships.push({
      elementId: "5:gi-sample:" + relationships.length,
      type: type,
      startNodeElementId: byKey[from].elementId,
      endNodeElementId: byKey[to].elementId,
      properties: properties || {}
    });
  }

  /* ---------- People ---------- */
  node("amara", "Person", { name: "Amara Okafor", role: "Principal Scientist", joined: 2016 });
  node("tomas", "Person", { name: "Tomás Rivera", role: "Staff Engineer", joined: 2018 });
  node("ingrid", "Person", { name: "Ingrid Solberg", role: "Research Lead", joined: 2014 });
  node("kenji", "Person", { name: "Kenji Watanabe", role: "Data Engineer", joined: 2020 });
  node("priya", "Person", { name: "Priya Raman", role: "ML Engineer", joined: 2019 });
  node("elias", "Person", { name: "Elias Brandt", role: "Ontologist", joined: 2017 });
  node("noor", "Person", { name: "Noor Haddad", role: "Program Manager", joined: 2015 });
  node("lucia", "Person", { name: "Lucia Ferrante", role: "Research Scientist", joined: 2021 });
  node("samuel", "Person", { name: "Samuel Adeyemi", role: "Platform Engineer", joined: 2019 });
  node("meiling", "Person", { name: "Mei-Ling Chen", role: "Research Scientist", joined: 2022 });
  node("jonas", "Person", { name: "Jonas Lindqvist", role: "Analyst", joined: 2023 });
  node("farah", "Person", { name: "Farah Siddiqui", role: "Staff Scientist", joined: 2016 });
  node("dmitri", "Person", { name: "Dmitri Volkov", role: "Systems Engineer", joined: 2018 });
  node("hana", "Person", { name: "Hana Kimura", role: "Designer", joined: 2021 });

  /* ---------- Teams ---------- */
  node("ke", "Team", { name: "Knowledge Engineering", headcount: 4 });
  node("ml", "Team", { name: "Applied ML", headcount: 4 });
  node("dp", "Team", { name: "Data Platform", headcount: 4 });
  node("fa", "Team", { name: "Field Analytics", headcount: 2 });

  /* ---------- Projects ---------- */
  node("atlas", "Project", { name: "Atlas", summary: "Entity resolution across source systems", status: "active", started: 2022 });
  node("meridian", "Project", { name: "Meridian", summary: "Geospatial layer for the knowledge graph", status: "active", started: 2023 });
  node("kestrel", "Project", { name: "Kestrel", summary: "Streaming ingestion pipeline", status: "active", started: 2021 });
  node("lumen", "Project", { name: "Lumen", summary: "Semantic search over linked documents", status: "active", started: 2023 });
  node("tessera", "Project", { name: "Tessera", summary: "Ontology alignment", status: "active", started: 2022 });
  node("harbor", "Project", { name: "Harbor", summary: "Data access governance", status: "paused", started: 2020 });
  node("quill", "Project", { name: "Quill", summary: "Report drafting from graph context", status: "pilot", started: 2024 });
  node("cinder", "Project", { name: "Cinder", summary: "Legacy warehouse migration", status: "complete", started: 2019 });

  /* ---------- Documents ---------- */
  node("d1", "Document", { title: "Resolving entities across seven source systems", kind: "paper", year: 2023 });
  node("d2", "Document", { title: "Atlas design review", kind: "design doc", year: 2022 });
  node("d3", "Document", { title: "A geospatial layer for the knowledge graph", kind: "paper", year: 2024 });
  node("d4", "Document", { title: "Meridian field trial report", kind: "report", year: 2024 });
  node("d5", "Document", { title: "Kestrel ingestion runbook", kind: "runbook", year: 2022 });
  node("d6", "Document", { title: "Exactly-once delivery in Kestrel", kind: "design doc", year: 2021 });
  node("d7", "Document", { title: "Semantic search over linked documents", kind: "paper", year: 2024 });
  node("d8", "Document", { title: "Lumen relevance evaluation", kind: "report", year: 2025 });
  node("d9", "Document", { title: "Aligning ontologies with graph neural networks", kind: "paper", year: 2023 });
  node("d10", "Document", { title: "Access policy model for Harbor", kind: "design doc", year: 2020 });
  node("d11", "Document", { title: "Drafting reports from graph context", kind: "paper", year: 2025 });
  node("d12", "Document", { title: "Cinder migration retrospective", kind: "report", year: 2020 });

  /* ---------- Technologies ---------- */
  node("emb", "Technology", { name: "Graph embeddings", category: "method" });
  node("er", "Technology", { name: "Entity resolution", category: "method" });
  node("vec", "Technology", { name: "Vector search", category: "infrastructure" });
  node("stream", "Technology", { name: "Stream processing", category: "infrastructure" });
  node("onto", "Technology", { name: "Ontology mapping", category: "method" });
  node("geo", "Technology", { name: "Geospatial indexing", category: "infrastructure" });
  node("rag", "Technology", { name: "Retrieval-augmented generation", category: "method" });
  node("acl", "Technology", { name: "Access control", category: "infrastructure" });
  node("gnn", "Technology", { name: "Graph neural networks", category: "method" });
  node("lineage", "Technology", { name: "Data lineage", category: "infrastructure" });

  /* ---------- Organizations ---------- */
  node("halden", "Organization", { name: "Halden Institute", kind: "research institute" });
  node("orrery", "Organization", { name: "Orrery Systems", kind: "vendor" });
  node("vantage", "Organization", { name: "Vantage Geodata", kind: "data provider" });
  node("brightwater", "Organization", { name: "Brightwater University", kind: "university" });

  /* ---------- Relationships ---------- */
  function each(type, pairs, props) {
    pairs.forEach(function (p) { rel(p[0], type, p[1], props ? props(p) : undefined); });
  }

  each("MEMBER_OF", [
    ["amara", "ke"], ["elias", "ke"], ["lucia", "ke"], ["farah", "ke"],
    ["priya", "ml"], ["meiling", "ml"], ["ingrid", "ml"], ["hana", "ml"],
    ["tomas", "dp"], ["kenji", "dp"], ["samuel", "dp"], ["dmitri", "dp"],
    ["noor", "fa"], ["jonas", "fa"]
  ]);

  each("OWNS", [
    ["ke", "atlas"], ["ke", "tessera"], ["ml", "lumen"], ["ml", "quill"],
    ["dp", "kestrel"], ["dp", "harbor"], ["dp", "cinder"], ["fa", "meridian"]
  ]);

  each("LEADS", [
    ["amara", "atlas"], ["noor", "meridian"], ["tomas", "kestrel"], ["ingrid", "lumen"],
    ["elias", "tessera"], ["samuel", "harbor"], ["priya", "quill"], ["dmitri", "cinder"]
  ]);

  each("WORKS_ON", [
    ["lucia", "atlas", 2022], ["farah", "atlas", 2022], ["kenji", "atlas", 2023], ["priya", "atlas", 2023],
    ["jonas", "meridian", 2023], ["meiling", "meridian", 2023], ["elias", "meridian", 2024], ["kenji", "meridian", 2024],
    ["samuel", "kestrel", 2021], ["dmitri", "kestrel", 2021], ["kenji", "kestrel", 2021],
    ["priya", "lumen", 2023], ["meiling", "lumen", 2023], ["hana", "lumen", 2024], ["farah", "lumen", 2024],
    ["lucia", "tessera", 2022], ["amara", "tessera", 2022], ["farah", "tessera", 2023],
    ["dmitri", "harbor", 2020], ["noor", "harbor", 2020],
    ["hana", "quill", 2024], ["ingrid", "quill", 2024], ["jonas", "quill", 2025],
    ["tomas", "cinder", 2019], ["samuel", "cinder", 2019]
  ], function (p) { return { since: p[2] }; });

  each("DEPENDS_ON", [
    ["atlas", "kestrel"], ["atlas", "tessera"], ["meridian", "atlas"], ["meridian", "kestrel"],
    ["lumen", "atlas"], ["lumen", "tessera"], ["quill", "lumen"], ["quill", "meridian"],
    ["harbor", "kestrel"], ["kestrel", "cinder"]
  ]);

  each("USES", [
    ["atlas", "er"], ["atlas", "emb"], ["atlas", "lineage"],
    ["meridian", "geo"], ["meridian", "er"], ["meridian", "onto"],
    ["kestrel", "stream"], ["kestrel", "lineage"],
    ["lumen", "vec"], ["lumen", "emb"], ["lumen", "rag"],
    ["tessera", "onto"], ["tessera", "gnn"],
    ["harbor", "acl"], ["harbor", "lineage"],
    ["quill", "rag"], ["quill", "vec"],
    ["cinder", "stream"]
  ]);

  each("EXPERT_IN", [
    ["amara", "er"], ["amara", "emb"], ["farah", "er"], ["farah", "gnn"],
    ["elias", "onto"], ["lucia", "onto"], ["priya", "rag"], ["priya", "vec"],
    ["meiling", "emb"], ["meiling", "gnn"], ["ingrid", "rag"],
    ["tomas", "stream"], ["kenji", "stream"], ["kenji", "lineage"],
    ["samuel", "acl"], ["dmitri", "lineage"], ["noor", "geo"], ["jonas", "geo"]
  ]);

  each("AUTHORED", [
    ["amara", "d1"], ["farah", "d1"], ["amara", "d2"], ["kenji", "d2"],
    ["noor", "d3"], ["meiling", "d3"], ["jonas", "d4"],
    ["tomas", "d5"], ["samuel", "d5"], ["tomas", "d6"],
    ["ingrid", "d7"], ["priya", "d7"], ["meiling", "d8"], ["hana", "d8"],
    ["elias", "d9"], ["farah", "d9"], ["lucia", "d9"],
    ["samuel", "d10"], ["priya", "d11"], ["ingrid", "d11"],
    ["dmitri", "d12"], ["tomas", "d12"]
  ]);

  each("DESCRIBES", [
    ["d1", "atlas"], ["d2", "atlas"], ["d3", "meridian"], ["d4", "meridian"],
    ["d5", "kestrel"], ["d6", "kestrel"], ["d7", "lumen"], ["d8", "lumen"],
    ["d9", "tessera"], ["d10", "harbor"], ["d11", "quill"], ["d12", "cinder"]
  ]);

  each("CITES", [
    ["d3", "d1"], ["d7", "d1"], ["d7", "d9"], ["d9", "d1"], ["d11", "d7"], ["d8", "d7"],
    ["d4", "d3"], ["d2", "d6"], ["d5", "d6"], ["d11", "d3"], ["d10", "d6"]
  ]);

  each("PARTNERS_ON", [
    ["halden", "atlas"], ["halden", "tessera"], ["brightwater", "lumen"], ["brightwater", "tessera"],
    ["vantage", "meridian"], ["orrery", "kestrel"], ["orrery", "harbor"]
  ]);

  GI.sampleGraph = { nodes: nodes, relationships: relationships };
})(typeof window !== "undefined" ? window : globalThis);
