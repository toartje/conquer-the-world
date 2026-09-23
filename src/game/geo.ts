import { CONFIG } from '../config';
import type { Position } from './types';

const EARTH = 6378137;
export function toMeters(p: Position) { return { x: EARTH * p.lng * Math.PI / 180, y: EARTH * Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 360)) }; }
export function fromMeters(x: number, y: number): Position { return { lng: x / EARTH * 180 / Math.PI, lat: (2 * Math.atan(Math.exp(y / EARTH)) - Math.PI / 2) * 180 / Math.PI }; }
export function cellAt(p: Position) { const m = toMeters(p); return { x: Math.floor(m.x / CONFIG.cellMeters), y: Math.floor(m.y / CONFIG.cellMeters) }; }
export function cellId(x: number, y: number) { return `${x}:${y}`; }
export function cellCenter(x: number, y: number) { return fromMeters((x + .5) * CONFIG.cellMeters, (y + .5) * CONFIG.cellMeters); }
export function cellCorners(x: number, y: number) { return [fromMeters(x * CONFIG.cellMeters, y * CONFIG.cellMeters), fromMeters((x + 1) * CONFIG.cellMeters, (y + 1) * CONFIG.cellMeters)] as const; }
export function offsetCells(p: Position, dx: number, dy: number) { const m = toMeters(p); return fromMeters(m.x + dx * CONFIG.cellMeters, m.y + dy * CONFIG.cellMeters); }
export function distanceMeters(a: Position, b: Position) { const lat = (a.lat + b.lat) * Math.PI / 360; const dx = (a.lng - b.lng) * 111320 * Math.cos(lat); const dy = (a.lat - b.lat) * 111320; return Math.hypot(dx, dy); }
export function clampWorldPosition(p: Position): Position {
  const { south, west, north, east } = CONFIG.worldBounds;
  return { lat: Math.max(south, Math.min(north, p.lat)), lng: Math.max(west, Math.min(east, p.lng)) };
}
