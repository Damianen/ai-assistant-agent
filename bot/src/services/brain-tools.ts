import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { runQuery } from "../db/graph.js";
import {
  getSchemaAsString,
  incrementNodeTypeUse,
  incrementRelationshipTypeUse,
  proposeNodeType,
  proposeRelationshipType,
} from "../db/schema-registry.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SAFE_LABEL = /^[A-Za-z_]\w{0,63}$/;

function assertSafeLabel(value: string, field: string): void {
  if (!SAFE_LABEL.test(value)) {
    throw new Error(`Invalid ${field}: "${value}" — must be alphanumeric/underscore, start with a letter or _, max 64 chars`);
  }
}

function propsToSetClause(
  alias: string,
  props: Record<string, unknown>,
  paramPrefix: string,
  params: Record<string, unknown>,
): string {
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    assertSafeLabel(key, "property name");
    const paramName = `${paramPrefix}_${key}`;
    params[paramName] = value;
    clauses.push(`${alias}.${key} = $${paramName}`);
  }
  return clauses.join(", ");
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolGetSchema(_input: Record<string, never>): Promise<string> {
  return getSchemaAsString();
}

async function toolCreateNode(input: {
  type: string;
  properties: Record<string, unknown>;
  merge_on: string[];
}): Promise<string> {
  assertSafeLabel(input.type, "node type");

  const params: Record<string, unknown> = {};

  // Build MERGE key from merge_on subset
  const mergeProps = input.merge_on.map((key) => {
    assertSafeLabel(key, "merge_on key");
    if (!(key in input.properties)) {
      throw new Error(`merge_on key "${key}" not found in properties`);
    }
    const paramName = `merge_${key}`;
    params[paramName] = input.properties[key];
    return `${key}: $${paramName}`;
  });

  const mergeClause = `(n:${input.type} {${mergeProps.join(", ")}})`;

  // Remaining properties to SET after merge
  const remaining = Object.fromEntries(
    Object.entries(input.properties).filter(([k]) => !input.merge_on.includes(k)),
  );

  let setClause = "";
  if (Object.keys(remaining).length > 0) {
    setClause = ` SET ${propsToSetClause("n", remaining, "set", params)}`;
  }

  const query = `MERGE ${mergeClause}${setClause} RETURN n`;
  await runQuery(query, params);
  await incrementNodeTypeUse(input.type);

  const keyDisplay = input.merge_on
    .map((k) => `${k}=${JSON.stringify(input.properties[k])}`)
    .join(", ");
  return `Created/merged ${input.type} node: ${keyDisplay}`;
}

async function toolCreateRelationship(input: {
  from_node_type: string;
  from_node_properties: Record<string, unknown>;
  relationship: string;
  to_node_type: string;
  to_node_properties: Record<string, unknown>;
  rel_properties?: Record<string, unknown>;
}): Promise<string> {
  assertSafeLabel(input.from_node_type, "from_node_type");
  assertSafeLabel(input.to_node_type, "to_node_type");
  assertSafeLabel(input.relationship, "relationship");

  const params: Record<string, unknown> = {};

  // Populate params and build WHERE clauses for node matching
  const fromWhere = Object.entries(input.from_node_properties)
    .map(([k, v]) => {
      assertSafeLabel(k, "from property name");
      const paramName = `from_${k}`;
      params[paramName] = v;
      return `a.${k} = $${paramName}`;
    })
    .join(" AND ");

  const toWhere = Object.entries(input.to_node_properties)
    .map(([k, v]) => {
      assertSafeLabel(k, "to property name");
      const paramName = `to_${k}`;
      params[paramName] = v;
      return `b.${k} = $${paramName}`;
    })
    .join(" AND ");

  let relSetClause = "";
  if (input.rel_properties && Object.keys(input.rel_properties).length > 0) {
    relSetClause = ` SET ${propsToSetClause("r", input.rel_properties, "rel", params)}`;
  }

  const query = [
    `MATCH (a:${input.from_node_type}), (b:${input.to_node_type})`,
    `WHERE ${fromWhere} AND ${toWhere}`,
    `MERGE (a)-[r:${input.relationship}]->(b)`,
    relSetClause,
    `RETURN r`,
  ]
    .filter(Boolean)
    .join(" ");

  await runQuery(query, params);
  await incrementRelationshipTypeUse(input.relationship);

  const fromDisplay = Object.entries(input.from_node_properties)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  const toDisplay = Object.entries(input.to_node_properties)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");

  return `Created relationship: (${input.from_node_type} {${fromDisplay}}) -[${input.relationship}]-> (${input.to_node_type} {${toDisplay}})`;
}

async function toolQueryGraph(input: {
  node_type: string;
  properties: Record<string, unknown>;
  depth?: number;
}): Promise<string> {
  assertSafeLabel(input.node_type, "node_type");

  const depth = Math.min(input.depth ?? 2, 3);
  const params: Record<string, unknown> = {};

  const whereClause = Object.entries(input.properties)
    .map(([k, v]) => {
      assertSafeLabel(k, "property name");
      const paramName = `q_${k}`;
      params[paramName] = v;
      return `n.${k} = $${paramName}`;
    })
    .join(" AND ");

  const query = [
    `MATCH (n:${input.node_type})`,
    `WHERE ${whereClause}`,
    `OPTIONAL MATCH path = (n)-[*1..${depth}]-(m)`,
    `RETURN n, path, m`,
  ].join(" ");

  const rows = await runQuery(query, params);

  if (rows.length === 0) {
    const propDisplay = Object.entries(input.properties)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    return `No connections found for ${input.node_type} {${propDisplay}}`;
  }

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const row of rows) {
    const repr = JSON.stringify(row);
    if (seen.has(repr)) continue;
    seen.add(repr);
    lines.push(repr);
  }

  return lines.join("\n");
}

