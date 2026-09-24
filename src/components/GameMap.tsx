import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type Map as MapLibreMap } from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { COLORS, CONFIG } from '../config';
import { cellAt, cellCenter, cellCorners, cellId, offsetCells } from '../game/geo';
import type { Camp, Checkpoint, GameState, Position } from '../game/types';
import { loadPopulationCheckpoints, zoneAt, zoneRequestKey, zonesForBounds } from '../game/worldPopulation';
import { isPopulationCheckpoint } from '../game/worldCheckpoints';

setWorkerUrl(mapLibreWorkerUrl);

const MIN_CHECKPOINT_ZOOM = 15;
const MAX_POPULATION_MARKERS = 24;

function playableBounds() {
  return L.latLngBounds(
    [CONFIG.worldBounds.south, CONFIG.worldBounds.west],
    [CONFIG.worldBounds.north, CONFIG.worldBounds.east],
  );
}

function markerHtml(symbol: string, className: string, label: string) {
  return L.divIcon({ className: '', html: `<div class="map-pin ${className}" aria-label="${label}">${symbol}</div>`, iconSize: [42, 42], iconAnchor: [21, 21] });
}

function playerMarker() {
  return L.divIcon({ className: '', html: '<div class="player-avatar"><span>🏃</span><b>JIJ</b></div>', iconSize: [58, 64], iconAnchor: [29, 32] });
}

function campMarker(camp: Camp, placement: 'single' | 'left' | 'right') {
  const icon = camp.type === 'farm' ? '🌾' : '⚔';
  const kind = camp.type === 'farm' ? 'farm' : 'training';
  return L.divIcon({
    className: '',
    html: `<div class="camp-map-marker ${kind}-camp camp-${placement}" aria-label="${camp.name}"><span>${icon}</span><b>${camp.name}</b></div>`,
    iconSize: [72, 58],
    iconAnchor: [36, 29],
  });
}

