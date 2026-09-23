import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { CONFIG } from '../config';
import { GameMap } from '../components/GameMap';
import { SquadDock } from '../components/SquadDock';
import { simulateBattle } from '../game/battle';
import { advanceTime, buildCamp, buyCampWorker, campStats, captureCheckpoint, checkpointCapacity, claimCheckpoint, minionPower, movePlayer, newGame, normalizeGame, playerLevel, recallMinion, recruitMinion, recruitPreview, setSquad, startTraining, stationMinion, summonOptions, upgradeCheckpoint, xpForNext, canBuildCamp } from '../game/engine';
import { distanceMeters, offsetCells } from '../game/geo';
import { gameStorage } from '../game/storage';
import type { BattleResult, Camp, Checkpoint, GameState, Minion, Position } from '../game/types';

type Tab = 'MAP' | 'SQUAD' | 'MINIONS' | 'TERRITORY' | 'PROFILE';
type BattleView = { cpId: string; result: BattleResult; visible: number; settled: boolean; xpGained: number; tokensGained: number; territoryGained: number };
const tabs: { label: Tab; icon: string }[] = [{ label: 'MAP', icon: '◎' }, { label: 'SQUAD', icon: '✥' }, { label: 'MINIONS', icon: '✦' }, { label: 'TERRITORY', icon: '▦' }, { label: 'PROFILE', icon: '◉' }];

