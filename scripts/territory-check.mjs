import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { newGame, movePlayer, normalizeGame } = await server.ssrLoadModule('/src/game/engine.ts');
  const { rebuildTerritory, connectedCheckpointGroups } = await server.ssrLoadModule('/src/game/territory.ts');
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

  const five = structuredClone(four);
  const fifthPosition = offsetCells(CONFIG.start, 12, 3), fifthCell = cellAt(fifthPosition);
  five.checkpoints.push({ ...structuredClone(five.checkpoints[0]), id: 'fifth', owner: 'player', position: fifthPosition, cellId: cellId(fifthCell.x, fifthCell.y) });
  rebuildTerritory(five);
  assert.ok(Object.values(five.cells).filter(c => c.ownerId === 'player').length > Object.values(four.cells).filter(c => c.ownerId === 'player').length, 'a fifth checkpoint connected through the graph expands the same territory');
  assert.equal(connectedCheckpointGroups(five.checkpoints).filter(group => group.length >= 3).length, 1, 'five nearby checkpoints form one component');

  const separated = structuredClone(five);
  const remote = [[40, 0], [46, 0], [43, 6]].map(([x, y], index) => { const position = offsetCells(CONFIG.start, x, y), cell = cellAt(position); return { ...structuredClone(five.checkpoints[0]), id: `remote-${index}`, owner: 'player', position, cellId: cellId(cell.x, cell.y) }; });
  separated.checkpoints.push(...remote); rebuildTerritory(separated);
  assert.equal(connectedCheckpointGroups(separated.checkpoints).filter(group => group.length >= 3).length, 2, 'a remote connected trio creates a separate territory');

  const split = structuredClone(fresh);
  split.checkpoints = Array.from({ length: 7 }, (_, index) => { const position = offsetCells(CONFIG.start, index * 12, index % 2 ? 3 : 0), cell = cellAt(position); return { ...structuredClone(fresh.checkpoints[0]), id: `chain-${index}`, owner: 'player', position, cellId: cellId(cell.x, cell.y) }; });
  assert.equal(connectedCheckpointGroups(split.checkpoints).length, 1, 'bridge checkpoint joins both sides');
  split.checkpoints[3].owner = null; rebuildTerritory(split);
  assert.deepEqual(connectedCheckpointGroups(split.checkpoints).map(group => group.length).sort(), [3, 3], 'losing a bridge splits the network into two valid territories');
  assert.ok(Object.values(split.cells).some(cell => cell.ownerId === 'player'), 'split components with three checkpoints keep territory');

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
