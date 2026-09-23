import { COLORS, CONFIG } from '../config';
import { cellAt, cellId, clampWorldPosition, distanceMeters, offsetCells } from './geo';
import { rebuildTerritory } from './territory';
import { KUURNE_CHECKPOINTS } from './kuurne';
import type { Camp, CampType, Cell, Checkpoint, GameState, Minion, MinionKind, Owner, Position } from './types';

type RecruitKind = 'standard' | 'wizard' | 'hexer' | 'beast';

const combatMinions: Record<MinionKind, Omit<Minion, 'id' | 'xp'>> = {
  archer: { kind: 'archer', role: 'combat', name: 'Boogschutter', icon: '🏹', rarity: 'Standaard', level: 1, hp: 64, currentHp: 64, attack: 22, defense: 5, speed: 12, hunger: 1 },
  knight: { kind: 'knight', role: 'combat', name: 'Ridder', icon: '🛡', rarity: 'Standaard', level: 1, hp: 92, currentHp: 92, attack: 15, defense: 13, speed: 6, hunger: 1.2 },
  soldier: { kind: 'soldier', role: 'combat', name: 'Soldaat', icon: '⚔', rarity: 'Standaard', level: 1, hp: 76, currentHp: 76, attack: 18, defense: 8, speed: 9, hunger: 1 },
  wizard: { kind: 'wizard', role: 'combat', name: 'Wizard', icon: '✦', rarity: 'Support', level: 1, hp: 58, currentHp: 58, attack: 12, defense: 4, speed: 9, hunger: 1.1 },
  hexer: { kind: 'hexer', role: 'combat', name: 'Hexer', icon: '◌', rarity: 'Debuff', level: 1, hp: 62, currentHp: 62, attack: 13, defense: 5, speed: 10, hunger: 1.1 },
  beast: { kind: 'beast', role: 'combat', name: 'Beast', icon: '◆', rarity: 'Elite', level: 1, hp: 126, currentHp: 126, attack: 26, defense: 10, speed: 8, hunger: 1.8 },
  farmer: { kind: 'farmer', role: 'worker', name: 'Boer', icon: '♧', rarity: 'Worker', level: 1, hp: 40, currentHp: 40, attack: 2, defense: 2, speed: 4, hunger: 0 },
  trainer: { kind: 'trainer', role: 'worker', name: 'Begeleider', icon: '◇', rarity: 'Worker', level: 1, hp: 45, currentHp: 45, attack: 3, defense: 3, speed: 4, hunger: 0 }
};
const standardKinds: MinionKind[] = ['archer', 'knight', 'soldier'];

