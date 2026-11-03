import { MutableRefObject, useEffect, useRef } from 'react';
import type { MapData } from '../lib/game';
import { CameraMode, SHORT_LABEL, WorldScene, WorldState } from './world';
import { SHORT } from '../components/CampusMap';

Object.assign(SHORT_LABEL, SHORT);

export default function World3D({ map, state, mode = 'follow', zoom = 1, onPick, className, live }: {
  map: MapData; state: WorldState; mode?: CameraMode; zoom?: number; onPick?: (id: string) => void; className?: string;
  live?: MutableRefObject<{ x: number; y: number; moving: boolean }>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  useEffect(() => {
    if (!ref.current) return;
    let sc: WorldScene | null = null;
    try {
      sc = new WorldScene(ref.current, map, { mode, onPick: (id) => pickRef.current?.(id) });
    } catch {
      sc = null; // no WebGL: the 2D map fallback is shown by the parent
    }
    sceneRef.current = sc;
    if (sc) { sc.liveMe = live || null; sc.setState(state); }
    return () => { sc?.dispose(); sceneRef.current = null; };
  }, [map]);
  useEffect(() => { sceneRef.current?.setState(state); }, [state]);
  useEffect(() => { sceneRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { sceneRef.current?.setZoom(zoom); }, [zoom]);
  return (
    <div className={`world3d ${className || ''}`}>
      <canvas ref={ref} aria-label="3D campus map" role="img" />
    </div>
  );
}
