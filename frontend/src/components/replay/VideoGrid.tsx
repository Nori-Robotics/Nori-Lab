import React, { useEffect, useRef } from "react";
import { VideoOff } from "lucide-react";
import { CameraItem } from "@/lib/replayApi";

interface Props {
  cameras: CameraItem[];
  registerRefs: (els: (HTMLVideoElement | null)[]) => void;
}

const VideoGrid: React.FC<Props> = ({ cameras, registerRefs }) => {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    registerRefs(refs.current);
  }, [cameras, registerRefs]);

  if (cameras.length === 0) {
    return (
      <div className="flex gap-2 h-28 shrink-0">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="aspect-video h-full shrink-0 bg-gray-900 rounded-lg border border-gray-800 flex flex-col items-center justify-center p-2">
            <VideoOff className="h-6 w-6 text-gray-600 mb-1" />
            <span className="text-gray-500 text-xs">No video</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-2 h-28 shrink-0 overflow-x-auto">
      {cameras.map((cam, i) => (
        <div key={cam.key} className="aspect-video h-full shrink-0 bg-gray-900 rounded-lg border border-gray-800 overflow-hidden relative">
          <video
            ref={(el) => { refs.current[i] = el; }}
            src={cam.url}
            preload="metadata"
            muted
            playsInline
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-0 left-0 right-0 px-2 py-0.5 text-xs text-gray-300 bg-black/60 truncate">{cam.key}</div>
        </div>
      ))}
    </div>
  );
};

export default VideoGrid;
