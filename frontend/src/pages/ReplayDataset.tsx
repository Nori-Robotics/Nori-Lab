import React, { useEffect, useState } from "react";
import ReplayHeader from "@/components/replay/ReplayHeader";
import DatasetCombobox from "@/components/replay/DatasetCombobox";
import EpisodeList from "@/components/replay/EpisodeList";
import VideoGrid from "@/components/replay/VideoGrid";
import PlaybackBar from "@/components/replay/PlaybackBar";
import UrdfViewer from "@/components/UrdfViewer";
import UrdfProcessorInitializer from "@/components/UrdfProcessorInitializer";
import { useReplayPlayback } from "@/hooks/useReplayPlayback";
import { DatasetItem, EpisodeItem } from "@/lib/replayApi";

const ReplayDataset: React.FC = () => {
  const replay = useReplayPlayback();

  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);

  // Load datasets on mount.
  useEffect(() => {
    setDatasetsLoading(true);
    replay.listDatasets()
      .then(setDatasets)
      .catch(() => setDatasets([]))
      .finally(() => setDatasetsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load episodes when repo changes.
  useEffect(() => {
    setSelectedEpisode(null);
    setEpisodes([]);
    setEpisodesError(null);
    if (!selectedRepo) return;
    setEpisodesLoading(true);
    replay.listEpisodes(selectedRepo)
      .then((r) => setEpisodes(r.episodes))
      .catch((e) => setEpisodesError(e.message || "Failed to load episodes"))
      .finally(() => setEpisodesLoading(false));
  }, [selectedRepo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-start replay when an episode is picked. The hook's `start` internally stops any running session first.
  useEffect(() => {
    if (selectedRepo && selectedEpisode !== null) {
      replay.start(selectedRepo, selectedEpisode);
    }
  }, [selectedRepo, selectedEpisode]); // eslint-disable-line react-hooks/exhaustive-deps

  const { state } = replay;
  const disabled = state.status === "idle" || state.status === "loading";

  return (
    <div className="h-screen overflow-hidden bg-black text-white flex flex-col p-4 gap-3">
      <ReplayHeader status={state.status} repoId={state.repoId} episode={state.episode} />

      <div className="grid lg:grid-cols-2 gap-4 h-44 shrink-0">
        <DatasetCombobox
          datasets={datasets}
          loading={datasetsLoading}
          value={selectedRepo}
          onChange={setSelectedRepo}
        />
        <EpisodeList
          episodes={episodes}
          selected={selectedEpisode}
          loading={episodesLoading}
          error={episodesError}
          onSelect={setSelectedEpisode}
        />
      </div>

      <div className="flex-1 min-h-0 bg-gray-900 rounded-lg p-2 border border-gray-700">
        <UrdfProcessorInitializer />
        <UrdfViewer />
      </div>

      <VideoGrid cameras={state.cameras} registerRefs={replay.setVideoRefs} />

      <PlaybackBar
        paused={state.paused}
        frame={state.frame}
        totalFrames={state.totalFrames}
        fps={state.fps}
        speed={state.speed}
        disabled={disabled}
        onPlay={replay.resume}
        onPause={replay.pause}
        onStop={replay.stop}
        onSeek={replay.seek}
        onSpeedChange={replay.setSpeed}
      />

      {state.error && (
        <div className="rounded-md border border-red-700 bg-red-950/40 text-red-200 p-3 text-sm">
          {state.error}
        </div>
      )}
    </div>
  );
};

export default ReplayDataset;
