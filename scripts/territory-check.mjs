import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { newGame, movePlayer, normalizeGame } = await server.ssrLoadModule('/src/game/engine.ts');
  const { rebuildTerritory } = await server.ssrLoadModule('/src/game/territory.ts');
  const { offsetCells, cellAt, cellId } = await server.ssrLoadModule('/src/game/geo.ts');
  const { CONFIG } = await server.ssrLoadModule('/src/config.ts');

  const fresh = newGame();
  assert.equal(Object.values(fresh.cells).filter(c => c.ownerId === 'player').length, 0, 'new games start without green ground');
  const walked = movePlayer(fresh, offsetCells(fresh.position, 1, 0));
  assert.ok(Object.values(walked.cells).filter(c => c.discovered).length > Object.values(fresh.cells).filter(c => c.discovered).length, 'walking reveals fog');
  assert.equal(Object.values(walked.cells).filter(c => c.ownerId === 'player').length, 0, 'walking does not claim ground');

  const edge = movePlayer(fresh, { lat: 90, lng: 540 });
  assert.deepEqual(edge.position, { lat: CONFIG.worldBounds.north, lng: CONFIG.worldBounds.east }, 'movement stays inside the playable world');

  const two = structuredClone(fresh);
  // Controlled nearby geometry tests the territory rule independently of town locations.
  two.checkpoints = two.checkpoints.slice(0, 4).map((cp, i) => {
    const offsets = [[0, 0], [6, 0], [0, 6], [6, 6]];
    const position = offsetCells(CONFIG.start, ...offsets[i]);
    const c = cellAt(position);
    return { ...cp, owner: null, position, cellId: cellId(c.x, c.y) };
  });
  two.checkpoints[0].owner = 'player'; two.checkpoints[1].owner = 'player';
  rebuildTerritory(two);
  assert.equal(Object.values(two.cells).filter(c => c.ownerId === 'player').length, 0, 'two checkpoints do not claim land');

  const three = structuredClone(two);
  three.checkpoints[2].owner = 'player';
  rebuildTerritory(three);
  const threeCount = Object.values(three.cells).filter(c => c.ownerId === 'player').length;
  assert.ok(threeCount > 0, 'three owned checkpoints claim their enclosed area');

  const four = structuredClone(three);
  four.checkpoints[3].owner = 'player';
  rebuildTerritory(four);
  assert.ok(Object.values(four.cells).filter(c => c.ownerId === 'player').length > threeCount, 'a fourth owned checkpoint expands the connected area');

  const blocked = structuredClone(fresh);
  blocked.checkpoints = structuredClone(three.checkpoints.slice(0, 3));
  const a = blocked.checkpoints[0].position, b = blocked.checkpoints[1].position, c = blocked.checkpoints[2].position;
  blocked.checkpoints.push({ ...structuredClone(fresh.checkpoints[3]), owner: null, position: { lat: (a.lat + b.lat + c.lat) / 3, lng: (a.lng + b.lng + c.lng) / 3 } });
  rebuildTerritory(blocked);
  assert.equal(Object.values(blocked.cells).filter(c => c.ownerId === 'player').length, 0, 'an unclaimed checkpoint inside blocks the area');

  const oldSave = structuredClone(fresh);
  const firstCell = Object.values(oldSave.cells).find(c => c.discovered);
  firstCell.ownerId = 'player';
  assert.equal(Object.values(normalizeGame(oldSave).cells).filter(c => c.ownerId === 'player').length, 0, 'old walking claims are removed on load');
  console.log('Territory rules verified.');
} finally {
  await server.close();
}
