import { COLORS, CONFIG } from '../config';
import { cellId, toMeters } from './geo';
import type { Cell, Checkpoint, GameState } from './types';

type Point = { x: number; y: number };
type Vertex = Point & { checkpoint: Checkpoint };

function cross(origin: Point, a: Point, b: Point) { return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x); }
function near(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) <= CONFIG.territoryLinkMeters; }

export function connectedCheckpointGroups(checkpoints: Checkpoint[]) {
  const owned = checkpoints.filter(cp => cp.owner === 'player'), vertices = new Map(owned.map(cp => [cp.id, { ...toMeters(cp.position), checkpoint: cp }]));
  const unseen = new Set(owned.map(cp => cp.id)), groups: Checkpoint[][] = [];
  while (unseen.size) {
    const first = unseen.values().next().value as string, queue = [first], group: Checkpoint[] = [];
    unseen.delete(first);
    while (queue.length) {
      const id = queue.pop()!, vertex = vertices.get(id)!;
      group.push(vertex.checkpoint);
      for (const otherId of [...unseen]) if (near(vertex, vertices.get(otherId)!)) { unseen.delete(otherId); queue.push(otherId); }
    }
    groups.push(group);
  }
  return groups;
}

function convexHull(checkpoints: Checkpoint[]): Vertex[] {
  const points = checkpoints.map(checkpoint => ({ ...toMeters(checkpoint.position), checkpoint })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (points.length <= 2) return points;
  const lower: Vertex[] = [], upper: Vertex[] = [];
  for (const point of points) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (let i = points.length - 1; i >= 0; i--) { const point = points[i]; while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  lower.pop(); upper.pop(); return [...lower, ...upper];
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

export function territoryPolygons(checkpoints: Checkpoint[]) {
  const unclaimed = checkpoints.filter(cp => cp.owner !== 'player').map(cp => ({ ...toMeters(cp.position), checkpoint: cp }));
  return connectedCheckpointGroups(checkpoints).filter(group => group.length >= 3).map(group => convexHull(group)).filter(hull => hull.length >= 3 && !unclaimed.some(point => insidePolygon(point, hull)));
}

// Ownership is the source of truth. Every ownership change rebuilds connected
// components and their hulls, so territories expand, shrink, split and merge.
export function rebuildTerritory(game: GameState) {
  const previouslyOwned = new Set(Object.values(game.cells).filter(c => c.ownerId === 'player').map(c => c.id));
  for (const cell of Object.values(game.cells)) if (cell.ownerId === 'player') { cell.ownerId = null; cell.ownerColor = null; }
  for (const polygon of territoryPolygons(game.checkpoints)) {
    const minX = Math.floor(Math.min(...polygon.map(point => point.x)) / CONFIG.cellMeters), maxX = Math.floor(Math.max(...polygon.map(point => point.x)) / CONFIG.cellMeters);
    const minY = Math.floor(Math.min(...polygon.map(point => point.y)) / CONFIG.cellMeters), maxY = Math.floor(Math.max(...polygon.map(point => point.y)) / CONFIG.cellMeters);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const point = { x: (x + .5) * CONFIG.cellMeters, y: (y + .5) * CONFIG.cellMeters };
      if (!insidePolygon(point, polygon)) continue;
      const id = cellId(x, y), cell: Cell = game.cells[id] ?? { id, x, y, ownerId: null, ownerColor: null, discovered: false };
      cell.ownerId = 'player'; cell.ownerColor = COLORS.player; game.cells[id] = cell;
    }
  }
  return Object.values(game.cells).filter(c => c.ownerId === 'player' && !previouslyOwned.has(c.id)).length;
}
