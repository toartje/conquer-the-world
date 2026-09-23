# Conquer the World — playable prototype

A mobile-first local prototype using React, Leaflet, and OpenStreetMap.

## Run

```bash
npm install
npm run dev
```

Open the local URL in a browser. Simulation starts in central Brussels. Tap the map, use the direction pad, or press arrow/WASD keys to explore. GPS mode uses browser location permission and requires HTTPS or localhost.

The 10-slot player bar stays visible below the map. **Minions** now groups every unit by location: with the player, available for recruitment at a checkpoint, or defending a tower. There is no loose collection. Recruitment costs 55 CTW, requires an owned checkpoint within 130 meters, and asks for an empty player slot or tower place before purchase. Each checkpoint offers one specific minion and one recruit per level. Squad minions can move into an owned tower within 360 meters. Recalling a defender requires an empty player slot. If both destinations are full, recruitment is blocked; each checkpoint supports up to 10 defenders at level 5. Existing saves are migrated without discarding minions: free units fill player and owned tower slots, with overflow waiting at a named checkpoint until a place opens. Progress is saved in localStorage.

Walking only discovers cells and lifts fog. Green territory is recalculated from nearby groups of three owned checkpoints (maximum link distance is configurable). Their triangles fill the enclosed area, while a neutral or enemy checkpoint inside a triangle blocks that area. With all surrounding checkpoints owned, their triangles merge into one continuous territory. Existing local saves are recalculated on load, so old green walking paths no longer count as claimed land.

## Architecture

- `src/game/geo.ts`: meter-based Web Mercator cells, stable IDs, and distance helpers
- `src/game/engine.ts`: exploration, claiming, economy, checkpoints, inventory
- `src/game/territory.ts`: checkpoint triangle ownership rules
- `src/game/battle.ts`: automatic local battle simulation
- `src/game/storage.ts`: swappable local persistence adapter
- `src/components/GameMap.tsx`: Leaflet map and canvas fog/territory overlay
- `src/config.ts`: tunable gameplay values

The prototype is single-player with simulated rivals. A future multiplayer service must validate movement and become authoritative for cells, rewards, inventory, checkpoints, and battle results. The World Boss marker is a preview; it has no combat yet.
