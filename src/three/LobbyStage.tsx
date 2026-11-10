import { useEffect, useRef } from 'react';
import { LobbyStage } from './lobby';

export default function Stage({ color }: { color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stage: LobbyStage | null = null;
    try { stage = new LobbyStage(ref.current!, color); } catch { /* no WebGL: the painted backdrop stays */ }
    return () => stage?.dispose();
  }, [color]);
  return <canvas ref={ref} className="lobby-canvas" aria-label="Your squad buggy on the launch pad. Drag to turn it." />;
}