export function App() {
  const [game, setGame] = useState<GameState>(() => normalizeGame(gameStorage.load() ?? newGame()));
  const [tab, setTab] = useState<Tab>('MAP');
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
  const [selectedMinion, setSelectedMinion] = useState<string | null>(null);
  const [recruitTarget, setRecruitTarget] = useState('');
  const [boss, setBoss] = useState(false);
  const [battle, setBattle] = useState<BattleView | null>(null);
  const [toast, setToast] = useState('');
  const watch = useRef<number | null>(null), gpsLast = useRef<{ p: Position; time: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3300);
  }, []);
  useEffect(() => { gameStorage.save(game); }, [game]);
  useEffect(() => {
    const timer = window.setInterval(() => setGame(g => advanceTime(g)), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const move = useCallback((p: Position) => setGame(g => movePlayer(g, p, 'simulation')), []);
  const mergeWorldCheckpoints = useCallback((incoming: Checkpoint[]) => setGame(game => {
    const incomingIds = new Set(incoming.map(cp => cp.id));
    const incomingById = new Map(incoming.map(cp => [cp.id, cp]));
    const current = new Set(game.checkpoints.map(cp => cp.id));
    const checkpoints = game.checkpoints
      .filter(cp => !cp.id.startsWith('pop-') || cp.owner === 'player' || incomingIds.has(cp.id))
      .map(cp => cp.id.startsWith('pop-') && cp.owner === null ? (incomingById.get(cp.id) ?? cp) : cp);
    for (const checkpoint of incoming) if (!current.has(checkpoint.id)) checkpoints.push(checkpoint);
    if (checkpoints.length === game.checkpoints.length && checkpoints.every((cp, index) => cp === game.checkpoints[index])) return game;
    return { ...game, checkpoints };
  }), []);
  const step = useCallback((dx: number, dy: number) => setGame(g => movePlayer(g, offsetCells(g.position, dx * CONFIG.simulationStepCells, dy * CONFIG.simulationStepCells), 'simulation')), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,select,textarea')) return;
      const direction: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, 1], s: [0, -1], a: [-1, 0], d: [1, 0] };
      if (game.mode === 'simulation' && direction[e.key]) { e.preventDefault(); step(...direction[e.key]); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [game.mode, step]);

  const startGps = () => {
    if (!navigator.geolocation) { showToast('GPS is unavailable in this browser.'); return; }
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = navigator.geolocation.watchPosition(pos => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude }, now = Date.now(), last = gpsLast.current;
      if (last && distanceMeters(last.p, p) / Math.max(1, (now - last.time) / 1000) > CONFIG.maxGpsMetersPerSecond) return;
      gpsLast.current = { p, time: now }; setGame(g => movePlayer(g, p, 'gps'));
    }, () => showToast('Location permission is needed for GPS mode.'), { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    showToast('GPS tracking started. Walk to explore.');
  };
  const startSimulation = () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null; gpsLast.current = null;
    setGame(g => ({ ...g, mode: 'simulation' }));
    showToast('Simulation mode: use arrows or tap the map.');
  };

  const checkpoint = game.checkpoints.find(c => c.id === selectedCheckpoint) ?? null;
  const selectCheckpoint = useCallback((id: string) => { setSelectedCheckpoint(id); setRecruitTarget(''); setTab('MAP'); setBoss(false); }, []);
  const openBoss = useCallback(() => { setBoss(true); setSelectedCheckpoint(null); setTab('MAP'); }, []);
  const activeMinions = game.squad.map(id => game.minions.find(m => m.id === id)).filter((m): m is Minion => !!m);
  const owned = Object.values(game.cells).filter(c => c.ownerId === 'player').length;
  const discovered = Object.values(game.cells).filter(c => c.discovered).length;
  const level = playerLevel(game.player.xp);
  const nearby = checkpoint ? distanceMeters(game.position, checkpoint.position) : Infinity;

  const assignToSquad = useCallback((slot: number, id: string) => {
    setGame(g => setSquad(g, slot, id)); setSelectedMinion(null);
  }, []);
  const slotClick = (slot: number) => {
    if (selectedMinion) { assignToSquad(slot, selectedMinion); return; }
    const m = game.minions.find(v => v.id === game.squad[slot]);
    if (m) { setSelectedMinion(m.id); showToast(`Tik op een ander vakje om ${m.name} te verplaatsen.`); }
    else showToast('Leeg vakje. Rekruteer bij een checkpoint.');
  };

  // Pointer dragging works for mouse and touch. The buttons also offer a tap path.
  const beginTouchDrag = (id: string, event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    const ghost = document.createElement('div');
    ghost.className = 'minion-drag-ghost';
    ghost.textContent = game.minions.find(m => m.id === id)?.icon ?? '✦';
    document.body.appendChild(ghost);
    const moveGhost = (x: number, y: number) => { ghost.style.left = `${x}px`; ghost.style.top = `${y}px`; };
    moveGhost(event.clientX, event.clientY);
    const onMove = (e: globalThis.PointerEvent) => moveGhost(e.clientX, e.clientY);
    const onUp = (e: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      ghost.remove();
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const slot = target?.closest('[data-squad-slot]') as HTMLElement | null;
      const cpDrop = target?.closest('[data-checkpoint-drop]') as HTMLElement | null;
      if (slot) assignToSquad(Number(slot.dataset.squadSlot), id);
      else if (cpDrop) setGame(g => stationMinion(g, cpDrop.dataset.checkpointDrop!, id));
      else setSelectedMinion(id);
    };
    const onCancel = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel); ghost.remove(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const attack = () => {
    if (!checkpoint || checkpoint.owner === 'player' || checkpoint.owner === null || nearby > CONFIG.interactionMeters) return;
    const result = simulateBattle(game, checkpoint);
    const preview = result.victory ? captureCheckpoint(game, checkpoint.id) : game;
    const territoryGained = Object.values(preview.cells).filter(c => c.ownerId === 'player').length - owned;
    setBattle({ cpId: checkpoint.id, result, visible: 1, settled: false, xpGained: preview.player.xp - game.player.xp, tokensGained: preview.player.tokens - game.player.tokens, territoryGained });
    setSelectedCheckpoint(null);
  };
  useEffect(() => {
    if (!battle || battle.visible >= battle.result.lines.length) return;
    const timer = window.setTimeout(() => setBattle(b => b ? { ...b, visible: b.visible + 1 } : null), CONFIG.battleTickMs);
    return () => clearTimeout(timer);
  }, [battle]);
  useEffect(() => {
    if (!battle || battle.visible < battle.result.lines.length || battle.settled) return;
    if (battle.result.victory) setGame(g => captureCheckpoint(g, battle.cpId));
    setBattle(b => b ? { ...b, settled: true } : null);
  }, [battle]);

  return <div className="app-shell">
    <header className="top-bar"><div className="brand-mark">◈</div><div className="brand"><strong>CONQUER</strong><span>THE WORLD</span></div><div className="top-stats"><div><small>LVL</small><b>{level}</b></div><div><small>XP</small><b>{game.player.xp}/{xpForNext(level)}</b></div><div><small>CTW</small><b className="gold">{game.player.tokens}</b></div><div><small>CELLS</small><b>{owned}</b></div></div></header>
    <main className="main-stage">
      <GameMap game={game} onCheckpoint={selectCheckpoint} onMove={move} onBoss={openBoss} onWorldCheckpoints={mergeWorldCheckpoints} />
      {tab === 'MAP' ? <>
        <div className="map-heading"><span className="eyebrow">LIVE WORLD</span><strong>{game.mode === 'simulation' ? 'Explore the city' : 'Walk to discover'}</strong><small>{discovered} cells discovered · {(game.player.distance / 1000).toFixed(2)} km walked</small></div>
        <div className="map-tools"><button className={game.mode === 'simulation' ? 'active' : ''} onClick={startSimulation}>⌁ <span>SIM</span></button><button className={game.mode === 'gps' ? 'active' : ''} onClick={startGps}>◉ <span>GPS</span></button></div>
        {game.mode === 'simulation' && <div className="dpad" aria-label="Simulation movement"><button className="up" aria-label="Move north" onClick={() => step(0, 1)}>▲</button><button className="left" aria-label="Move west" onClick={() => step(-1, 0)}>◀</button><button className="right" aria-label="Move east" onClick={() => step(1, 0)}>▶</button><button className="down" aria-label="Move south" onClick={() => step(0, -1)}>▼</button></div>}
        <div className="map-hint">{game.mode === 'simulation' ? 'Tap map or use arrows to explore' : 'GPS reveals nearby cells as you walk'}</div>
      </> : <div className="screen-panel"><div className="panel-scroll">
        {tab === 'SQUAD' && <SquadScreen game={game} onStation={(cpId, id) => setGame(g => stationMinion(g, cpId, id))} />}
        {tab === 'MINIONS' && <MinionsScreen game={game} onCheckpoint={selectCheckpoint} onSquad={() => setTab('SQUAD')} />}
        {tab === 'TERRITORY' && <><TerritoryScreen game={game} owned={owned} discovered={discovered} onSelect={selectCheckpoint} onUpgrade={id => setGame(g => upgradeCheckpoint(g, id))} onRecall={(id, slot, playerSlot) => setGame(g => recallMinion(g, id, slot, playerSlot))} onBuild={type => setGame(g => buildCamp(g, type))} onWorker={campId => setGame(g => buyCampWorker(g, campId))} onTrain={(campId, minionId) => setGame(g => startTraining(g, campId, minionId))} /><div className="tip"><b>Wanneer wordt gebied groen?</b><p>Wandelen onthult alleen de kaart. Drie veroverde checkpoints kleuren het gebied dat ze omsluiten. Staat er nog een neutraal of vijandig checkpoint binnen dat gebied, dan blijft het ongekleurd.</p></div></>}
        {tab === 'PROFILE' && <ProfileScreen game={game} level={level} onReset={() => { if (confirm('Reset all local progress?')) { gameStorage.clear(); setGame(newGame()); setSelectedMinion(null); setTab('MAP'); } }} />}
      </div></div>}

      {checkpoint && tab === 'MAP' && <div className="sheet-backdrop" onClick={() => setSelectedCheckpoint(null)}><section className="bottom-sheet" onClick={e => e.stopPropagation()}><div className="sheet-handle"/><button className="close" onClick={() => setSelectedCheckpoint(null)}>×</button><span className="eyebrow">CHECKPOINT · {checkpoint.owner ? checkpoint.owner.toUpperCase() : 'NEUTRAL'}</span><h2>{checkpoint.name}</h2><p className="muted">{Math.round(nearby)}m away · {nearby > (checkpoint.owner ? CONFIG.interactionMeters : CONFIG.claimMeters) ? 'Move closer to interact' : 'Within range'}</p><div className="detail-grid"><div><small>LEVEL</small><b>{checkpoint.level}/5</b></div><div><small>HP</small><b>{checkpoint.hp}</b></div><div><small>DEFENSE</small><b>{CONFIG.checkpointLevels[checkpoint.level - 1].defense}</b></div><div><small>MINIONS</small><b>{checkpoint.defenders.filter(Boolean).length}/{checkpointCapacity(checkpoint.level)}</b></div></div>
        {!!checkpoint.waitingMinions.length && <WaitingMinions game={game} cpId={checkpoint.id} near={nearby <= CONFIG.interactionMeters} onSquad={(slot, id) => assignToSquad(slot, id)} onTower={id => setGame(g => stationMinion(g, checkpoint.id, id))} />}
        {checkpoint.owner === 'player' ? <>
          <div className="sheet-actions"><button className="primary" disabled={checkpoint.level >= 5 || game.player.tokens < (CONFIG.checkpointLevels[checkpoint.level]?.cost ?? Infinity)} onClick={() => setGame(g => upgradeCheckpoint(g, checkpoint.id))}>Upgrade {checkpoint.level < 5 ? `· ${CONFIG.checkpointLevels[checkpoint.level].cost} CTW · +1 torenplaats` : '· MAX'}</button></div>
          <SummonPanel checkpoint={checkpoint} game={game} nearby={nearby} target={recruitTarget} onTarget={setRecruitTarget} onSummon={(kind, target) => { setGame(g => recruitMinion(g, checkpoint.id, target, kind)); setRecruitTarget(''); }} />
          <h3>Verdedigers bij dit checkpoint</h3><p className="muted">Laat een minion uit de spelersbalk hier achter. Kies bij terughalen meteen een vrij vakje bij de speler.</p><div className="garrison-drop" data-checkpoint-drop={checkpoint.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) setGame(g => stationMinion(g, checkpoint.id, id)); }}><span>Sleep een minion uit de balk hierheen</span><select aria-label="Laat minion achter bij checkpoint" value="" disabled={nearby > CONFIG.interactionMeters || checkpoint.defenders.filter(Boolean).length >= checkpointCapacity(checkpoint.level) || !activeMinions.length} onChange={e => { const id = e.target.value; setGame(g => stationMinion(g, checkpoint.id, id)); e.currentTarget.value = ''; }}><option value="">Of kies een minion…</option>{activeMinions.map(m => <option key={m.id} value={m.id}>{m.name} · Lv {m.level}</option>)}</select></div><Garrison game={game} cpId={checkpoint.id} onRecall={(slot, playerSlot) => setGame(g => recallMinion(g, checkpoint.id, slot, playerSlot))} /></> : checkpoint.owner === null ? <button className="primary full" disabled={nearby > CONFIG.claimMeters} onClick={() => { setGame(g => claimCheckpoint(g, checkpoint.id)); setSelectedCheckpoint(null); }}>Claim checkpoint · +35 CTW</button> : <><p className="scout-line">Defenders: {checkpoint.defenders.filter(Boolean).length} units · Your squad: {activeMinions.length} units</p><div className="sheet-actions"><button className="primary" disabled={nearby > CONFIG.interactionMeters || activeMinions.length === 0} onClick={attack}>⚔ Attack checkpoint</button><button onClick={() => showToast(`${checkpoint.name}: ${checkpoint.defenders.filter(Boolean).length} defenders, ${checkpoint.hp} HP, defense ${CONFIG.checkpointLevels[checkpoint.level - 1].defense}.`)}>Scout</button></div></>}
      </section></div>}
      {boss && tab === 'MAP' && <div className="sheet-backdrop" onClick={() => setBoss(false)}><section className="bottom-sheet" onClick={e => e.stopPropagation()}><div className="sheet-handle"/><button className="close" onClick={() => setBoss(false)}>×</button><span className="eyebrow">WORLD BOSS · PREVIEW</span><h2>♛ Ancient Titan</h2><p>A future cooperative challenge. Nearby explorers will be able to contribute damage over time.</p><div className="boss-health"><span style={{ width: '83.45%' }}/></div><b>834,500 / 1,000,000 HP</b><p className="muted">37 explorers participating · Combat coming later</p></section></div>}
      {battle && <div className="battle-backdrop"><section className="battle-card"><span className="eyebrow">AUTO BATTLE</span><h2>{battle.settled ? battle.result.victory ? 'VICTORY' : 'DEFEAT' : 'BATTLE IN PROGRESS'}</h2><div className="battle-feed">{battle.result.lines.slice(0, battle.visible).map((line, i) => <div className={`battle-line ${line.side}`} key={i}>{line.text}</div>)}</div>{battle.settled ? <><p>{battle.result.victory ? `Checkpoint conquered · +${battle.xpGained} XP · +${battle.tokensGained} CTW · ${battle.territoryGained} groene vakken` : 'Strengthen your squad and try again.'}</p><button className="primary full" onClick={() => setBattle(null)}>Continue exploring</button></> : <button className="ghost full" onClick={() => setBattle(b => b ? { ...b, visible: b.result.lines.length } : null)}>Skip animation</button>}</section></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
    <SquadDock game={game} selectedId={selectedMinion} onAssign={assignToSquad} onTouchDrag={beginTouchDrag} onSlotClick={slotClick} />
    <nav className="bottom-nav">{tabs.map(t => <button key={t.label} className={tab === t.label ? 'selected' : ''} onClick={() => { setTab(t.label); setSelectedCheckpoint(null); setSelectedMinion(null); setBoss(false); }}><span>{t.icon}</span><small>{t.label}</small></button>)}</nav>
  </div>;
}

