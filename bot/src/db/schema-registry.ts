import { prisma } from "./prisma.js";
import type { NodeType, RelationshipType } from "@prisma/client";
import { logger } from "../lib/logger.js";

export async function getFullSchema(): Promise<{
  nodeTypes: NodeType[];
  relationshipTypes: RelationshipType[];
}> {
  const [nodeTypes, relationshipTypes] = await Promise.all([
    prisma.nodeType.findMany({ orderBy: { useCount: "desc" } }),
    prisma.relationshipType.findMany({ orderBy: { useCount: "desc" } }),
  ]);
  return { nodeTypes, relationshipTypes };
}

export async function getSchemaAsString(): Promise<string> {
  const { nodeTypes, relationshipTypes } = await getFullSchema();

  const nodes = nodeTypes
    .map((n) => `${n.name} (used ${n.useCount}x) - ${n.description}`)
    .join(", ");

  const rels = relationshipTypes
    .map((r) => `${r.name} (used ${r.useCount}x) - ${r.description}`)
    .join(", ");

  return `Node types: ${nodes}\nRelationship types: ${rels}`;
}

export async function proposeNodeType(
  name: string,
  description: string,
): Promise<NodeType> {
  const existing = await prisma.nodeType.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;

  return prisma.nodeType.create({ data: { name, description } });
}

export async function proposeRelationshipType(
  name: string,
  description: string,
  fromTypes: string[],
  toTypes: string[],
): Promise<RelationshipType> {
  const existing = await prisma.relationshipType.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (existing) return existing;

  return prisma.relationshipType.create({
    data: { name, description, fromTypes, toTypes },
  });
}

export async function incrementNodeTypeUse(name: string): Promise<void> {
  await prisma.nodeType.update({
    where: { name },
    data: { useCount: { increment: 1 } },
  });
}

export async function incrementRelationshipTypeUse(
  name: string,
): Promise<void> {
  await prisma.relationshipType.update({
    where: { name },
    data: { useCount: { increment: 1 } },
  });
}

export async function seedSchema(): Promise<void> {
  const count = await prisma.nodeType.count();
  if (count > 0) return;

  await Promise.all([
    prisma.nodeType.createMany({
      data: [
        { name: "Person", description: "A human being" },
        { name: "Place", description: "A physical or virtual location" },
        {
          name: "Time",
          description: "A date, period, or recurring time pattern",
        },
      ],
    }),
    prisma.relationshipType.create({
      data: {
        name: "RELATED_TO",
        description: "Generic connection when no specific type fits yet",
        fromTypes: [],
        toTypes: [],
      },
    }),
  ]);

  logger.info("Schema seeded");
}