export function GameMap({ game, onCheckpoint, onMove, onBoss, onWorldCheckpoints }: { game: GameState; onCheckpoint: (id: string) => void; onMove: (p: Position) => void; onBoss: () => void; onWorldCheckpoints: (checkpoints: Checkpoint[]) => void }) {
  const host = useRef<HTMLDivElement>(null), mapRef = useRef<L.Map | null>(null), canvasRef = useRef<HTMLCanvasElement | null>(null), markerLayer = useRef<L.LayerGroup | null>(null), debugLayer = useRef<L.LayerGroup | null>(null);
  const gameRef = useRef(game), moveRef = useRef(onMove), populationRef = useRef(onWorldCheckpoints), lastPanPosition = useRef<Position | null>(null), lastPopulationKey = useRef('');
  const [populationStatus, setPopulationStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [mapRevision, setMapRevision] = useState(0);
  gameRef.current = game; moveRef.current = onMove; populationRef.current = onWorldCheckpoints;

  useEffect(() => {
    if (!host.current) return;
    const bounds = playableBounds();
    const map = L.map(host.current, {
      zoomControl: false,
      attributionControl: true,
      maxBounds: bounds,
      maxBoundsViscosity: 1,
      minZoom: 2,
      worldCopyJump: false,
    }).setView(CONFIG.start, 17);
    mapRef.current = map;
    const vectorLayer = maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/liberty',
      attributionControl: false,
      renderWorldCopies: false,
    }).addTo(map);
    vectorLayer.getCanvas().classList.add('world-vector-canvas');
    const vectorMap = vectorLayer.getMaplibreMap();
    vectorMap.once('load', () => styleWorldMap(vectorMap));
    map.attributionControl.addAttribution('OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap');
    const canvas = document.createElement('canvas');
    canvas.className = 'territory-canvas'; canvas.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(canvas); canvasRef.current = canvas;
    const markers = L.layerGroup().addTo(map); markerLayer.current = markers;
    const debug = L.layerGroup().addTo(map); debugLayer.current = debug;
    const showZoneDebug = import.meta.env.DEV && new URLSearchParams(location.search).has('debugZones');
    const redraw = () => drawCells(map, canvas, gameRef.current);
    let loadSequence = 0;
    const loadPopulation = async () => {
      if (map.getZoom() < MIN_CHECKPOINT_ZOOM) {
        if (lastPopulationKey.current) { lastPopulationKey.current = ''; populationRef.current([]); }
        debug.clearLayers(); setPopulationStatus('idle'); return;
      }
      const sequence = ++loadSequence, bounds = map.getBounds();
      const latPadding = Math.max(0.018, (bounds.getNorth() - bounds.getSouth()) * 0.35);
      const lngPadding = Math.max(0.028, (bounds.getEast() - bounds.getWest()) * 0.35);
      const requestBounds = { south: bounds.getSouth() - latPadding, west: bounds.getWest() - lngPadding, north: bounds.getNorth() + latPadding, east: bounds.getEast() + lngPadding };
      const requestKey = zoneRequestKey(requestBounds, 1);
      if (requestKey === lastPopulationKey.current) return;
      lastPopulationKey.current = requestKey;
      setPopulationStatus('loading');
      try {
        const checkpoints = await loadPopulationCheckpoints(requestBounds, 1);
        if (sequence !== loadSequence) return;
        populationRef.current(checkpoints);
        if (showZoneDebug) {
          debug.clearLayers(); const active = zoneAt(gameRef.current.position).id;
          for (const zone of zonesForBounds(requestBounds, 1)) L.rectangle([[zone.bounds.south, zone.bounds.west], [zone.bounds.north, zone.bounds.east]], { color: zone.id === active ? '#f4d56a' : '#58b9e8', weight: zone.id === active ? 2 : 1, fill: false, interactive: true }).bindTooltip(zone.id).addTo(debug);
        }
        setPopulationStatus('ready');
      } catch (error) {
        if (lastPopulationKey.current === requestKey) lastPopulationKey.current = '';
        console.error('Population checkpoints could not be loaded', error);
        if (sequence === loadSequence) setPopulationStatus('error');
      }
    };
    const viewSettled = () => { setMapRevision(value => value + 1); void loadPopulation(); };
    map.on('move zoom resize', redraw);
    // Leaflet also emits moveend after zooming. One listener prevents every
    // zoom from decoding and rendering the same population tile twice.
    map.on('moveend', viewSettled);
    map.on('click', e => { if (gameRef.current.mode === 'simulation') moveRef.current(e.latlng); });
    redraw(); loadPopulation();
    return () => { map.remove(); mapRef.current = null; canvasRef.current = null; markerLayer.current = null; debugLayer.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current, canvas = canvasRef.current, group = markerLayer.current;
    if (!map || !canvas || !group) return;
    drawCells(map, canvas, game);
    group.clearLayers();
    L.circle(game.position, { radius: CONFIG.cellMeters * 2.3, color: COLORS.player, weight: 1, fillColor: COLORS.player, fillOpacity: .07, interactive: false }).addTo(group);
    L.marker(game.position, { icon: playerMarker(), title: 'Jouw positie', zIndexOffset: 1000 }).addTo(group);
    const visibleBounds = map.getBounds();
    if (map.getZoom() >= MIN_CHECKPOINT_ZOOM) {
      const visible = game.checkpoints.filter(cp => visibleBounds.contains(cp.position));
      const fixed = visible.filter(cp => !isPopulationCheckpoint(cp));
      const population = visible.filter(isPopulationCheckpoint)
        .sort((a, b) => map.distance(map.getCenter(), a.position) - map.distance(map.getCenter(), b.position))
        .slice(0, MAX_POPULATION_MARKERS);
      for (const cp of [...fixed, ...population]) addCheckpoint(cp, group, onCheckpoint);
    }
    const visibleCamps = game.camps.filter(camp => visibleBounds.contains(camp.position));
    for (const camp of visibleCamps) addCamp(camp, visibleCamps, group);
    const boss = offsetCells(CONFIG.start, 1, -11);
    if (map.getZoom() >= MIN_CHECKPOINT_ZOOM && visibleBounds.contains(boss)) L.marker(boss, { icon: markerHtml('♛', 'boss-pin', 'Ancient Titan'), zIndexOffset: 500 }).on('click', onBoss).addTo(group);
    const last = lastPanPosition.current;
    if (!last || last.lat !== game.position.lat || last.lng !== game.position.lng) {
      lastPanPosition.current = game.position;
      map.panTo(game.position, { animate: true, duration: .35 });
    }
  }, [game, onCheckpoint, onBoss, mapRevision]);

  const showWorld = () => mapRef.current?.setView([7.5, 0], 2, { animate: true });
  const showPlayer = () => mapRef.current?.setView(gameRef.current.position, 17, { animate: true });
  const zoomBy = (amount: number) => mapRef.current?.setZoom(mapRef.current.getZoom() + amount, { animate: true });

  return <>
    <div ref={host} className="game-map" aria-label="Interactive world map" />
    <div className="world-map-controls" aria-label="Kaartnavigatie">
      <button onClick={showWorld} title="Toon de hele wereld"><b>🌍</b><small>WERELD</small></button>
      <button onClick={showPlayer} title="Ga terug naar mijn speler"><b>◎</b><small>MIJ</small></button>
      <button onClick={() => zoomBy(-1)} title="Uitzoomen" aria-label="Uitzoomen"><b>−</b></button>
      <button onClick={() => zoomBy(1)} title="Inzoomen" aria-label="Inzoomen"><b>+</b></button>
    </div>
    <div className={`population-status ${populationStatus}`}>{populationStatus === 'loading' ? 'Bevolking laden…' : populationStatus === 'error' ? 'Bevolkingsdata niet bereikbaar' : populationStatus === 'ready' ? '1 checkpoint / 1.000 inwoners' : 'Zoom in voor checkpoints'}</div>
  </>;
}