function SquadScreen({ game, onStation }: { game: GameState; onStation: (cpId: string, id: string) => void }) {
  const active = game.squad.map(id => game.minions.find(m => m.id === id)).filter((m): m is Minion => !!m);
  const nearbyTowers = game.checkpoints.filter(cp => cp.owner === 'player' && distanceMeters(game.position, cp.position) <= CONFIG.interactionMeters && cp.defenders.slice(0, checkpointCapacity(cp.level)).includes(null));
  return <><span className="eyebrow">BIJ SPELER</span><h1>Squad · {active.length}/10</h1><p className="muted">De tien vakjes zijn je meeneembalk. Gratis minions vullen vrije vakjes elke {CONFIG.freeMinionMinutes} minuten.</p><div className="placement-summary"><b>{active.reduce((sum, m) => sum + minionPower(m), 0)} power</b><span>{10 - active.length} vrije vakjes</span></div><div className="placement-list">{game.squad.map((id, slot) => { const m = game.minions.find(v => v.id === id); return <div className="placement-row" key={slot}><span className="placement-index">{slot + 1}</span><span className="unit-icon">{m?.icon ?? '+'}</span><span className="placement-main"><b>{m?.name ?? 'Leeg vakje'}</b><small>{m ? `Lv ${m.level} · ${minionPower(m)} power · ${Math.round(m.currentHp ?? m.hp)}/${m.hp} HP · honger ${m.hunger}` : 'Vrij voor een nieuwe minion'}</small></span>{m && <select aria-label={`Zet ${m.name} uit vakje ${slot + 1} in toren`} value="" disabled={!nearbyTowers.length} onChange={e => { if (e.target.value) onStation(e.target.value, m.id); }}><option value="">Naar toren…</option>{nearbyTowers.map(cp => <option key={cp.id} value={cp.id}>{cp.name}</option>)}</select>}</div>; })}</div>{!nearbyTowers.length && <p className="muted">Geen eigen toren met vrije plaats binnen {CONFIG.interactionMeters} m.</p>}</>;
}

