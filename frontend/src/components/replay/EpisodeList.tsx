import React from "react";
import { ListVideo } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { EpisodeItem } from "@/lib/replayApi";

interface Props {
  episodes: EpisodeItem[];
  selected: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (episodeIndex: number) => void;
}

const EpisodeList: React.FC<Props> = ({ episodes, selected, loading, error, onSelect }) => {
  return (
    <Card className="bg-gray-900 border-gray-700 flex flex-col h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-white">
          <ListVideo className="w-5 h-5 text-purple-400" />
          Episodes
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="flex-1 pr-4 border border-gray-700 rounded-lg">
          <div className="p-2 space-y-1">
            {loading && <div className="text-center text-gray-500 py-8">Loading episodes…</div>}
            {error && <div className="text-center text-red-400 py-8">{error}</div>}
            {!loading && !error && episodes.length === 0 && (
              <div className="text-center text-gray-500 py-8">Pick a dataset to see episodes.</div>
            )}
            {!loading && !error && episodes.map((ep) => (
              <button
                key={ep.episode_index}
                onClick={() => onSelect(ep.episode_index)}
                className={cn(
                  "w-full text-left p-2 rounded-md transition-colors text-sm flex items-center justify-between",
                  selected === ep.episode_index
                    ? "bg-purple-500/20 text-purple-300"
                    : "hover:bg-gray-800 text-gray-300"
                )}
              >
                <span>Episode {ep.episode_index}</span>
                <span className="font-mono text-xs text-gray-500">{ep.duration_human}</span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

export default EpisodeList;
