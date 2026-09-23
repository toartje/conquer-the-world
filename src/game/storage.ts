import type { GameState } from './types';
const KEY = 'ctw-prototype-v1';
export const gameStorage = {
  load(): GameState | null { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as GameState : null; } catch { return null; } },
  save(state: GameState) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Play remains usable if storage is unavailable. */ } },
  clear() { localStorage.removeItem(KEY); }
};