function SummonPanel({ checkpoint, game, nearby, target, onTarget, onSummon }: { checkpoint: GameState['checkpoints'][number]; game: GameState; nearby: number; target: string; onTarget: (value: string) => void; onSummon: (kind: 'standard' | 'wizard' | 'hexer' | 'beast', destination: number | 'tower') => void }) {
  const freeSquadSlots = game.squad.map((id, slot) => id ? -1 : slot).filter(slot => slot >= 0);
  const towerFree = checkpoint.defenders.slice(0, checkpointCapacity(checkpoint.level)).includes(null);
  const options = summonOptions(checkpoint);
  const targetValid = target === 'tower' ? towerFree : freeSquadSlots.includes(Number(target));
  return <div className="recruit-panel summon-panel"><div><span className="recruit-icon">{recruitPreview(checkpoint).icon}</span><span><b>Summon bij checkpoint</b><small>Kies eerst een bestemming. Niets komt nog los in een collectie.</small></span></div><select aria-label="Kies bestemming voor nieuwe minion" value={target} onChange={e => onTarget(e.target.value)}><option value="">Kies plaats…</option>{freeSquadSlots.map(slot => <option value={slot} key={slot}>Speler · vakje {slot + 1}</option>)}{towerFree && <option value="tower">Toren · vrije plaats</option>}</select><div className="summon-buttons">{options.map(option => <button key={option.kind} className="primary" disabled={nearby > CONFIG.claimMeters || game.player.tokens < option.cost || !target || !targetValid} onClick={() => onSummon(option.kind, target === 'tower' ? 'tower' : Number(target))}>{option.label} · {option.cost} CTW</button>)}</div>{nearby > CONFIG.claimMeters && <p className="muted">Loop dichter naar dit checkpoint om te summonen.</p>}{!target && <p className="muted">Kies een vrij spelersvakje of torenplaats voordat je koopt.</p>}{!towerFree && !freeSquadSlots.length && <p className="muted">Geen plaats vrij bij speler of toren.</p>}</div>;
}

