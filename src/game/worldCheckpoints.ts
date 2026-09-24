import { rebuildTerritory } from './territory';
import type { Checkpoint, GameState } from './types';

export function isPopulationCheckpoint(checkpoint: Checkpoint) {
  return checkpoint.generationVersion !== undefined || checkpoint.zoneId !== undefined || checkpoint.id.startsWith('pop-');
}

// Loaded zones are a rendering/data window. Player-owned checkpoints remain in
// persistent game state even when their marker is outside that window.
export function mergeLoadedWorldCheckpoints(game: GameState, incoming: Checkpoint[]) {
  const incomingIds = new Set(incoming.map(checkpoint => checkpoint.id));
  const incomingById = new Map(incoming.map(checkpoint => [checkpoint.id, checkpoint]));
  const currentIds = new Set(game.checkpoints.map(checkpoint => checkpoint.id));
  const checkpoints: Checkpoint[] = [];
  let changed = false, ownershipChanged = false;

  for (const checkpoint of game.checkpoints) {
    if (isPopulationCheckpoint(checkpoint) && checkpoint.owner !== 'player' && !incomingIds.has(checkpoint.id)) {
      changed = true;
      continue;
    }
    const fresh = incomingById.get(checkpoint.id);
    if (fresh?.owner === 'player' && checkpoint.owner !== 'player') {
      checkpoints.push(fresh);
      changed = true;
      ownershipChanged = true;
    } else if (fresh && checkpoint.owner === null && (checkpoint.name !== fresh.name || checkpoint.position.lat !== fresh.position.lat || checkpoint.position.lng !== fresh.position.lng)) {
      checkpoints.push(fresh);
      changed = true;
    } else checkpoints.push(checkpoint);
  }

  for (const checkpoint of incoming) if (!currentIds.has(checkpoint.id)) {
    checkpoints.push(checkpoint);
    changed = true;
    ownershipChanged ||= checkpoint.owner === 'player';
  }
  if (!changed) return game;
  const merged = { ...game, checkpoints };
  if (ownershipChanged) rebuildTerritory(merged);
  return merged;
}