function styleWorldMap(map: MapLibreMap) {
  for (const layer of map.getStyle().layers) {
    const id = layer.id.toLowerCase();
    if (layer.type === 'symbol') {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      continue;
    }
    if (layer.type === 'fill-extrusion' || layer.type === 'hillshade') {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      continue;
    }
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#b8dca3');
    if (layer.type === 'fill') {
      if (id.includes('water')) map.setPaintProperty(layer.id, 'fill-color', '#82c8dc');
      else if (/(park|grass|wood|forest|landcover)/.test(id)) map.setPaintProperty(layer.id, 'fill-color', '#9fd18a');
      else if (id.includes('building')) map.setPaintProperty(layer.id, 'fill-color', '#e5d5ba');
      else if (id.includes('landuse')) map.setPaintProperty(layer.id, 'fill-color', '#c5dfa8');
    }
    if (layer.type === 'line') {
      if (/(motorway|trunk)/.test(id)) map.setPaintProperty(layer.id, 'line-color', '#f2cc7a');
      else if (/(road|street|path|pedestrian|service|transportation|highway|bridge|tunnel)/.test(id)) map.setPaintProperty(layer.id, 'line-color', '#fff5d8');
      else if (id.includes('rail')) map.setPaintProperty(layer.id, 'line-color', '#b9b39e');
    }
  }
}

function addCheckpoint(cp: Checkpoint, group: L.LayerGroup, onCheckpoint: (id: string) => void) {
  const kind = cp.owner === 'player' ? 'friendly' : cp.owner === null ? 'neutral' : 'enemy';
  const procedural = isPopulationCheckpoint(cp);
  const populationClass = procedural ? ' population-pin' : '';
  L.marker(cp.position, { icon: markerHtml(cp.owner === 'player' ? '◆' : cp.owner ? '⚑' : '◇', `${kind}-pin${populationClass}`, cp.name), zIndexOffset: procedural ? 420 : 500 })
    .bindTooltip(cp.name, { direction: 'top', offset: [0, -20] }).on('click', () => onCheckpoint(cp.id)).addTo(group);
}