function MinionsScreen({ game, onCheckpoint, onSquad }: { game: GameState; onCheckpoint: (id: string) => void; onSquad: () => void }) {
  const player = game.squad.map((id, slot) => ({ slot, minion: game.minions.find(m => m.id === id) })).filter((entry): entry is { slot: number; minion: Minion } => !!entry.minion);
  const owned = game.checkpoints.filter(cp => cp.owner === 'player');
  const stats = campStats(game);
  return <><span className="eyebrow">WAAR ZIJN ZE?</span><h1>Minions</h1><p className="muted">Elke minion heeft een plaats: speler, checkpoint, toren of kamp.</p>
    <div className="placement-section"><div className="placement-heading"><div><small>01 · BIJ SPELER</small><h2>{player.length}/10 onderweg</h2></div><button onClick={onSquad}>Bekijk squad ›</button></div><div className="placement-list">{player.map(({ slot, minion: m }) => <div className="placement-row" key={m.id}><span className="placement-index">{slot + 1}</span><span className="unit-icon">{m.icon}</span><span className="placement-main"><b>{m.name}</b><small>Level {m.level} · {minionPower(m)} power</small></span><span className="placement-location">Bij speler</span></div>)}</div></div>
    <div className="placement-section"><div className="placement-heading"><div><small>02 · BIJ CHECKPOINT</small><h2>Summonen</h2></div></div><p className="muted">Een checkpoint blijft minions verkopen. Hogere levels openen wizard, hexer en beast.</p><div className="placement-list">{game.checkpoints.map(cp => { const distance = Math.round(distanceMeters(game.position, cp.position)); const names = cp.owner === 'player' ? summonOptions(cp).map(o => `${o.label} ${o.cost} CTW`).join(' · ') : cp.owner === null ? 'Eerst claimen' : 'Eerst veroveren'; return <button className="placement-row placement-button" key={cp.id} onClick={() => onCheckpoint(cp.id)}><span className="unit-icon">{recruitPreview(cp).icon}</span><span className="placement-main"><b>{cp.name}</b><small>{names} · {distance} m</small>{cp.waitingMinions.length > 0 && <small>Wachten hier: {cp.waitingMinions.map(id => game.minions.find(m => m.id === id)?.name ?? 'Minion').join(', ')}</small>}</span><span className="chevron">›</span></button>; })}</div></div>
    <div className="placement-section"><div className="placement-heading"><div><small>03 · IN TOREN</small><h2>Verdedigers</h2></div></div>{owned.length ? owned.map(cp => <div className="tower-group" key={cp.id}><button className="tower-group-head" onClick={() => onCheckpoint(cp.id)}><b>{cp.name}</b><span>{cp.defenders.filter(Boolean).length}/{checkpointCapacity(cp.level)} · ›</span></button><div className="placement-list">{cp.defenders.slice(0, checkpointCapacity(cp.level)).map((id, slot) => { const m = game.minions.find(v => v.id === id); return m ? <div className="placement-row" key={id}><span className="placement-index">{slot + 1}</span><span className="unit-icon">{m.icon}</span><span className="placement-main"><b>{m.name}</b><small>Level {m.level} · {minionPower(m)} power · {Math.round(m.currentHp ?? m.hp)}/{m.hp} HP</small></span><span className="placement-location">In toren</span></div> : null; })}{!cp.defenders.some(Boolean) && <p className="muted">Nog geen verdedigers.</p>}</div></div>) : <p className="muted">Claim een checkpoint om een toren te beheren.</p>}</div>
    <div className="placement-section"><div className="placement-heading"><div><small>04 · KAMPEN</small><h2>Voeding en training</h2></div></div><div className="camp-meter"><span>Torenminions {stats.towerHunger}/{stats.foodCapacity} gevoed</span><b className={stats.foodShortage ? 'danger' : ''}>{stats.foodShortage ? `Tekort ${stats.foodShortage}` : 'OK'}</b></div><div className="camp-meter"><span>Training {stats.activeTraining}/{stats.trainingCapacity}</span><b>{stats.trainers} begeleiders</b></div>{game.camps.map(camp => <CampCard key={camp.id} camp={camp} game={game} />)}{!game.camps.length && <p className="muted">Bouw kampen vanuit Territory wanneer je in een groene zone staat.</p>}</div></>;
}

