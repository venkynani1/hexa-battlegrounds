import { useEffect, useRef } from 'react';
import { BusScene, Seat } from './bus';

export default function Bus3D({ seats, code, driving = false, progress = 0, height = 300 }: { seats: Seat[]; code: string; driving?: boolean; progress?: number; height?: number | string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sc = useRef<BusScene | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    try { sc.current = new BusScene(ref.current, code); } catch { sc.current = null; }
    return () => { sc.current?.dispose(); sc.current = null; };
  }, [code]);
  useEffect(() => { sc.current?.setSeats(seats); }, [seats, code]);
  useEffect(() => { sc.current?.setDriving(driving, progress); }, [driving, progress, code]);
  return (
    <div className="bus3d" style={{ height }}>
      <canvas ref={ref} aria-label={`Shuttle ${code} with your squad seated inside`} role="img" />
    </div>
  );
}
