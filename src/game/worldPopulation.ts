import * as Lerc from 'lerc';
import lercWasmUrl from 'lerc/lerc-wasm.wasm?url';
import { CONFIG } from '../config';
import { cellAt, cellId, distanceMeters, toMeters } from './geo';
import type { Checkpoint, Position } from './types';

export type GeoBounds = { south: number; west: number; north: number; east: number };
export type ZoneInfo = { id: string; x: number; y: number; bounds: GeoBounds };
export const CHECKPOINT_GENERATION_VERSION = 2;
export const POPULATION_ZONE_PIXELS = 8;
export const POPULATION_ZONE_CACHE_LIMIT = 72;

const SERVICE = 'https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Total_Population_1km/ImageServer';
const TILE_SIZE = 256, RESOLUTION = 0.0083333333, ORIGIN_X = -180, ORIGIN_Y = 84.00791653201003;
const tileCache = new Map<string, Promise<DecodedTile>>(), rawZoneCache = new Map<string, Promise<RawZone>>(), zoneCache = new Map<string, Promise<Checkpoint[]>>();
let lercReady: Promise<void> | null = null;

type DecodedTile = { values: ArrayLike<number>; mask: Uint8Array | null };
type Candidate = { id: string; zoneId: string; position: Position; priority: number; spacing: number; seed: string };
type RawZone = { info: ZoneInfo; population: number; spacing: number; candidates: Candidate[] };

function hash32(value: string) { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return hash >>> 0; }
function random(seed: string, index: number) { let value = hash32(`${seed}:${index}`) || 1; value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; }
function touchLru<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) { cache.delete(key); cache.set(key, value); while (cache.size > limit) cache.delete(cache.keys().next().value!); }
function zoneId(x: number, y: number) { return `zone:${x}:${y}:v${CHECKPOINT_GENERATION_VERSION}`; }
function zoneInfo(x: number, y: number): ZoneInfo { const west = ORIGIN_X + x * POPULATION_ZONE_PIXELS * RESOLUTION, north = ORIGIN_Y - y * POPULATION_ZONE_PIXELS * RESOLUTION; return { id: zoneId(x, y), x, y, bounds: { west, east: west + POPULATION_ZONE_PIXELS * RESOLUTION, north, south: north - POPULATION_ZONE_PIXELS * RESOLUTION } }; }

export function zoneAt(position: Position) { return zoneInfo(Math.floor((position.lng - ORIGIN_X) / (POPULATION_ZONE_PIXELS * RESOLUTION)), Math.floor((ORIGIN_Y - position.lat) / (POPULATION_ZONE_PIXELS * RESOLUTION))); }
export function zonesForBounds(bounds: GeoBounds, preload = 0) {
  const min = zoneAt({ lat: bounds.north, lng: bounds.west }), max = zoneAt({ lat: bounds.south, lng: bounds.east }), zones: ZoneInfo[] = [];
  const worldMaxX = Math.ceil(360 / (POPULATION_ZONE_PIXELS * RESOLUTION)) - 1, worldMaxY = Math.ceil((ORIGIN_Y + 72) / (POPULATION_ZONE_PIXELS * RESOLUTION));
  for (let y = Math.max(0, min.y - preload); y <= Math.min(worldMaxY, max.y + preload); y++) for (let x = Math.max(0, min.x - preload); x <= Math.min(worldMaxX, max.x + preload); x++) zones.push(zoneInfo(x, y));
  return zones;
}
export function zoneRequestKey(bounds: GeoBounds, preload = 1) { return zonesForBounds(bounds, preload).map(zone => zone.id).join('|'); }

function loadTile(row: number, col: number) {
  const key = `${row}:${col}`, present = tileCache.get(key);
  if (present) { touchLru(tileCache, key, present, 12); return present; }
  const request = (async () => { lercReady ??= Lerc.load({ locateFile: () => lercWasmUrl }); await lercReady; const response = await fetch(`${SERVICE}/tile/0/${row}/${col}?time=2020-01-01`); if (!response.ok) throw new Error(`WorldPop ${response.status}`); const decoded = Lerc.decode(await response.arrayBuffer()); return { values: decoded.pixels[0], mask: decoded.mask }; })();
  touchLru(tileCache, key, request, 12); request.catch(() => tileCache.delete(key)); return request;
}

function spacingForPopulation(population: number) { return population >= 250000 ? 120 : population >= 100000 ? 180 : population >= 25000 ? 300 : population >= 3000 ? 600 : 1000; }

