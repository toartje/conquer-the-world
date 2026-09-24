import { COLORS, CONFIG } from '../config';
import { cellId, toMeters } from './geo';
import type { Cell, Checkpoint, GameState } from './types';

type Point = { x: number; y: number };
type Vertex = Point & { checkpoint: Checkpoint };
export type CheckpointConnection = { from: Checkpoint; to: Checkpoint };
export const DEBUG_CHECKPOINT_CONNECTIONS = true;

function cross(origin: Point, a: Point, b: Point) { return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x); }
function near(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) <= CONFIG.territoryLinkMeters; }

// A small spatial index keeps connection checks local instead of comparing
// every owned checkpoint in the world with every other checkpoint.
export function checkpointConnections(checkpoints: Checkpoint[]): CheckpointConnection[] {
  const vertices = checkpoints.filter(checkpoint => checkpoint.owner === 'player').map(checkpoint => ({ ...toMeters(checkpoint.position), checkpoint }));
  const buckets = new Map<string, Vertex[]>(), edges: CheckpointConnection[] = [], size = CONFIG.territoryLinkMeters;
  for (const vertex of vertices) {
    const bucketX = Math.floor(vertex.x / size), bucketY = Math.floor(vertex.y / size);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const other of buckets.get(`${bucketX + dx}:${bucketY + dy}`) ?? []) {
        if (near(vertex, other)) edges.push({ from: other.checkpoint, to: vertex.checkpoint });
      }
    }
    const key = `${bucketX}:${bucketY}`, bucket = buckets.get(key) ?? [];
    bucket.push(vertex); buckets.set(key, bucket);
  }
  return edges;
}

function checkpointGraph(checkpoints: Checkpoint[]) {
  const owned = checkpoints.filter(checkpoint => checkpoint.owner === 'player');
  const neighbours = new Map(owned.map(checkpoint => [checkpoint.id, new Set<string>()]));
  const edges = checkpointConnections(owned);
  for (const edge of edges) {
    neighbours.get(edge.from.id)!.add(edge.to.id);
    neighbours.get(edge.to.id)!.add(edge.from.id);
  }
  return { owned, neighbours, edges };
}

export function connectedCheckpointGroups(checkpoints: Checkpoint[]) {
  const { owned, neighbours } = checkpointGraph(checkpoints), byId = new Map(owned.map(checkpoint => [checkpoint.id, checkpoint]));
  const unseen = new Set(owned.map(checkpoint => checkpoint.id)), groups: Checkpoint[][] = [];
  while (unseen.size) {
    const first = unseen.values().next().value as string, queue = [first], group: Checkpoint[] = [];
    unseen.delete(first);
    while (queue.length) {
      const id = queue.pop()!, checkpoint = byId.get(id)!;
      group.push(checkpoint);
      for (const otherId of neighbours.get(id) ?? []) if (unseen.delete(otherId)) queue.push(otherId);
    }
    groups.push(group);
  }
  return groups;
}

function insidePolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (Math.abs(cross(a, b, point)) < .01 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Territory is the union of local triangles. Every triangle needs all three
// graph edges, so a chain can connect checkpoints without claiming empty land.
export function territoryPolygons(checkpoints: Checkpoint[]) {
  const { owned, neighbours } = checkpointGraph(checkpoints);
  const vertices = new Map(owned.map(checkpoint => [checkpoint.id, { ...toMeters(checkpoint.position), checkpoint }]));
  const ids = owned.map(checkpoint => checkpoint.id).sort(), order = new Map(ids.map((id, index) => [id, index]));
  const unclaimed = checkpoints.filter(checkpoint => checkpoint.owner !== 'player').map(checkpoint => ({ ...toMeters(checkpoint.position), checkpoint }));
  const triangles: [Vertex, Vertex, Vertex][] = [];
  for (const firstId of ids) {
    const firstIndex = order.get(firstId)!;
    for (const secondId of neighbours.get(firstId) ?? []) {
      const secondIndex = order.get(secondId)!;
      if (secondIndex <= firstIndex) continue;
      for (const thirdId of neighbours.get(firstId) ?? []) {
        const thirdIndex = order.get(thirdId)!;
        if (thirdIndex <= secondIndex || !neighbours.get(secondId)?.has(thirdId)) continue;
        const triangle = [vertices.get(firstId)!, vertices.get(secondId)!, vertices.get(thirdId)!] as [Vertex, Vertex, Vertex];
        if (Math.abs(cross(triangle[0], triangle[1], triangle[2])) < CONFIG.cellMeters ** 2) continue;
        if (unclaimed.some(point => insidePolygon(point, triangle))) continue;
        triangles.push(triangle);
      }
    }
  }
  return triangles;
}

// Ownership is authoritative. Polygons are rebuilt after ownership events and
// merely rasterized into the visual cell layer.
export function rebuildTerritory(game: GameState) {
  const previouslyOwned = new Set(Object.values(game.cells).filter(cell => cell.ownerId === 'player').map(cell => cell.id));
  for (const cell of Object.values(game.cells)) if (cell.ownerId === 'player') { cell.ownerId = null; cell.ownerColor = null; }
  const polygons = territoryPolygons(game.checkpoints);
  for (const polygon of polygons) {
    const minX = Math.floor(Math.min(...polygon.map(point => point.x)) / CONFIG.cellMeters), maxX = Math.floor(Math.max(...polygon.map(point => point.x)) / CONFIG.cellMeters);
    const minY = Math.floor(Math.min(...polygon.map(point => point.y)) / CONFIG.cellMeters), maxY = Math.floor(Math.max(...polygon.map(point => point.y)) / CONFIG.cellMeters);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const point = { x: (x + .5) * CONFIG.cellMeters, y: (y + .5) * CONFIG.cellMeters };
      if (!insidePolygon(point, polygon)) continue;
      const id = cellId(x, y), cell: Cell = game.cells[id] ?? { id, x, y, ownerId: null, ownerColor: null, discovered: false };
      cell.ownerId = 'player'; cell.ownerColor = COLORS.player; game.cells[id] = cell;
    }
  }
  if (DEBUG_CHECKPOINT_CONNECTIONS && typeof window !== 'undefined') {
    const groups = connectedCheckpointGroups(game.checkpoints), edges = checkpointConnections(game.checkpoints);
    console.debug('[Territory]', { player: 'JIJ', ownedCheckpoints: game.checkpoints.filter(checkpoint => checkpoint.owner === 'player').length, connectedComponents: groups.map(group => group.length), edges: edges.length, validTriangles: polygons.length });
  }
  return Object.values(game.cells).filter(cell => cell.ownerId === 'player' && !previouslyOwned.has(cell.id)).length;
}