const nowId = () => `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
const makeMinion = (kind: MinionKind, id = `m-${nowId()}`): Minion => ({ ...combatMinions[kind], id, xp: 0 });
const ownedCombatIds = (game: GameState) => new Set([...game.squad, ...game.checkpoints.flatMap(cp => cp.owner === 'player' ? [...cp.defenders, ...cp.waitingMinions] : []), ...game.camps.flatMap(c => c.training.map(t => t.minionId))].filter(Boolean) as string[]);

export const minionPower = (m: Minion) => {
  const levelBonus = 1 + (Math.max(1, m.level) - 1) * 0.12;
  return Math.round((m.hp / 5 + m.attack * 2 + m.defense * 1.5 + m.speed) * levelBonus);
};
export const playerLevel = (xp: number) => 1 + Math.floor(Math.sqrt(xp / 100));
export const xpForNext = (level: number) => level * level * 100;
export const checkpointCapacity = (level: number) => CONFIG.checkpointLevels[Math.max(0, Math.min(level - 1, 4))].slots;
export const recruitsRemaining = (_cp: Checkpoint) => Infinity;
export const recruitPreview = (cp: Checkpoint) => summonOptions(cp)[0].template;
export const summonOptions = (cp: Checkpoint): { kind: RecruitKind; label: string; cost: number; unlockLevel: number; template: Omit<Minion, 'id' | 'xp'> }[] => ([
  { kind: 'standard', label: 'Standaard', cost: CONFIG.summonCosts.standard, unlockLevel: 1, template: combatMinions.archer },
  { kind: 'wizard', label: 'Wizard', cost: CONFIG.summonCosts.wizard, unlockLevel: 2, template: combatMinions.wizard },
  { kind: 'hexer', label: 'Hexer', cost: CONFIG.summonCosts.hexer, unlockLevel: 4, template: combatMinions.hexer },
  { kind: 'beast', label: 'Beast', cost: CONFIG.summonCosts.beast, unlockLevel: 5, template: combatMinions.beast }
] as { kind: RecruitKind; label: string; cost: number; unlockLevel: number; template: Omit<Minion, 'id' | 'xp'> }[]).filter(option => cp.level >= option.unlockLevel);
export const unassignedMinions = (game: GameState) => {
  const assigned = new Set([...ownedCombatIds(game), ...game.camps.flatMap(c => c.workers)]);
  return game.minions.filter(m => !assigned.has(m.id));
};

function note(game: GameState, message: string) { game.events = [message, ...game.events].slice(0, 8); }
function createCell(x: number, y: number, ownerId: Owner = null, discovered = false): Cell {
  return { id: cellId(x, y), x, y, ownerId, ownerColor: ownerId ? COLORS[ownerId] : null, discovered };
}
function paintCluster(cells: Record<string, Cell>, position: Position, owner: 'ember' | 'violet', radius: number) {
  const center = cellAt(position);
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (dx * dx + dy * dy > radius * radius + 1) continue;
    const x = center.x + dx, y = center.y + dy;
    cells[cellId(x, y)] = createCell(x, y, owner);
  }
}
function makeCheckpoint(id: string, name: string, position: Position, owner: Owner, defenders: (string | null)[]): Checkpoint {
  const { x, y } = cellAt(position);
  return { id, name, position, cellId: cellId(x, y), owner, level: 1, hp: CONFIG.checkpointLevels[0].hp, xp: 0, defenders: [...defenders, ...Array(10).fill(null)].slice(0, 10), waitingMinions: [], breached: false, recruitsUsed: 0 };
}

export function newGame(): GameState {
  const position = CONFIG.start, timestamp = Date.now();
  const cells: Record<string, Cell> = {};
  const ember = offsetCells(position, 7, 2), violet = offsetCells(position, -8, -4);
  paintCluster(cells, ember, 'ember', 4);
  paintCluster(cells, violet, 'violet', 3);
  const checkpoints = [
    makeCheckpoint('north-gate', 'North Gate', offsetCells(position, 3, 4), null, []),
    makeCheckpoint('ember-post', 'Ember Outpost', ember, 'ember', ['e-warrior', 'e-tank', 'e-archer']),
    makeCheckpoint('violet-keep', 'Violet Keep', violet, 'violet', ['v-beast', 'v-scout', 'v-archer']),
    makeCheckpoint('canal-watch', 'Canal Watch', offsetCells(position, -3, 6), null, [])
  ];
  for (const cp of checkpoints) {
    const c = cellAt(cp.position);
    cells[cp.cellId] ??= createCell(c.x, c.y, cp.owner);
    cells[cp.cellId].checkpointId = cp.id;
  }
  const minions = [makeMinion('archer', 'm-1'), makeMinion('knight', 'm-2'), makeMinion('soldier', 'm-3'), makeMinion('archer', 'm-4'), makeMinion('soldier', 'm-5')];
  const game: GameState = { player: { username: 'Explorer', xp: 0, tokens: 140, distance: 0, lastMinionAt: timestamp, lastSeenAt: timestamp }, position, mode: 'simulation', cells, minions, squad: minions.map(m => m.id).concat(Array(5).fill(null)), checkpoints, camps: [], events: ['Je start met 5 minions. Elke 20 minuten komt er 1 bij, tot 10.'] };
  installKuurne(game);
  const started = movePlayer(game, position, 'simulation');
  // Revealing the immediate spawn area is presentation, not earned progress.
  started.player.xp = 0;
  started.player.tokens = 140;
  started.player.distance = 0;
  return started;
}

function installKuurne(game: GameState) {
  if (game.checkpoints.some(cp => cp.id === 'kuurne-markt')) return;
  // Translate discovered cells and camps together when upgrading the Brussels save.
  const oldOrigin = cellAt({ lat: 50.8466, lng: 4.3528 });
  const newOrigin = cellAt(CONFIG.start);
  const legacy = game.checkpoints.some(cp => cp.position.lng > 4);
  if (legacy) {
    const dx = newOrigin.x - oldOrigin.x, dy = newOrigin.y - oldOrigin.y;
    game.cells = Object.fromEntries(Object.values(game.cells).map(cell => {
      const x = cell.x + dx, y = cell.y + dy, id = cellId(x, y);
      return [id, { ...cell, x, y, id, checkpointId: undefined }];
    }));
    for (const camp of game.camps) {
      camp.position = offsetCells(camp.position, dx, dy);
      const c = cellAt(camp.position);
      camp.cellId = cellId(c.x, c.y);
    }
  }
  for (const [id, name, lat, lng] of KUURNE_CHECKPOINTS) {
    const position = { lat, lng }, c = cellAt(position);
    const existing = game.checkpoints.find(cp => cp.id === id);
    if (existing) Object.assign(existing, { name, position, cellId: cellId(c.x, c.y) });
    else game.checkpoints.push(makeCheckpoint(id, name, position, null, []));
    const key = cellId(c.x, c.y);
    game.cells[key] ??= createCell(c.x, c.y);
    game.cells[key].checkpointId = id;
  }
  game.position = { ...CONFIG.start };
  game.mode = 'simulation';
  note(game, 'Welkom in Kuurne · checkpoints verspreid over de gemeente.');
}

function normalizeMinion(m: Minion): Minion {
  const fallbackKind = m.name?.toLowerCase().includes('arch') || m.name?.toLowerCase().includes('boog') ? 'archer' : m.name?.toLowerCase().includes('tank') || m.name?.toLowerCase().includes('ridder') ? 'knight' : m.name?.toLowerCase().includes('beast') ? 'beast' : 'soldier';
  const legacyName = ['warrior', 'tank', 'archer', 'scout'].includes((m.name ?? '').toLowerCase());
  const migrated = !m.kind || legacyName, base = combatMinions[m.kind ?? fallbackKind];
  return { ...(migrated ? base : m), id: m.id, kind: m.kind ?? fallbackKind, role: m.role ?? 'combat', hunger: m.hunger ?? base.hunger, currentHp: Math.min(migrated ? base.hp : m.hp ?? base.hp, m.currentHp ?? (migrated ? base.hp : m.hp ?? base.hp)), level: Math.max(1, Math.min(3, m.level || 1)), xp: m.xp ?? 0 };
}

// Give every saved minion exactly one place. Overflow from older saves waits at a checkpoint.
export function normalizeGame(previous: GameState, now = Date.now()): GameState {
  const game = structuredClone(previous), valid = new Set(game.minions.map(m => m.id)), used = new Set<string>();
  // Remove the short-lived fixed West Flanders prototype from saved games.
  game.checkpoints = game.checkpoints.filter(cp => !cp.id.startsWith('wf-'));
  game.position = clampWorldPosition(game.position);
  game.player.lastMinionAt ??= now;
  game.player.lastSeenAt ??= now;
  game.camps ??= [];
  installKuurne(game);
  game.minions = game.minions.map(normalizeMinion);
  for (const camp of game.camps) {
    camp.workers ??= [];
    camp.training ??= [];
    camp.workers = camp.workers.filter(id => valid.has(id) && !used.has(id) && !!used.add(id));
  }
  for (const cp of game.checkpoints) {
    cp.level = Math.max(1, Math.min(CONFIG.checkpointLevels.length, cp.level));
    cp.recruitsUsed = Math.max(0, cp.recruitsUsed ?? 0);
    cp.defenders = [...cp.defenders, ...Array(10).fill(null)].slice(0, 10);
    cp.waitingMinions ??= [];
    if (cp.owner !== 'player') continue;
    cp.defenders = cp.defenders.map((id, slot) => {
      if (!id || slot >= checkpointCapacity(cp.level) || !valid.has(id) || used.has(id)) return null;
      used.add(id); return id;
    });
  }
  game.squad = [...game.squad, ...Array(10).fill(null)].slice(0, 10).map(id => {
    if (!id || !valid.has(id) || used.has(id)) return null;
    used.add(id); return id;
  });
  for (const cp of game.checkpoints) cp.waitingMinions = cp.waitingMinions.filter(id => {
    if (!valid.has(id) || used.has(id)) return false;
    used.add(id); return true;
  });
  for (const camp of game.camps) camp.training = camp.training.filter(job => {
    if (!valid.has(job.minionId) || used.has(job.minionId)) return false;
    used.add(job.minionId); return true;
  });
  for (const minion of game.minions) {
    if (used.has(minion.id)) continue;
    if (minion.role === 'worker') {
      const camp = game.camps[0];
      if (camp) camp.workers.push(minion.id);
    } else {
      const slot = game.squad.indexOf(null);
      if (slot >= 0) game.squad[slot] = minion.id;
      else {
        const tower = game.checkpoints.find(cp => cp.owner === 'player' && cp.defenders.slice(0, checkpointCapacity(cp.level)).includes(null));
        if (tower) tower.defenders[tower.defenders.indexOf(null)] = minion.id;
        else (game.checkpoints.find(cp => cp.owner === 'player') ?? game.checkpoints[0])?.waitingMinions.push(minion.id);
      }
    }
    used.add(minion.id);
  }
  rebuildTerritory(game);
  return advanceTime(game, now, true);
}

export function advanceTime(previous: GameState, now = Date.now(), offline = false): GameState {
  const game = structuredClone(previous);
  game.player.lastMinionAt ??= now;
  game.player.lastSeenAt ??= now;
  const intervalMs = CONFIG.freeMinionMinutes * 60 * 1000;
  let grants = Math.floor(Math.max(0, now - game.player.lastMinionAt) / intervalMs);
  const cap = offline ? CONFIG.offlineFreeMinionCap : 10;
  while (grants > 0 && game.squad.filter(Boolean).length < cap) {
    const slot = game.squad.indexOf(null);
    if (slot < 0) break;
    const kind = standardKinds[game.minions.length % standardKinds.length];
    const minion = makeMinion(kind);
    game.minions.push(minion); game.squad[slot] = minion.id; grants--;
    game.player.lastMinionAt += intervalMs;
    note(game, `${minion.name} joined your squad for free.`);
  }
  if (grants > 0) game.player.lastMinionAt = now;
  for (const camp of game.camps.filter(c => c.type === 'training')) {
    for (const job of camp.training) {
      if (job.completed || job.endsAt > now) continue;
      const minion = game.minions.find(m => m.id === job.minionId);
      if (minion && minion.level < 3) {
        minion.level++;
        minion.hp = Math.round(minion.hp * 1.08);
        minion.currentHp = minion.hp;
        minion.attack = Math.round(minion.attack * 1.08);
        minion.defense = Math.round(minion.defense * 1.06);
        note(game, `${minion.name} finished training · level ${minion.level}.`);
      }
      job.completed = true;
    }
  }
  applyFood(game, Math.max(0, now - game.player.lastSeenAt));
  game.player.lastSeenAt = now;
  return game;
}

function applyFood(game: GameState, elapsedMs: number) {
  if (elapsedMs <= 0) return;
  const farmers = game.camps.filter(c => c.type === 'farm').reduce((sum, camp) => sum + camp.workers.length, 0);
  const capacity = farmers * CONFIG.foodPerFarmer;
  const defenders = game.checkpoints.filter(cp => cp.owner === 'player').flatMap(cp => cp.defenders.slice(0, checkpointCapacity(cp.level)).filter(Boolean) as string[]);
  const towerMinions = defenders.length;
  if (towerMinions <= capacity) return;
  const damage = Math.max(1, Math.floor((elapsedMs / (CONFIG.starvationGraceHours * 60 * 60 * 1000)) * 100));
  for (const id of defenders) {
    const minion = game.minions.find(m => m.id === id);
    if (!minion) continue;
    minion.currentHp = Math.max(1, (minion.currentHp ?? minion.hp) - damage);
  }
  if (damage > 0) note(game, `Voedingstekort in de torens: ${towerMinions}/${capacity} minions gevoed.`);
}

export function movePlayer(previous: GameState, position: Position, mode: 'simulation' | 'gps' = previous.mode): GameState {
  const game = advanceTime(previous, Date.now(), false);
  const boundedPosition = clampWorldPosition(position);
  const distance = distanceMeters(game.position, boundedPosition);
  game.position = boundedPosition;
  game.mode = mode;
  if (distance > 2 && distance < 1000) game.player.distance += distance;
  const center = cellAt(boundedPosition);
  let discovered = 0;
  for (let dy = -CONFIG.revealCells; dy <= CONFIG.revealCells; dy++) for (let dx = -CONFIG.revealCells; dx <= CONFIG.revealCells; dx++) {
    if (dx * dx + dy * dy > CONFIG.revealCells ** 2 + 1) continue;
    const x = center.x + dx, y = center.y + dy, id = cellId(x, y);
    const cell = game.cells[id] ?? createCell(x, y);
    if (!cell.discovered) { cell.discovered = true; discovered++; }
    game.cells[id] = cell;
  }
  game.player.xp += discovered * CONFIG.rewards.discoverXp;
  game.player.tokens += discovered * CONFIG.rewards.discoverTokens;
  if (discovered) note(game, `Revealed ${discovered} cells. Checkpoints determine territory.`);
  return game;
}

export function setSquad(previous: GameState, slot: number, id: string | null): GameState {
  const game = structuredClone(previous);
  if (slot < 0 || slot >= 10 || !id || !game.minions.some(m => m.id === id && m.role !== 'worker')) return previous;
  if (game.checkpoints.some(cp => cp.owner === 'player' && cp.defenders.includes(id)) || game.camps.some(c => c.training.some(t => t.minionId === id))) return previous;
  const existing = game.squad.indexOf(id);
  if (existing >= 0) game.squad[existing] = game.squad[slot];
  else {
    const cp = game.checkpoints.find(c => c.waitingMinions.includes(id));
    if (!cp || game.squad[slot] || distanceMeters(game.position, cp.position) > CONFIG.interactionMeters) return previous;
    cp.waitingMinions.splice(cp.waitingMinions.indexOf(id), 1);
  }
  game.squad[slot] = id;
  return game;
}

export function claimCheckpoint(previous: GameState, id: string): GameState {
  const game = structuredClone(previous), cp = game.checkpoints.find(c => c.id === id);
  if (!cp || cp.owner || distanceMeters(game.position, cp.position) > CONFIG.claimMeters) return previous;
  cp.owner = 'player'; cp.hp = CONFIG.checkpointLevels[cp.level - 1].hp;
  const claimed = rebuildTerritory(game);
  game.player.xp += CONFIG.rewards.checkpointXp + claimed * CONFIG.rewards.claimXp;
  game.player.tokens += CONFIG.rewards.checkpointTokens + claimed * CONFIG.rewards.claimTokens;
  note(game, `${cp.name} claimed · ${claimed} territory cells secured`);
  return game;
}

export function captureCheckpoint(previous: GameState, id: string): GameState {
  const game = structuredClone(previous), cp = game.checkpoints.find(c => c.id === id);
  if (!cp || !cp.owner || cp.owner === 'player') return previous;
  cp.owner = 'player'; cp.breached = true; cp.defenders = Array(10).fill(null); cp.hp = CONFIG.checkpointLevels[cp.level - 1].hp;
  const claimed = rebuildTerritory(game);
  game.player.xp += CONFIG.rewards.battleXp + claimed * CONFIG.rewards.claimXp;
  game.player.tokens += Math.round(CONFIG.rewards.battleTokens * CONFIG.checkpointLevels[cp.level - 1].rewardBonus) + claimed * CONFIG.rewards.claimTokens;
  note(game, `${cp.name} conquered · ${claimed} territory cells secured`);
  return game;
}

export function upgradeCheckpoint(previous: GameState, id: string): GameState {
  const game = structuredClone(previous), cp = game.checkpoints.find(c => c.id === id);
  if (!cp || cp.owner !== 'player' || cp.level >= CONFIG.checkpointLevels.length) return previous;
  const cost = CONFIG.checkpointLevels[cp.level].cost;
  if (game.player.tokens < cost) return previous;
  game.player.tokens -= cost; cp.level++; cp.hp = CONFIG.checkpointLevels[cp.level - 1].hp; cp.xp += 25;
  note(game, `${cp.name} upgraded to level ${cp.level}`);
  return game;
}

export function stationMinion(previous: GameState, cpId: string, id: string): GameState {
  const game = structuredClone(previous), cp = game.checkpoints.find(c => c.id === cpId), minion = game.minions.find(m => m.id === id);
  if (!cp || !minion || minion.role === 'worker' || cp.owner !== 'player' || distanceMeters(game.position, cp.position) > CONFIG.interactionMeters) return previous;
  const squadSlot = game.squad.indexOf(id), freeSlot = cp.defenders.slice(0, checkpointCapacity(cp.level)).indexOf(null);
  const waitingSlot = cp.waitingMinions.indexOf(id);
  if (freeSlot < 0 || (squadSlot < 0 && waitingSlot < 0)) return previous;
  if (squadSlot >= 0) game.squad[squadSlot] = null;
  else cp.waitingMinions.splice(waitingSlot, 1);
  cp.defenders[freeSlot] = id;
  note(game, `${minion.name} stays at ${cp.name}`);
  return game;
}

export function recallMinion(previous: GameState, cpId: string, slot: number, playerSlot: number): GameState {
  const game = structuredClone(previous), cp = game.checkpoints.find(c => c.id === cpId);
  if (!cp || cp.owner !== 'player' || slot < 0 || slot >= checkpointCapacity(cp.level) || !cp.defenders[slot] || playerSlot < 0 || playerSlot >= 10 || game.squad[playerSlot]) return previous;
  const name = game.minions.find(m => m.id === cp.defenders[slot])?.name ?? 'Minion';
  game.squad[playerSlot] = cp.defenders[slot];
  cp.defenders[slot] = null;
  note(game, `${name} returned to player slot ${playerSlot + 1} from ${cp.name}`);
  return game;
}

export function recruitMinion(previous: GameState, checkpointId: string, destination: number | 'tower', kind: RecruitKind = 'standard'): GameState {
  const cp = previous.checkpoints.find(c => c.id === checkpointId), option = cp ? summonOptions(cp).find(o => o.kind === kind) : null;
  if (!cp || !option || cp.owner !== 'player' || distanceMeters(previous.position, cp.position) > CONFIG.claimMeters || previous.player.tokens < option.cost) return previous;
  const towerSlot = cp.defenders.slice(0, checkpointCapacity(cp.level)).indexOf(null);
  if (destination === 'tower' ? towerSlot < 0 : !Number.isInteger(destination) || destination < 0 || destination >= 10 || !!previous.squad[destination]) return previous;
  const game = structuredClone(previous), station = game.checkpoints.find(c => c.id === checkpointId)!;
  game.player.tokens -= option.cost;
  station.recruitsUsed++;
  const summonKind = kind === 'standard' ? standardKinds[Math.floor(Math.random() * standardKinds.length)] : kind;
  const minion = makeMinion(summonKind);
  game.minions.push(minion);
  if (destination === 'tower') station.defenders[towerSlot] = minion.id;
  else game.squad[destination] = minion.id;
  note(game, `${minion.name} summoned at ${station.name} · ${destination === 'tower' ? 'in tower' : `player slot ${destination + 1}`}`);
  return game;
}

export function canBuildCamp(game: GameState) {
  const c = cellAt(game.position), cell = game.cells[cellId(c.x, c.y)];
  return cell?.ownerId === 'player';
}
export function buildCamp(previous: GameState, type: CampType): GameState {
  if (!canBuildCamp(previous)) return previous;
  const cost = type === 'farm' ? CONFIG.farmCost : CONFIG.trainingCampCost;
  if (previous.player.tokens < cost) return previous;
  const game = structuredClone(previous), c = cellAt(game.position), id = cellId(c.x, c.y);
  if (game.camps.some(camp => camp.cellId === id && camp.type === type)) return previous;
  game.player.tokens -= cost;
  const worker = makeMinion(type === 'farm' ? 'farmer' : 'trainer');
  game.minions.push(worker);
  const camp: Camp = { id: `${type}-${nowId()}`, type, name: type === 'farm' ? 'Boerderij' : 'Trainingkamp', cellId: id, position: game.position, workers: [worker.id], training: [] };
  game.camps.push(camp);
  note(game, `${camp.name} gebouwd · ${worker.name} start hier.`);
  return game;
}
export function buyCampWorker(previous: GameState, campId: string): GameState {
  const game = structuredClone(previous), camp = game.camps.find(c => c.id === campId);
  if (!camp || camp.workers.length >= 2) return previous;
  const cost = camp.type === 'farm' ? CONFIG.farmerCost : CONFIG.trainerCost;
  if (game.player.tokens < cost) return previous;
  game.player.tokens -= cost;
  const worker = makeMinion(camp.type === 'farm' ? 'farmer' : 'trainer');
  game.minions.push(worker); camp.workers.push(worker.id);
  note(game, `${worker.name} toegevoegd aan ${camp.name}.`);
  return game;
}
export function startTraining(previous: GameState, campId: string, minionId: string, now = Date.now()): GameState {
  const game = structuredClone(previous), camp = game.camps.find(c => c.id === campId), minion = game.minions.find(m => m.id === minionId);
  if (!camp || camp.type !== 'training' || !minion || minion.role === 'worker' || minion.level >= 3 || camp.training.some(t => t.minionId === minionId)) return previous;
  if (camp.training.filter(t => !t.completed).length >= camp.workers.length * 2) return previous;
  const squadSlot = game.squad.indexOf(minionId);
  if (squadSlot < 0) return previous;
  game.squad[squadSlot] = null;
  camp.training.push({ minionId, startedAt: now, endsAt: now + CONFIG.trainingMinutes * 60 * 1000 });
  note(game, `${minion.name} started training in ${camp.name}.`);
  return game;
}
export function campStats(game: GameState) {
  const farmers = game.camps.filter(c => c.type === 'farm').reduce((sum, camp) => sum + camp.workers.length, 0);
  const foodCapacity = farmers * CONFIG.foodPerFarmer;
  const towerHunger = game.checkpoints
    .filter(cp => cp.owner === 'player')
    .flatMap(cp => cp.defenders.slice(0, checkpointCapacity(cp.level)).filter(Boolean))
    .length;
  const trainers = game.camps.filter(c => c.type === 'training').reduce((sum, camp) => sum + camp.workers.length, 0);
  const trainingCapacity = trainers * 2;
  const activeTraining = game.camps.reduce((sum, camp) => sum + camp.training.filter(t => !t.completed).length, 0);
  return { farmers, foodCapacity, towerHunger, foodShortage: Math.max(0, towerHunger - foodCapacity), trainers, trainingCapacity, activeTraining };
}