async function loadRawZone(x: number, y: number) {
  const id = zoneId(x, y), present = rawZoneCache.get(id);
  if (present) { touchLru(rawZoneCache, id, present, POPULATION_ZONE_CACHE_LIMIT * 2); return present; }
  const request = (async (): Promise<RawZone> => {
    const globalPixelX = x * POPULATION_ZONE_PIXELS, globalPixelY = y * POPULATION_ZONE_PIXELS, tileCol = Math.floor(globalPixelX / TILE_SIZE), tileRow = Math.floor(globalPixelY / TILE_SIZE), info = zoneInfo(x, y);
    if (tileCol < 0 || tileCol > 168 || tileRow < 0 || tileRow > 73) return { info, population: 0, spacing: 1000, candidates: [] };
    const tile = await loadTile(tileRow, tileCol), localStartX = globalPixelX - tileCol * TILE_SIZE, localStartY = globalPixelY - tileRow * TILE_SIZE;
    const pixels: { x: number; y: number; population: number }[] = []; let population = 0;
    for (let py = 0; py < POPULATION_ZONE_PIXELS; py++) for (let px = 0; px < POPULATION_ZONE_PIXELS; px++) { const index = (localStartY + py) * TILE_SIZE + localStartX + px; if (tile.mask && !tile.mask[index]) continue; const value = Math.max(0, Number(tile.values[index]) || 0); if (value <= .01) continue; pixels.push({ x: globalPixelX + px, y: globalPixelY + py, population: value }); population += value; }
    const spacing = spacingForPopulation(population), zoneCentre = { lat: (info.bounds.north + info.bounds.south) / 2, lng: (info.bounds.east + info.bounds.west) / 2 };
    const zoneWidth = distanceMeters({ ...zoneCentre, lng: info.bounds.west }, { ...zoneCentre, lng: info.bounds.east }), zoneHeight = distanceMeters({ ...zoneCentre, lat: info.bounds.south }, { ...zoneCentre, lat: info.bounds.north });
    const capacity = Math.max(1, Math.floor(zoneWidth * zoneHeight / (spacing * spacing * .72))), count = Math.min(Math.floor(population / 1000), capacity);
    if (!count || !pixels.length) return { info, population, spacing, candidates: [] };
    const seed = `${id}:population:${Math.round(population)}:blue-noise`, candidates: Candidate[] = []; let totalWeight = 0; const cumulative = pixels.map(pixel => totalWeight += pixel.population), proposals = Math.max(count * 4, 24);
    for (let i = 0; i < proposals; i++) { const target = random(seed, i * 4) * totalWeight; let low = 0, high = cumulative.length - 1; while (low < high) { const mid = (low + high) >> 1; if (cumulative[mid] < target) low = mid + 1; else high = mid; } const pixel = pixels[low], lng = ORIGIN_X + (pixel.x + .08 + random(seed, i * 4 + 1) * .84) * RESOLUTION, lat = ORIGIN_Y - (pixel.y + .08 + random(seed, i * 4 + 2) * .84) * RESOLUTION, candidateSeed = `${seed}:${i}`; candidates.push({ id: `cp-v${CHECKPOINT_GENERATION_VERSION}-${x}-${y}-${i}`, zoneId: id, position: { lat, lng }, priority: random(seed, i * 4 + 3), spacing, seed: candidateSeed }); }
    return { info, population, spacing, candidates };
  })();
  touchLru(rawZoneCache, id, request, POPULATION_ZONE_CACHE_LIMIT * 2); request.catch(() => rawZoneCache.delete(id)); return request;
}

function makeCheckpoint(candidate: Candidate): Checkpoint { const cell = cellAt(candidate.position); return { id: candidate.id, name: `Checkpoint ${candidate.position.lat.toFixed(3)}, ${candidate.position.lng.toFixed(3)}`, position: candidate.position, cellId: cellId(cell.x, cell.y), owner: null, level: 1, hp: CONFIG.checkpointLevels[0].hp, xp: 0, defenders: Array(10).fill(null), waitingMinions: [], breached: false, recruitsUsed: 0, zoneId: candidate.zoneId, generationVersion: CHECKPOINT_GENERATION_VERSION }; }

async function generateZone(info: ZoneInfo) {
  const present = zoneCache.get(info.id); if (present) { touchLru(zoneCache, info.id, present, POPULATION_ZONE_CACHE_LIMIT); return present; }
  const request = (async () => {
    const nearby = await Promise.all(Array.from({ length: 9 }, (_, index) => loadRawZone(info.x + index % 3 - 1, info.y + Math.floor(index / 3) - 1))), target = nearby.find(zone => zone.info.id === info.id)!, desired = Math.floor(target.population / 1000), accepted: Candidate[] = [];
    const ordered = nearby.flatMap(zone => zone.candidates).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const buckets = new Map<string, Candidate[]>(), bucketMeters = 1000;
    for (const candidate of ordered) {
      const metric = toMeters(candidate.position), bx = Math.floor(metric.x / bucketMeters), by = Math.floor(metric.y / bucketMeters); let blocked = false;
      for (let dy = -1; dy <= 1 && !blocked; dy++) for (let dx = -1; dx <= 1 && !blocked; dx++) for (const other of buckets.get(`${bx + dx}:${by + dy}`) ?? []) if (distanceMeters(candidate.position, other.position) < Math.min(candidate.spacing, other.spacing)) { blocked = true; break; }
      if (blocked) continue;
      accepted.push(candidate); const key = `${bx}:${by}`, bucket = buckets.get(key) ?? []; bucket.push(candidate); buckets.set(key, bucket);
    }
    return accepted.filter(candidate => candidate.zoneId === info.id).sort((a, b) => a.id.localeCompare(b.id)).slice(0, desired).map(makeCheckpoint);
  })();
  touchLru(zoneCache, info.id, request, POPULATION_ZONE_CACHE_LIMIT); request.catch(() => zoneCache.delete(info.id)); return request;
}

export async function loadPopulationCheckpoints(bounds: GeoBounds, preload = 1) {
  const visibleZones = zonesForBounds(bounds), nearbyZones = zonesForBounds(bounds, preload);
  const visibleIds = new Set(visibleZones.map(zone => zone.id));
  const checkpoints = (await Promise.all(visibleZones.map(generateZone))).flat();
  const background = nearbyZones.filter(zone => !visibleIds.has(zone.id));
  if (background.length) void Promise.all(background.map(generateZone)).catch(() => undefined);
  return checkpoints.filter(cp => cp.position.lat >= bounds.south - .08 && cp.position.lat <= bounds.north + .08 && cp.position.lng >= bounds.west - .08 && cp.position.lng <= bounds.east + .08);
}
export function populationZoneCacheStats() { return { tiles: tileCache.size, rawZones: rawZoneCache.size, zones: zoneCache.size, limit: POPULATION_ZONE_CACHE_LIMIT }; }
export function realtimeRoomForZone(id: string) { return `zone:${id}`; }
