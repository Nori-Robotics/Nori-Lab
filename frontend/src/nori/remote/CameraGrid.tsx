// NORI: Additive file. Multi-camera feed grid for remote teleop. The robot may send more than
// one video track (one per camera); RemoteTeleop routes each to us via onVideoTrack (keyed by a
// stable id = transceiver mid) and names them via onCameraNames. This renders one tile per feed
// and lets the operator click a tile to promote it to the main video element.
//
// Single-camera robots: the SDK only emits one track, so this shows a single tile (or the parent
// can hide the grid entirely when there's ≤1 feed).
import { useEffect, useRef } from "react";

// One live feed. <video> srcObject can't be set as a JSX prop, so we attach it via ref.
function CameraFeed({
  stream,
  label,
  active,
  onClick,
}: {
  stream: MediaStream;
  label: string;
  active: boolean;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "group relative overflow-hidden rounded-md border bg-black/60 focus:outline-none " +
        (active ? "ring-2 ring-emerald-400 border-emerald-400" : "hover:border-muted-foreground/50")
      }
      title={`Show ${label} in the main view`}
    >
      <video ref={ref} autoPlay muted playsInline className="aspect-video w-full object-cover" />
      <span className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
        {label}
        {active && <span className="ml-1 text-emerald-300">• main</span>}
      </span>
    </button>
  );
}

export interface CameraGridProps {
  // id (transceiver mid) -> MediaStream, from RemoteTeleop.onVideoTrack / onVideoRemoved.
  streams: Record<string, MediaStream>;
  // id -> camera name, from RemoteTeleop.onCameraNames (may lag the streams; falls back to id).
  names: Record<string, string>;
  // id of the feed currently promoted to the main <video>; clicking a tile calls onSelect(id).
  activeId?: string | null;
  onSelect?: (id: string) => void;
}

export function CameraGrid({ streams, names, activeId, onSelect }: CameraGridProps) {
  const ids = Object.keys(streams);
  if (ids.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ids.map((id, i) => (
        <CameraFeed
          key={id}
          stream={streams[id]}
          label={names[id] ?? `camera ${i + 1}`}
          active={activeId === id}
          onClick={() => onSelect?.(id)}
        />
      ))}
    </div>
  );
}
