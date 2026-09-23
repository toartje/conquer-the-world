import { COLORS, CONFIG } from '../config';
import { cellId, toMeters } from './geo';
import type { Cell, Checkpoint, GameState } from './types';

type Point = { x: number; y: number };
type Vertex = Point & { checkpoint: Checkpoint };

function area(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function insideTriangle(point: Point, a: Point, b: Point, c: Point) {
  const first = area(a, b, point), second = area(b, c, point), third = area(c, a, point);
  return !(first < -0.01 || second < -0.01 || third < -0.01) || !(first > 0.01 || second > 0.01 || third > 0.01);
}

function near(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y) <= CONFIG.territoryLinkMeters; }

function validTriangles(checkpoints: Checkpoint[]) {
  const vertices: Vertex[] = checkpoints.map(checkpoint => ({ ...toMeters(checkpoint.position), checkpoint }));
  const owned = vertices.filter(v => v.checkpoint.owner === 'player');
  const unclaimed = vertices.filter(v => v.checkpoint.owner !== 'player');
  const triangles: [Vertex, Vertex, Vertex][] = [];
  for (let i = 0; i < owned.length - 2; i++) for (let j = i + 1; j < owned.length - 1; j++) for (let k = j + 1; k < owned.length; k++) {
    const a = owned[i], b = owned[j], c = owned[k];
    if (!near(a, b) || !near(b, c) || !near(c, a) || Math.abs(area(a, b, c)) < CONFIG.cellMeters ** 2) continue;
    if (unclaimed.some(v => insideTriangle(v, a, b, c))) continue;
    triangles.push([a, b, c]);
  }
  return triangles;
}

// Territory is the union of local triangles bounded by three owned checkpoints.
// A neutral or enemy checkpoint inside a triangle blocks that entire triangle.
// Fog discovery is deliberately left alone: walking reveals, checkpoints claim.
export function rebuildTerritory(game: GameState) {
  const previouslyOwned = new Set(Object.values(game.cells).filter(c => c.ownerId === 'player').map(c => c.id));
  for (const cell of Object.values(game.cells)) if (cell.ownerId === 'player') {
    cell.ownerId = null; cell.ownerColor = null;
  }
  const blockedCells = new Set(game.checkpoints.filter(cp => cp.owner !== 'player').map(cp => cp.cellId));
  for (const [a, b, c] of validTriangles(game.checkpoints)) {
    const minX = Math.floor(Math.min(a.x, b.x, c.x) / CONFIG.cellMeters);
    const maxX = Math.floor(Math.max(a.x, b.x, c.x) / CONFIG.cellMeters);
    const minY = Math.floor(Math.min(a.y, b.y, c.y) / CONFIG.cellMeters);
    const maxY = Math.floor(Math.max(a.y, b.y, c.y) / CONFIG.cellMeters);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      const id = cellId(x, y);
      if (blockedCells.has(id) || !insideTriangle({ x: (x + .5) * CONFIG.cellMeters, y: (y + .5) * CONFIG.cellMeters }, a, b, c)) continue;
      const cell: Cell = game.cells[id] ?? { id, x, y, ownerId: null, ownerColor: null, discovered: false };
      cell.ownerId = 'player'; cell.ownerColor = COLORS.player;
      game.cells[id] = cell;
    }
  }
  return Object.values(game.cells).filter(c => c.ownerId === 'player' && !previouslyOwned.has(c.id)).length;
}