function CampCard({ camp, game }: { camp: Camp; game: GameState }) {
  return <div className="camp-card"><b>{camp.name}</b><span>{camp.type === 'farm' ? `${camp.workers.length}/2 boeren · voedt ${camp.workers.length * CONFIG.foodPerFarmer} minions` : `${camp.workers.length}/2 begeleiders · ${camp.training.filter(t => !t.completed).length}/${camp.workers.length * 2} in training`}</span>{camp.training.map(job => { const m = game.minions.find(v => v.id === job.minionId); return <small key={job.minionId}>{m?.name ?? 'Minion'} {job.completed ? 'klaar' : `klaar over ${Math.max(0, Math.ceil((job.endsAt - Date.now()) / 60000))} min`}</small>; })}</div>;
}

function WaitingMinions({ game, cpId, near, onSquad, onTower }: { game: GameState; cpId: string; near: boolean; onSquad: (slot: number, id: string) => void; onTower: (id: string) => void }) {
  const cp = game.checkpoints.find(c => c.id === cpId)!;
  const freeSlots = game.squad.map((id, slot) => id ? -1 : slot).filter(slot => slot >= 0);
  const towerFree = cp.owner === 'player' && cp.defenders.slice(0, checkpointCapacity(cp.level)).includes(null);
  return <section className="checkpoint-collection"><h3>Wachten bij {cp.name} · {cp.waitingMinions.length}</h3><p className="muted">Deze minions uit een ouder spel staan hier veilig totdat je een plaats kiest.</p>{cp.waitingMinions.map(id => { const m = game.minions.find(v => v.id === id); return m ? <div className="checkpoint-minion" key={id}><span className="unit-icon">{m.icon}</span><span className="placement-main"><b>{m.name} · Lv {m.level}</b><small>{minionPower(m)} power</small></span><select value="" aria-label={`Plaats ${m.name} bij speler`} disabled={!near || !freeSlots.length} onChange={e => { if (e.target.value) onSquad(Number(e.target.value), m.id); }}><option value="">Speler vakje…</option>{freeSlots.map(slot => <option key={slot} value={slot}>Vakje {slot + 1}</option>)}</select>{cp.owner === 'player' && <button disabled={!near || !towerFree} onClick={() => onTower(m.id)}>In toren</button>}</div> : null; })}{!near && <p className="muted">Ga tot binnen {CONFIG.interactionMeters} m om ze te plaatsen.</p>}{!freeSlots.length && !towerFree && <p className="muted">Geen vrije plaats bij speler of toren.</p>}</section>;
}

