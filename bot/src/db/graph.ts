import { FalkorDB } from "falkordb";
import type { Graph } from "falkordb";
import { logger } from "../lib/logger.js";

const GRAPH_ID = "memorae_brain";

let db: FalkorDB;
let graph: Graph;

async function getGraph(): Promise<Graph> {
  if (graph) return graph;

  db = await FalkorDB.connect({
    socket: {
      host: process.env.FALKORDB_HOST || "localhost",
      port: parseInt(process.env.FALKORDB_PORT || "6380"),
    },
  });

  graph = db.selectGraph(GRAPH_ID);
  return graph;
}

export async function runQuery(
  query: string,
  params?: Record<string, any>,
): Promise<any[]> {
  const g = await getGraph();
  try {
    const result = await g.query(query, { params });
    return result.data ?? [];
  } catch (err) {
    logger.error({ err, query, params }, "FalkorDB query failed");
    throw err;
  }
}

export async function getGraphStats(): Promise<string> {
  const g = await getGraph();

  const [nodeResult, relResult] = await Promise.all([
    g.query<{ label: string; count: number }>(
      "CALL db.labels() YIELD label RETURN label, SIZE((:__placeholder__)) AS count",
    ).catch(() => null),
    g.query<{ type: string; count: number }>(
      "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType AS type",
    ).catch(() => null),
  ]);

  // FalkorDB doesn't support SIZE() with label variable substitution in the
  // same way Neo4j does, so we fetch labels/types first, then count each.
  const labels =
    nodeResult?.data?.map((r: any) => r.label).filter(Boolean) ?? [];
  const types =
    relResult?.data?.map((r: any) => r.type).filter(Boolean) ?? [];

  const nodeCounts = await Promise.all(
    labels.map(async (label: string) => {
      const res = await g.query<{ c: number }>(
        `MATCH (n:${label}) RETURN count(n) AS c`,
      );
      return `${label}(${res.data?.[0]?.c ?? 0})`;
    }),
  );

  const relCounts = await Promise.all(
    types.map(async (type: string) => {
      const res = await g.query<{ c: number }>(
        `MATCH ()-[r:${type}]->() RETURN count(r) AS c`,
      );
      return `${type}(${res.data?.[0]?.c ?? 0})`;
    }),
  );

  const nodeStr = nodeCounts.length ? nodeCounts.join(", ") : "none";
  const relStr = relCounts.length ? relCounts.join(", ") : "none";

  return `Nodes: ${nodeStr} | Relationships: ${relStr}`;
}

export async function closeGraph(): Promise<void> {
  if (db) await db.close();
}
