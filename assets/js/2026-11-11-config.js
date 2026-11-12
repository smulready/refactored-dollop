/*
 * Graph Intelligence: connection settings.
 *
 * mode
 *   "sample"  Answer queries in the browser from the bundled sample graph.
 *             No network requests are made.
 *   "live"    POST each query to `endpoint`.
 *
 * endpoint
 *   The query URL of your Neo4j server. The request body is
 *   { "statement": "...", "parameters": {} } and the expected reply is
 *   { "data": { "fields": [...], "values": [...] } }, modelled on the
 *   Neo4j Query API (v2). The value below is a placeholder.
 *
 * auth
 *   Sent as HTTP Basic auth when both fields are filled in. This file is
 *   readable by anyone who can open the page, so only put credentials here
 *   on a machine you control. For anything shared, leave these blank and
 *   put a proxy that holds the credentials in front of the database.
 */
window.GI_CONFIG = {
  mode: "sample",
  endpoint: "http://localhost:7474/db/neo4j/query/v2",
  auth: { username: "", password: "" }
};