function Garrison({ game, cpId, onRecall, showEmpty = true }: { game: GameState; cpId: string; onRecall: (slot: number, playerSlot: number) => void; showEmpty?: boolean }) {
  const cp = game.checkpoints.find(v => v.id === cpId);
  if (!cp || cp.owner !== 'player') return null;
  const entries = cp.defenders.slice(0, checkpointCapacity(cp.level)).map((id, slot) => ({ id, slot })).filter(({ id }) => showEmpty || !!id);
  const freeSlots = game.squad.map((id, slot) => id ? -1 : slot).filter(slot => slot >= 0);
  return <div className="garrison-list">{entries.length ? entries.map(({ id, slot }) => { const m = game.minions.find(v => v.id === id); return <div className="garrison-slot" key={slot}><span>{m?.icon ?? '·'}</span><b>{m ? `${m.name} · Lv ${m.level}` : `Vrije plaats ${slot + 1}`}</b>{m && <select aria-label={`Haal ${m.name} terug naar speler`} value="" disabled={!freeSlots.length} onChange={e => { if (e.target.value) onRecall(slot, Number(e.target.value)); }}><option value="">Naar speler…</option>{freeSlots.map(playerSlot => <option value={playerSlot} key={playerSlot}>Vakje {playerSlot + 1}</option>)}</select>}</div>; }) : <p className="muted">Nog geen minions achtergelaten.</p>}{!freeSlots.length && entries.some(e => e.id) && <p className="muted">Spelersbalk vol. Maak eerst ruimte door een minion in een nabije toren te zetten.</p>}</div>;
}

