import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { newGame, claimCheckpoint, movePlayer, recruitMinion, upgradeCheckpoint, unassignedMinions, normalizeGame, stationMinion, recallMinion, setSquad, checkpointCapacity, summonOptions, advanceTime, buildCamp, buyCampWorker, startTraining, campStats } = await server.ssrLoadModule('/src/game/engine.ts');
  const { cellAt, cellId, offsetCells } = await server.ssrLoadModule('/src/game/geo.ts');
  const { CONFIG } = await server.ssrLoadModule('/src/config.ts');
  const checkPlaced = game => {
    const places = [
      ...game.squad,
      ...game.checkpoints.flatMap(cp => [...(cp.owner === 'player' ? cp.defenders : []), ...cp.waitingMinions]),
      ...game.camps.flatMap(camp => [...camp.workers, ...camp.training.map(job => job.minionId)])
    ].filter(Boolean);
    assert.equal(places.length, game.minions.length, 'every minion has one place');
    assert.equal(new Set(places).size, places.length, 'no minion is placed twice');
    assert.equal(unassignedMinions(game).length, 0, 'no loose minions');
  };

  const fresh = newGame();
  assert.equal(fresh.squad.filter(Boolean).length, 5, 'player starts with five minions');
  checkPlaced(fresh);
  assert.strictEqual(setSquad(fresh, 0, null), fresh, 'player minions cannot become loose');

  const after20 = advanceTime(fresh, fresh.player.lastMinionAt + CONFIG.freeMinionMinutes * 60 * 1000);
  assert.equal(after20.squad.filter(Boolean).length, 6, 'one free minion arrives after 20 minutes');
  const offline = advanceTime(fresh, fresh.player.lastMinionAt + CONFIG.freeMinionMinutes * 60 * 1000 * 8, true);
  assert.equal(offline.squad.filter(Boolean).length, 5, 'offline free minions stop at five');

  const cp = fresh.checkpoints.find(c => c.id === 'north-gate');
  assert.strictEqual(recruitMinion(fresh, cp.id, 5), fresh, 'cannot recruit at neutral checkpoint');

  const nearby = movePlayer(fresh, cp.position);
  const owned = claimCheckpoint(nearby, cp.id);
  assert.equal(owned.checkpoints.find(c => c.id === cp.id).owner, 'player');
  assert.strictEqual(recruitMinion(owned, 'ember-post', 5), owned, 'cannot recruit at enemy checkpoint');
  const remote = { ...owned, position: offsetCells(cp.position, 20, 0) };
  assert.strictEqual(recruitMinion(remote, cp.id, 5), remote, 'cannot recruit remotely');
  assert.strictEqual(recruitMinion(owned, cp.id, 0), owned, 'cannot recruit into an occupied player slot');
  assert.equal(summonOptions(owned.checkpoints.find(c => c.id === cp.id)).map(o => o.kind).join(','), 'standard');

  const toPlayer = recruitMinion(owned, cp.id, 5, 'standard');
  assert.equal(toPlayer.minions.length, owned.minions.length + 1);
  assert.equal(toPlayer.player.tokens, owned.player.tokens - CONFIG.summonCosts.standard);
  assert.equal(toPlayer.squad[5], toPlayer.minions.at(-1).id);
  checkPlaced(toPlayer);

  const inTower = stationMinion(toPlayer, cp.id, toPlayer.squad[5]);
  assert.equal(inTower.squad[5], null);
  assert.ok(inTower.checkpoints.find(c => c.id === cp.id).defenders.includes(toPlayer.minions.at(-1).id));
  checkPlaced(inTower);
  assert.strictEqual(stationMinion(remote, cp.id, remote.squad[0]), remote, 'tower placement requires proximity');
  const defenderSlot = inTower.checkpoints.find(c => c.id === cp.id).defenders.indexOf(toPlayer.minions.at(-1).id);
  assert.strictEqual(recallMinion(inTower, cp.id, defenderSlot, 0), inTower, 'recall requires a free player slot');
  const returned = recallMinion(inTower, cp.id, defenderSlot, 5);
  assert.equal(returned.squad[5], toPlayer.minions.at(-1).id);
  checkPlaced(returned);

  const funded = structuredClone(returned);
  funded.player.tokens = 1000;
  const level2 = upgradeCheckpoint(funded, cp.id);
  assert.ok(summonOptions(level2.checkpoints.find(c => c.id === cp.id)).some(o => o.kind === 'wizard'), 'level 2 unlocks wizard');
  const wizard = recruitMinion(level2, cp.id, 'tower', 'wizard');
  assert.equal(wizard.player.tokens, level2.player.tokens - CONFIG.summonCosts.wizard);
  const level3 = upgradeCheckpoint(wizard, cp.id);
  const level4 = upgradeCheckpoint(level3, cp.id);
  assert.ok(summonOptions(level4.checkpoints.find(c => c.id === cp.id)).some(o => o.kind === 'hexer'), 'level 4 unlocks hexer');
  const level5 = upgradeCheckpoint(level4, cp.id);
  assert.ok(summonOptions(level5.checkpoints.find(c => c.id === cp.id)).some(o => o.kind === 'beast'), 'level 5 unlocks beast');
  const beast = recruitMinion(level5, cp.id, 'tower', 'beast');
  assert.equal(beast.minions.at(-1).kind, 'beast');
  checkPlaced(beast);

  const noPlace = structuredClone(owned);
  noPlace.player.tokens = 1000;
  noPlace.squad.fill('occupied');
  noPlace.checkpoints[0].defenders.fill('occupied');
  assert.strictEqual(recruitMinion(noPlace, cp.id, 5), noPlace, 'cannot recruit into a full player bar');
  assert.strictEqual(recruitMinion(noPlace, cp.id, 'tower'), noPlace, 'cannot recruit into a full tower');

  const oldSave = structuredClone(owned);
  oldSave.squad[3] = null;
  delete oldSave.camps;
  delete oldSave.player.lastMinionAt;
  delete oldSave.player.lastSeenAt;
  delete oldSave.checkpoints[0].waitingMinions;
  const migrated = normalizeGame(oldSave);
  checkPlaced(migrated);

  const overflow = structuredClone(owned);
  overflow.squad[5] = overflow.minions[0].id;
  overflow.squad[6] = overflow.minions[1].id;
  for (let i = 0; i < checkpointCapacity(1); i++) overflow.checkpoints[0].defenders[i] = overflow.minions[i % overflow.minions.length].id;
  for (let i = 0; i < 20; i++) overflow.minions.push({ ...overflow.minions[0], id: `old-extra-${i}` });
  const rescued = normalizeGame(overflow);
  checkPlaced(rescued);
  assert.ok(rescued.checkpoints[0].waitingMinions.length > 0, 'overflow waits at a named checkpoint');
  const waitingId = rescued.checkpoints[0].waitingMinions[0];
  const rescuedUpgrade = upgradeCheckpoint(rescued, cp.id);
  const rescuedStation = stationMinion(rescuedUpgrade, cp.id, waitingId);
  assert.ok(rescuedStation.checkpoints[0].defenders.includes(waitingId), 'saved overflow can take a newly opened tower place');
  checkPlaced(rescuedStation);

  const campBase = structuredClone(owned);
  campBase.player.tokens = 1000;
  const campCell = cellAt(campBase.position), campCellId = cellId(campCell.x, campCell.y);
  campBase.cells[campCellId] = { id: campCellId, x: campCell.x, y: campCell.y, ownerId: 'player', ownerColor: '#35c9a5', discovered: true };
  const farm = buildCamp(campBase, 'farm');
  assert.equal(farm.camps[0].type, 'farm');
  assert.equal(farm.camps[0].workers.length, 1);
  const twoFarmers = buyCampWorker(farm, farm.camps[0].id);
  assert.equal(campStats(twoFarmers).foodCapacity, 6);
  const towerFoodCheck = stationMinion(twoFarmers, cp.id, twoFarmers.squad.find(Boolean));
  assert.equal(campStats(towerFoodCheck).towerHunger, 1, 'each tower minion uses exactly one food place');

  const damageCheck = structuredClone(towerFoodCheck);
  const towerMinionId = damageCheck.checkpoints.find(cp => cp.owner === 'player').defenders.find(Boolean);
  const squadMinionId = damageCheck.squad.find(Boolean);
  const towerHp = damageCheck.minions.find(m => m.id === towerMinionId)?.currentHp;
  const squadHp = damageCheck.minions.find(m => m.id === squadMinionId)?.currentHp;
  damageCheck.camps = [];
  damageCheck.player.lastSeenAt = 0;
  const starved = advanceTime(damageCheck, CONFIG.starvationGraceHours * 60 * 60 * 1000);
  assert.ok(starved.minions.find(m => m.id === towerMinionId).currentHp < towerHp, 'food shortage damages a tower minion');
  assert.equal(starved.minions.find(m => m.id === squadMinionId).currentHp, squadHp, 'food shortage does not damage a squad minion');

  const training = buildCamp(twoFarmers, 'training');
  const trainingCamp = training.camps.find(c => c.type === 'training');
  const traineeId = training.squad.find(Boolean);
  const started = startTraining(training, trainingCamp.id, traineeId, 1000);
  assert.equal(started.camps.find(c => c.id === trainingCamp.id).training.length, 1);
  assert.ok(!started.squad.includes(traineeId), 'training minion leaves player bar while training');
  const finished = advanceTime(started, 1000 + CONFIG.trainingMinutes * 60 * 1000);
  assert.equal(finished.minions.find(m => m.id === traineeId).level, 2);
  checkPlaced(finished);

  console.log('Minion placement, timed growth, summons, camps, feeding and training verified.');
} finally {
  await server.close();
}
