import type { DragEvent, PointerEvent } from 'react';
import type { GameState } from '../game/types';

export function SquadDock({ game, selectedId, onAssign, onTouchDrag, onSlotClick }: {
  game: GameState;
  selectedId: string | null;
  onAssign: (slot: number, id: string) => void;
  onTouchDrag: (id: string, event: PointerEvent<HTMLElement>) => void;
  onSlotClick: (slot: number) => void;
}) {
  const occupied = game.squad.filter(Boolean).length;
  const onDrop = (event: DragEvent<HTMLButtonElement>, slot: number) => {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain');
    if (id) onAssign(slot, id);
  };
  return <div className="squad-dock" aria-label="Player squad hotbar">
    <div className="dock-heading"><b>🧍 JIJ <span>· {occupied}/10 mee</span></b><small>{selectedId ? 'Tik een vakje om te wisselen' : 'Tik vakjes om te wisselen'}</small></div>
    <div className="hotbar">
      {game.squad.map((id, slot) => {
        const minion = game.minions.find(m => m.id === id);
        return <button key={slot} className={`hotbar-slot ${minion ? 'filled' : ''} ${selectedId ? 'can-place' : ''}`}
          data-squad-slot={slot} aria-label={`Speler vakje ${slot + 1}: ${minion?.name ?? 'leeg'}`}
          title={minion ? `${minion.name} · level ${minion.level}` : `Leeg vakje ${slot + 1}`}
          onClick={() => onSlotClick(slot)} onDragOver={e => e.preventDefault()} onDrop={e => onDrop(e, slot)}
          draggable={!!minion} onDragStart={e => { if (id) e.dataTransfer.setData('text/plain', id); }}
          onPointerDown={e => { if (id && e.pointerType === 'touch') onTouchDrag(id, e); }}>
          <span className="hotbar-number">{slot + 1}</span><span className="hotbar-icon">{minion?.icon ?? '+'}</span>
        </button>;
      })}
    </div>
  </div>;
}