function TerritoryScreen({ game, owned, discovered, onSelect, onUpgrade, onRecall, onBuild, onWorker, onTrain }: { game: GameState; owned: number; discovered: number; onSelect: (id: string) => void; onUpgrade: (id: string) => void; onRecall: (id: string, slot: number, playerSlot: number) => void; onBuild: (type: 'farm' | 'training') => void; onWorker: (campId: string) => void; onTrain: (campId: string, minionId: string) => void }) {
  const stats = campStats(game), buildable = canBuildCamp(game);
  const trainable = game.squad.map(id => game.minions.find(m => m.id === id)).filter((m): m is Minion => !!m && m.level < 3);
  return <><span className="eyebrow">YOUR EMPIRE</span><h1>Territory</h1><p className="muted">Hier beheer je torens, voeding en training in groene zones.</p><div className="territory-hero"><small>CONTROLLED AREA</small><strong>{(owned * CONFIG.cellMeters ** 2 / 1000000).toFixed(3)} <em>km²</em></strong><span>{owned} cells under your banner</span></div><div className="metric-row territory-metrics"><div><small>DISCOVERED</small><b>{discovered}</b></div><div><small>TORENVOEDING</small><b>{stats.towerHunger}/{stats.foodCapacity}</b></div><div><small>TRAINING</small><b>{stats.activeTraining}/{stats.trainingCapacity}</b></div></div>
    <h2>Kampen</h2><div className="camp-build"><button className="primary" disabled={!buildable || game.player.tokens < CONFIG.farmCost} onClick={() => onBuild('farm')}>Boerderij · {CONFIG.farmCost} CTW</button><button className="primary" disabled={!buildable || game.player.tokens < CONFIG.trainingCampCost} onClick={() => onBuild('training')}>Trainingkamp · {CONFIG.trainingCampCost} CTW</button>{!buildable && <p className="muted">Ga in een groene zone staan om kampen te bouwen.</p>}</div><div className="placement-list">{game.camps.map(camp => <div className="camp-card" key={camp.id}><b>{camp.name}</b><span>{camp.type === 'farm' ? `${camp.workers.length}/2 boeren · voeding ${camp.workers.length * CONFIG.foodPerFarmer}` : `${camp.workers.length}/2 begeleiders · ${camp.training.filter(t => !t.completed).length}/${camp.workers.length * 2} bezig`}</span><button disabled={camp.workers.length >= 2 || game.player.tokens < (camp.type === 'farm' ? CONFIG.farmerCost : CONFIG.trainerCost)} onClick={() => onWorker(camp.id)}>{camp.type === 'farm' ? `Boer · ${CONFIG.farmerCost}` : `Begeleider · ${CONFIG.trainerCost}`}</button>{camp.type === 'training' && <select value="" disabled={camp.training.filter(t => !t.completed).length >= camp.workers.length * 2 || !trainable.length} onChange={e => { if (e.target.value) onTrain(camp.id, e.target.value); }}><option value="">Train minion…</option>{trainable.map(m => <option key={m.id} value={m.id}>{m.name} · Lv {m.level}</option>)}</select>}{camp.training.map(job => { const m = game.minions.find(v => v.id === job.minionId); return <small key={job.minionId}>{m?.name ?? 'Minion'} {job.completed ? 'klaar' : `klaar over ${Math.max(0, Math.ceil((job.endsAt - Date.now()) / 60000))} min`}</small>; })}</div>)}</div>
    <h2>Checkpoints</h2><div className="territory-list">{game.checkpoints.map(cp => <div className="territory-checkpoint" key={cp.id}><button className="territory-checkpoint-head" onClick={() => onSelect(cp.id)}><span className={`owner-dot ${cp.owner ?? 'neutral'}`}/><span><b>{cp.name}</b><small>{cp.owner === 'player' ? 'Jouw checkpoint' : cp.owner === null ? 'Neutraal' : `${cp.owner} territory`} · Level {cp.level} · {cp.defenders.filter(Boolean).length}/{checkpointCapacity(cp.level)} minions</small></span><span className="chevron">›</span></button>{cp.owner === 'player' && <div className="territory-garrison"><div className="territory-garrison-title"><b>Minions hier achtergelaten</b><button disabled={cp.level >= 5 || game.player.tokens < (CONFIG.checkpointLevels[cp.level]?.cost ?? Infinity)} onClick={() => onUpgrade(cp.id)}>Upgrade {cp.level < 5 ? `· ${CONFIG.checkpointLevels[cp.level].cost} CTW` : 'MAX'}</button></div><Garrison game={game} cpId={cp.id} showEmpty={false} onRecall={(slot, playerSlot) => onRecall(cp.id, slot, playerSlot)} /></div>}</div>)}</div><div className="tip"><b>Checkpointplaatsen</b><p>Niveau 1 heeft 6 minionplaatsen. Elke upgrade geeft één extra plaats, tot 10 op niveau 5.</p></div></>;
}

function ProfileScreen({ game, level, onReset }: { game: GameState; level: number; onReset: () => void }) {
  return <><span className="eyebrow">EXPLORER PROFILE</span><h1>{game.player.username}</h1><div className="profile-badge">◈</div><div className="metric-row"><div><small>LEVEL</small><b>{level}</b></div><div><small>XP</small><b>{game.player.xp}</b></div><div><small>CTW TOKENS</small><b>{game.player.tokens}</b></div></div><div className="tip"><b>Prototype mode</b><p>Your progress is saved on this device. GPS requires location permission and a secure browser context. Simulation works anywhere with the direction controls or by tapping the map.</p></div><h2>Latest activity</h2><div className="activity-list">{game.events.map((event, i) => <p key={i}>✦ {event}</p>)}</div><button className="reset-button" onClick={onReset}>Reset local progress</button></>;
}
