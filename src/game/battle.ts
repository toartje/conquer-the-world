import { CONFIG } from '../config';
import type { BattleLine, BattleResult, Checkpoint, GameState, Minion } from './types';

const enemyMinions: Record<string, Minion> = {
  'e-warrior': { id: 'e-warrior', kind: 'soldier', role: 'combat', name: 'Ember Warrior', icon: '⚔', rarity: 'Common', level: 1, hp: 65, currentHp: 65, attack: 15, defense: 6, speed: 7, hunger: 1, xp: 0 },
  'e-tank': { id: 'e-tank', kind: 'knight', role: 'combat', name: 'Ember Guard', icon: '🛡', rarity: 'Common', level: 1, hp: 82, currentHp: 82, attack: 10, defense: 10, speed: 4, hunger: 1.2, xp: 0 },
  'e-archer': { id: 'e-archer', kind: 'archer', role: 'combat', name: 'Ember Archer', icon: '🏹', rarity: 'Common', level: 1, hp: 55, currentHp: 55, attack: 15, defense: 4, speed: 9, hunger: 1, xp: 0 },
  'v-beast': { id: 'v-beast', kind: 'beast', role: 'combat', name: 'Violet Beast', icon: '◆', rarity: 'Rare', level: 2, hp: 94, currentHp: 94, attack: 17, defense: 8, speed: 8, hunger: 1.8, xp: 0 },
  'v-scout': { id: 'v-scout', kind: 'soldier', role: 'combat', name: 'Violet Scout', icon: '✦', rarity: 'Common', level: 2, hp: 62, currentHp: 62, attack: 14, defense: 5, speed: 12, hunger: 1, xp: 0 },
  'v-archer': { id: 'v-archer', kind: 'archer', role: 'combat', name: 'Violet Archer', icon: '🏹', rarity: 'Common', level: 2, hp: 61, currentHp: 61, attack: 17, defense: 4, speed: 10, hunger: 1, xp: 0 }
};
type Fighter = { unit: Minion; hp: number };
export function simulateBattle(game: GameState, cp: Checkpoint): BattleResult {
  const attackers: Fighter[] = game.squad.map(id => game.minions.find(m => m.id === id)).filter((m): m is Minion => !!m).slice(0, 10).map(unit => ({ unit, hp: unit.currentHp ?? unit.hp }));
  const defenders: Fighter[] = cp.defenders.map(id => id ? enemyMinions[id] : undefined).filter((m): m is Minion => !!m).slice(0, 10).map(unit => ({ unit, hp: unit.hp }));
  const lines: BattleLine[] = [{ text: `${attackers.length} attackers vs ${defenders.length} defenders`, side: 'system' }];
  if (!attackers.length) return { victory: false, lines: [...lines, { text: 'Your squad is empty.', side: 'system' }], survivors: 0, enemySurvivors: defenders.length };
  const level = CONFIG.checkpointLevels[cp.level - 1];
  let round = 0;
  while (attackers.some(f => f.hp > 0) && defenders.some(f => f.hp > 0) && round < 35) {
    round++;
    const turns = [...attackers.map(f => ({ fighter: f, side: 'player' as const })), ...defenders.map(f => ({ fighter: f, side: 'enemy' as const }))].filter(t => t.fighter.hp > 0).sort((a, b) => b.fighter.unit.speed - a.fighter.unit.speed);
    for (const turn of turns) {
      if (turn.fighter.hp <= 0) continue;
      const targets = (turn.side === 'player' ? defenders : attackers).filter(f => f.hp > 0);
      if (!targets.length) break;
      const target = targets[Math.floor(Math.random() * targets.length)];
      const allies = turn.side === 'player' ? attackers : defenders;
      const wizardBuff = allies.some(f => f.hp > 0 && f.unit.kind === 'wizard') ? 2 : 0;
      const hexPenalty = (turn.side === 'player' ? defenders : attackers).some(f => f.hp > 0 && f.unit.kind === 'hexer') ? 2 : 0;
      const bonus = (turn.side === 'enemy' ? level.minionBonus : 0) + wizardBuff - hexPenalty;
      const armor = target.unit.defense + (turn.side === 'player' ? level.defense : 0);
      const damage = Math.max(3, Math.round(turn.fighter.unit.attack + bonus - armor * .48 + Math.random() * 5));
      target.hp = Math.max(0, target.hp - damage);
      lines.push({ text: `R${round} · ${turn.fighter.unit.name} hits ${target.unit.name} for ${damage}${target.hp === 0 ? ' · KO' : ''}`, side: turn.side });
    }
  }
  const survivors = attackers.filter(f => f.hp > 0).length, enemySurvivors = defenders.filter(f => f.hp > 0).length;
  const victory = survivors > 0 && enemySurvivors === 0;
  lines.push({ text: victory ? `Victory · ${survivors} minions survived` : `Defeat · ${enemySurvivors} defenders remain`, side: 'system' });
  return { victory, lines, survivors, enemySurvivors };
}
