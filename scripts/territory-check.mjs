import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { newGame, movePlayer, normalizeGame, claimCheckpoint } = await server.ssrLoadModule('/src/game/engine.ts');
  const { rebuildTerritory, connectedCheckpointGroups, checkpointConnections, territoryPolygons } = await server.ssrLoadModule('/src/game/territory.ts');
  const { mergeLoadedWorldCheckpoints } = await server.ssrLoadModule('/src/game/worldCheckpoints.ts');
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

  let claimFlow = structuredClone(two);
  claimFlow.checkpoints.forEach(checkpoint => { checkpoint.owner = null; });
  rebuildTerritory(claimFlow);
  for (let index = 0; index < 3; index++) {
    claimFlow.position = claimFlow.checkpoints[index].position;
    claimFlow = claimCheckpoint(claimFlow, claimFlow.checkpoints[index].id);
  }
  const claimedThreeCount = Object.values(claimFlow.cells).filter(c => c.ownerId === 'player').length;
  assert.ok(claimedThreeCount > 0, 'capturing the third connected checkpoint immediately creates territory');
  claimFlow.position = claimFlow.checkpoints[3].position;
  claimFlow = claimCheckpoint(claimFlow, claimFlow.checkpoints[3].id);
  assert.ok(Object.values(claimFlow.cells).filter(c => c.ownerId === 'player').length > claimedThreeCount, 'capturing the fourth checkpoint immediately expands territory');

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
  const fiveCount = Object.values(five.cells).filter(c => c.ownerId === 'player').length;
  assert.ok(fiveCount > Object.values(four.cells).filter(c => c.ownerId === 'player').length, 'a fifth checkpoint connected through the graph expands the same territory');
  assert.equal(connectedCheckpointGroups(five.checkpoints).filter(group => group.length >= 3).length, 1, 'five nearby checkpoints form one component');

  const edgeLoss = structuredClone(five);
  edgeLoss.checkpoints.find(cp => cp.id === 'fifth').owner = null;
  rebuildTerritory(edgeLoss);
  const edgeLossCount = Object.values(edgeLoss.cells).filter(c => c.ownerId === 'player').length;
  assert.ok(edgeLossCount > 0 && edgeLossCount < fiveCount, 'losing an edge checkpoint immediately shrinks territory without removing the remaining component');

  const separated = structuredClone(five);
  const remote = [[40, 0], [46, 0], [43, 6]].map(([x, y], index) => { const position = offsetCells(CONFIG.start, x, y), cell = cellAt(position); return { ...structuredClone(five.checkpoints[0]), id: `remote-${index}`, owner: 'player', position, cellId: cellId(cell.x, cell.y) }; });
  separated.checkpoints.push(...remote); rebuildTerritory(separated);
  assert.equal(connectedCheckpointGroups(separated.checkpoints).filter(group => group.length >= 3).length, 2, 'a remote connected trio creates a separate territory');
  const separatedTriangles = territoryPolygons(separated.checkpoints);
  assert.ok(separatedTriangles.length >= 2, 'two enclosed checkpoint groups create local territory polygons');
  assert.ok(separatedTriangles.every(triangle => !triangle.some(point => point.checkpoint.id.startsWith('remote-')) || triangle.every(point => point.checkpoint.id.startsWith('remote-'))), 'no local polygon stretches between disconnected groups');

  const merged = structuredClone(separated);
  for (const [index, [x, y]] of [[24, 3], [36, 3]].entries()) {
    const position = offsetCells(CONFIG.start, x, y), cell = cellAt(position);
    merged.checkpoints.push({ ...structuredClone(five.checkpoints[0]), id: `bridge-${index}`, owner: 'player', position, cellId: cellId(cell.x, cell.y) });
  }
  rebuildTerritory(merged);
  assert.equal(connectedCheckpointGroups(merged.checkpoints).filter(group => group.length >= 3).length, 1, 'capturing bridge checkpoints merges two territories into one network');
  assert.ok(territoryPolygons(merged.checkpoints).length > separatedTriangles.length, 'bridge checkpoints add local triangles instead of one global hull');

  const split = structuredClone(fresh);
  split.checkpoints = Array.from({ length: 7 }, (_, index) => { const position = offsetCells(CONFIG.start, index * 12, index % 2 ? 3 : 0), cell = cellAt(position); return { ...structuredClone(fresh.checkpoints[0]), id: `chain-${index}`, owner: 'player', position, cellId: cellId(cell.x, cell.y) }; });
  assert.equal(connectedCheckpointGroups(split.checkpoints).length, 1, 'bridge checkpoint joins both sides');
  assert.equal(checkpointConnections(split.checkpoints).length, 6, 'a chain exposes only its six valid local edges');
  rebuildTerritory(split);
  assert.equal(territoryPolygons(split.checkpoints).length, 0, 'a connected checkpoint chain has no enclosed local polygon');
  assert.equal(Object.values(split.cells).filter(cell => cell.ownerId === 'player').length, 0, 'a connected checkpoint chain does not claim a giant hull');
  split.checkpoints[3].owner = null; rebuildTerritory(split);
  assert.deepEqual(connectedCheckpointGroups(split.checkpoints).map(group => group.length).sort(), [3, 3], 'losing a bridge splits the network into two valid territories');
  assert.equal(Object.values(split.cells).filter(cell => cell.ownerId === 'player').length, 0, 'three checkpoints in a simple chain still do not create territory');

  const refreshSource = structuredClone(five);
  const sentinelPosition = offsetCells(CONFIG.start, 100, 100), sentinelCell = cellAt(sentinelPosition);
  refreshSource.checkpoints.push({ ...structuredClone(five.checkpoints[0]), id: 'kuurne-markt', owner: null, position: sentinelPosition, cellId: cellId(sentinelCell.x, sentinelCell.y) });
  const refreshed = normalizeGame(JSON.parse(JSON.stringify(refreshSource)));
  assert.equal(connectedCheckpointGroups(refreshed.checkpoints).find(group => group.some(cp => cp.id === 'fifth'))?.length, 5, 'refresh reconstructs the complete owned checkpoint network');
  assert.equal(Object.values(refreshed.cells).filter(c => c.ownerId === 'player').length, fiveCount, 'refresh reconstructs the same territory from checkpoint ownership');

  const zoned = structuredClone(five);
  zoned.checkpoints.forEach((checkpoint, index) => { checkpoint.zoneId = index < 2 ? 'zone:a' : 'zone:b'; checkpoint.generationVersion = 2; });
  const spare = { ...structuredClone(zoned.checkpoints[0]), id: 'cp-v2-spare', owner: null, zoneId: 'zone:a' };
  zoned.checkpoints.push(spare);
  const partialIncoming = zoned.checkpoints.slice(3, 5).map(checkpoint => ({ ...structuredClone(checkpoint), owner: null }));
  const partial = mergeLoadedWorldCheckpoints(zoned, partialIncoming);
  assert.equal(partial.checkpoints.filter(cp => cp.owner === 'player').length, 5, 'zone loading never removes owned checkpoints outside the visible marker set');
  assert.equal(partial.checkpoints.some(cp => cp.id === spare.id), false, 'unloaded neutral procedural markers are pruned');
  assert.equal(connectedCheckpointGroups(partial.checkpoints).filter(group => group.length >= 3).length, 1, 'zone borders do not split a connected ownership network');
  assert.equal(Object.values(partial.cells).filter(c => c.ownerId === 'player').length, fiveCount, 'partial visibility does not alter persistent territory');

  const serverPosition = offsetCells(CONFIG.start, 18, 0), serverCell = cellAt(serverPosition);
  const serverOwned = { ...structuredClone(zoned.checkpoints[0]), id: 'cp-v2-server-owned', owner: 'player', zoneId: 'zone:c', position: serverPosition, cellId: cellId(serverCell.x, serverCell.y) };
  const synced = mergeLoadedWorldCheckpoints(partial, [serverOwned]);
  assert.ok(Object.values(synced.cells).filter(c => c.ownerId === 'player').length > fiveCount, 'an owned checkpoint received from a loaded zone recalculates territory immediately');

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
