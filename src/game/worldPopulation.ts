import * as Lerc from 'lerc';
import lercWasmUrl from 'lerc/lerc-wasm.wasm?url';
import { CONFIG } from '../config';
import { cellAt, cellId } from './geo';
import type { Checkpoint } from './types';

export type GeoBounds = { south: number; west: number; north: number; east: number };

const SERVICE = 'https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Total_Population_1km/ImageServer';
const TILE_SIZE = 256;
const RESOLUTION = 0.0083333333;
const ORIGIN_X = -180;
const ORIGIN_Y = 84.00791653201003;
const REGION_PIXELS = 8;
const tileCache = new Map<string, Promise<DecodedTile>>();
let lercReady: Promise<void> | null = null;

type DecodedTile = { row: number; col: number; values: ArrayLike<number>; mask: Uint8Array | null };

function loadTile(row: number, col: number) {
  const key = `${row}:${col}`;
  let cached = tileCache.get(key);
  if (!cached) {
    cached = (async () => {
      lercReady ??= Lerc.load({ locateFile: () => lercWasmUrl });
      await lercReady;
      const response = await fetch(`${SERVICE}/tile/0/${row}/${col}?time=2020-01-01`);
      if (!response.ok) throw new Error(`WorldPop ${response.status}`);
      const decoded = Lerc.decode(await response.arrayBuffer());
      return { row, col, values: decoded.pixels[0], mask: decoded.mask };
    })();
    tileCache.set(key, cached);
    cached.catch(() => tileCache.delete(key));
  }
  return cached;
}

function hash01(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

function makeCheckpoint(id: string, lat: number, lng: number): Checkpoint {
  const position = { lat, lng }, cell = cellAt(position);
  return {
    id,
    name: `Checkpoint ${lat.toFixed(3)}, ${lng.toFixed(3)}`,
    position,
    cellId: cellId(cell.x, cell.y),
    owner: null,
    level: 1,
    hp: CONFIG.checkpointLevels[0].hp,
    xp: 0,
    defenders: Array(10).fill(null),
    waitingMinions: [],
    breached: false,
    recruitsUsed: 0,
  };
}

function checkpointsFromTile(tile: DecodedTile, bounds: GeoBounds) {
  const checkpoints: Checkpoint[] = [];
  const tilePixelX = tile.col * TILE_SIZE, tilePixelY = tile.row * TILE_SIZE;
  for (let regionY = 0; regionY < TILE_SIZE; regionY += REGION_PIXELS) {
    for (let regionX = 0; regionX < TILE_SIZE; regionX += REGION_PIXELS) {
      const west = ORIGIN_X + (tilePixelX + regionX) * RESOLUTION;
      const east = west + REGION_PIXELS * RESOLUTION;
      const north = ORIGIN_Y - (tilePixelY + regionY) * RESOLUTION;
      const south = north - REGION_PIXELS * RESOLUTION;
      if (east < bounds.west || west > bounds.east || north < bounds.south || south > bounds.north) continue;

      const populated: { x: number; y: number; population: number }[] = [];
      let total = 0;
      for (let y = regionY; y < regionY + REGION_PIXELS; y++) for (let x = regionX; x < regionX + REGION_PIXELS; x++) {
        const index = y * TILE_SIZE + x;
        if (tile.mask && !tile.mask[index]) continue;
        const population = Math.max(0, Number(tile.values[index]) || 0);
        if (population < 0.01) continue;
        populated.push({ x, y, population });
        total += population;
      }
      const count = Math.floor(total / 1000);
      if (!count || !populated.length) continue;

      let cursor = 0, cumulative = populated[0].population;
      for (let i = 0; i < count; i++) {
        const target = (i + 0.5) * total / count;
        while (cursor < populated.length - 1 && cumulative < target) {
          cursor++;
          cumulative += populated[cursor].population;
        }
        const pixel = populated[cursor];
        const globalX = tilePixelX + pixel.x, globalY = tilePixelY + pixel.y;
        const id = `pop-${globalY}-${globalX}-${i}`;
        const jitterX = 0.18 + hash01(`${id}:x`) * 0.64;
        const jitterY = 0.18 + hash01(`${id}:y`) * 0.64;
        const lng = ORIGIN_X + (globalX + jitterX) * RESOLUTION;
        const lat = ORIGIN_Y - (globalY + jitterY) * RESOLUTION;
        if (lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east) {
          checkpoints.push(makeCheckpoint(id, lat, lng));
        }
      }
    }
  }
  return checkpoints;
}

export async function loadPopulationCheckpoints(bounds: GeoBounds) {
  const minCol = Math.max(0, Math.floor((bounds.west - ORIGIN_X) / (RESOLUTION * TILE_SIZE)));
  const maxCol = Math.min(168, Math.floor((bounds.east - ORIGIN_X) / (RESOLUTION * TILE_SIZE)));
  const minRow = Math.max(0, Math.floor((ORIGIN_Y - bounds.north) / (RESOLUTION * TILE_SIZE)));
  const maxRow = Math.min(73, Math.floor((ORIGIN_Y - bounds.south) / (RESOLUTION * TILE_SIZE)));
  const requests: Promise<DecodedTile>[] = [];
  for (let row = minRow; row <= maxRow; row++) for (let col = minCol; col <= maxCol; col++) requests.push(loadTile(row, col));
  const tiles = await Promise.all(requests);
  return tiles.flatMap(tile => checkpointsFromTile(tile, bounds));
}