async function toolProposeSchemaAddition(input: {
  kind: "node_type" | "relationship_type";
  name: string;
  description: string;
  example_use_case: string;
}): Promise<string> {
  assertSafeLabel(input.name, "name");

  if (input.kind === "node_type") {
    await proposeNodeType(input.name, input.description);
  } else {
    await proposeRelationshipType(input.name, input.description, [], []);
  }

  return `Added new ${input.kind}: ${input.name} — ${input.description}`;
}

async function toolMergeNodes(input: {
  node_a_id: number;
  node_b_id: number;
  reason: string;
}): Promise<string> {
  const idA = Number(input.node_a_id);
  const idB = Number(input.node_b_id);
  if (!Number.isInteger(idA) || !Number.isInteger(idB)) {
    throw new Error("node IDs must be integers (FalkorDB internal IDs)");
  }

  // Copy properties from B to A
  await runQuery(
    `MATCH (a), (b) WHERE ID(a) = $idA AND ID(b) = $idB SET a += b`,
    { idA, idB },
  );

  // Redirect incoming relationships from B to A
  await runQuery(
    `MATCH (b)<-[r]-(src) WHERE ID(b) = $idB ` +
    `MATCH (a) WHERE ID(a) = $idA ` +
    `CREATE (a)<-[r2:MERGED_REL]-(src) DELETE r`,
    { idA, idB },
  );

  // Redirect outgoing relationships from B to A
  await runQuery(
    `MATCH (b)-[r]->(tgt) WHERE ID(b) = $idB ` +
    `MATCH (a) WHERE ID(a) = $idA ` +
    `CREATE (a)-[r2:MERGED_REL]->(tgt) DELETE r`,
    { idA, idB },
  );

  // Delete node B
  await runQuery(`MATCH (b) WHERE ID(b) = $idB DELETE b`, { idB });

  return `Merged nodes (${idA} <- ${idB}): ${input.reason}`;
}

// ---------------------------------------------------------------------------
// Tool definitions for Anthropic API
// ---------------------------------------------------------------------------

export const BRAIN_TOOLS: Tool[] = [
  {
    name: "get_schema",
    description:
      "Get the current knowledge graph schema: all node types and relationship types with descriptions and usage counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_node",
    description:
      "Create or merge a node in the knowledge graph. Uses merge_on properties to avoid duplicates.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: "Node label (e.g. Person, Place, Event)",
        },
        properties: {
          type: "object",
          description: "All properties for the node",
        },
        merge_on: {
          type: "array",
          items: { type: "string" },
          description:
            "Property keys to match on for deduplication (e.g. ['name'])",
        },
      },
      required: ["type", "properties", "merge_on"],
    },
  },
  {
    name: "create_relationship",
    description:
      "Create a relationship between two existing nodes in the knowledge graph.",
    input_schema: {
      type: "object" as const,
      properties: {
        from_node_type: {
          type: "string",
          description: "Label of the source node",
        },
        from_node_properties: {
          type: "object",
          description: "Properties to identify the source node",
        },
        relationship: {
          type: "string",
          description: "Relationship type (e.g. KNOWS, LIVES_IN)",
        },
        to_node_type: {
          type: "string",
          description: "Label of the target node",
        },
        to_node_properties: {
          type: "object",
          description: "Properties to identify the target node",
        },
        rel_properties: {
          type: "object",
          description: "Optional properties on the relationship itself",
        },
      },
      required: [
        "from_node_type",
        "from_node_properties",
        "relationship",
        "to_node_type",
        "to_node_properties",
      ],
    },
  },
  {
    name: "query_graph",
    description:
      "Query the knowledge graph for a node and its connections up to N hops deep.",
    input_schema: {
      type: "object" as const,
      properties: {
        node_type: {
          type: "string",
          description: "Label of the node to start from",
        },
        properties: {
          type: "object",
          description: "Properties to identify the starting node",
        },
        depth: {
          type: "number",
          description: "Max traversal depth (1-3, default 2)",
        },
      },
      required: ["node_type", "properties"],
    },
  },
  {
    name: "propose_schema_addition",
    description:
      "Propose a new node type or relationship type to add to the schema.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["node_type", "relationship_type"],
          description: "Whether to add a node type or relationship type",
        },
        name: {
          type: "string",
          description: "Name of the new type (PascalCase for nodes, UPPER_SNAKE for relationships)",
        },
        description: {
          type: "string",
          description: "What this type represents",
        },
        example_use_case: {
          type: "string",
          description: "A concrete example of when this type would be used",
        },
      },
      required: ["kind", "name", "description", "example_use_case"],
    },
  },
  {
    name: "merge_nodes",
    description:
      "Merge two duplicate nodes: copies properties and relationships from node B to node A, then deletes node B.",
    input_schema: {
      type: "object" as const,
      properties: {
        node_a_id: {
          type: "number",
          description: "Internal ID of the node to keep (target)",
        },
        node_b_id: {
          type: "number",
          description: "Internal ID of the node to merge and delete (source)",
        },
        reason: {
          type: "string",
          description: "Why these nodes are being merged",
        },
      },
      required: ["node_a_id", "node_b_id", "reason"],
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const handlers: Record<string, (input: any) => Promise<string>> = {
  get_schema: toolGetSchema,
  create_node: toolCreateNode,
  create_relationship: toolCreateRelationship,
  query_graph: toolQueryGraph,
  propose_schema_addition: toolProposeSchemaAddition,
  merge_nodes: toolMergeNodes,
};

export async function executeTool(
  name: string,
  input: unknown,
): Promise<string> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown brain tool: ${name}`);
  }
  return handler(input);
}