function addCamp(camp: Camp, camps: Camp[], group: L.LayerGroup) {
  const sameCell = camps.filter(candidate => candidate.cellId === camp.cellId);
  const index = sameCell.findIndex(candidate => candidate.id === camp.id);
  const parsedCell = camp.cellId.split(':').map(Number);
  const center = parsedCell.length === 2 && parsedCell.every(Number.isFinite)
    ? cellCenter(parsedCell[0], parsedCell[1])
    : camp.position;
  const placement = sameCell.length === 1 ? 'single' : index === 0 ? 'left' : 'right';
  const workerLabel = camp.type === 'farm' ? `${camp.workers.length} boer(en)` : `${camp.workers.length} begeleider(s)`;
  L.marker(center, { icon: campMarker(camp, placement), title: camp.name, zIndexOffset: 650 + index })
    .bindTooltip(`${camp.name} · ${workerLabel}`, { direction: 'top', offset: [0, -24] })
    .addTo(group);
}

function drawCells(map: L.Map, canvas: HTMLCanvasElement, game: GameState) {
  const size = map.getSize(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
  canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
  const origin = map.containerPointToLayerPoint([0, 0]);
  canvas.style.left = `${origin.x}px`; canvas.style.top = `${origin.y}px`;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.scale(dpr, dpr);
  const bounds = map.getBounds(), sw = cellAt(bounds.getSouthWest()), ne = cellAt(bounds.getNorthEast());
  const count = (ne.x - sw.x + 1) * (ne.y - sw.y + 1);
  if (count > 3000) {
    // At low zoom, paint a single fog layer, then the saved cells. This keeps
    // territory visible without creating thousands of off-screen rectangles.
    ctx.fillStyle = 'rgba(51,91,82,.28)'; ctx.fillRect(0, 0, size.x, size.y);
    for (const cell of Object.values(game.cells)) {
      if (cell.x < sw.x - 1 || cell.x > ne.x + 1 || cell.y < sw.y - 1 || cell.y > ne.y + 1) continue;
      const corners = cellCorners(cell.x, cell.y), a = map.latLngToContainerPoint(corners[0]), b = map.latLngToContainerPoint(corners[1]);
      const left = Math.floor(Math.min(a.x, b.x)), top = Math.floor(Math.min(a.y, b.y));
      const width = Math.ceil(Math.abs(a.x - b.x)) + 1, height = Math.ceil(Math.abs(a.y - b.y)) + 1;
      if (cell.discovered || cell.ownerId === 'player') ctx.clearRect(left, top, width, height);
      if (cell.ownerId) { ctx.fillStyle = cell.ownerId === 'player' ? 'rgba(37,194,154,.33)' : cell.ownerId === 'ember' ? 'rgba(240,120,97,.39)' : 'rgba(169,135,233,.39)'; ctx.fillRect(left, top, width, height); }
      if (!cell.discovered && cell.ownerId === 'player') { ctx.fillStyle = 'rgba(51,91,82,.18)'; ctx.fillRect(left, top, width, height); }
    }
    return;
  }
  for (let x = sw.x - 1; x <= ne.x + 1; x++) for (let y = sw.y - 1; y <= ne.y + 1; y++) {
    const corners = cellCorners(x, y), a = map.latLngToContainerPoint(corners[0]), b = map.latLngToContainerPoint(corners[1]);
    const left = Math.floor(Math.min(a.x, b.x)), top = Math.floor(Math.min(a.y, b.y));
    const width = Math.ceil(Math.abs(a.x - b.x)) + 1, height = Math.ceil(Math.abs(a.y - b.y)) + 1;
    const cell = game.cells[cellId(x, y)];
    if (cell?.ownerId) { ctx.fillStyle = cell.ownerId === 'player' ? 'rgba(37,194,154,.33)' : cell.ownerId === 'ember' ? 'rgba(240,120,97,.39)' : 'rgba(169,135,233,.39)'; ctx.fillRect(left, top, width, height); }
    if (!cell?.discovered) { ctx.fillStyle = cell?.ownerId === 'player' ? 'rgba(51,91,82,.18)' : 'rgba(51,91,82,.28)'; ctx.fillRect(left, top, width, height); }
  }
}
