// NORI: Additive file. The selectable Remote-page layouts.
//
// A layout is arrangement ONLY: every functional element comes from blocks.tsx
// and behaves identically everywhere. The registry at the bottom drives the
// layout picker in pages/remote.tsx; switching is locked while a session is
// live, so layouts can assume they mount with no active stream.
//
// Conventions shared by every layout:
//  - the header is status + Connect only; the safety cluster (arm/disarm +
//    E-STOP) lives in the `// controls` strip (or Stage's status strip), so
//    three differently-styled buttons never pile up next to Connect;
//  - secondary surfaces (record/deploy/telemetry/audio/logs) stack in the same
//    column as the thing they relate to, so columns end together instead of
//    leaving a gap under the shorter one.
//
// Field-test set — expect most of these to be deleted once usage narrows the
// list to one or two. (Mission control and Split + tabs already fell.)

import { useEffect, useRef, useState } from "react";
import { useRemoteUi, PANEL, EYEBROW, PageHeader, Banners, VideoSurface, VitalsChips,
  TelemetryDetail, TelemetryCard, AudioCard, ModePills, ControlsStrip, ActiveModeCard,
  SchematicCard, LogsCard, LogBox, RecordBlock, DeployBlock, EStopButton, ArmControl,
  Drawers, StageSwitcher, Breakout } from "./blocks";

// ---------------------------------------------------------------------------
// Classic — the page as it shipped: video column + 400px rail. The safe
// baseline for the field test (and the fallback for narrow screens).
const ClassicLayout = () => (
  <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
    <div className="min-w-0 space-y-3">
      <PageHeader />
      <Banners />
      <VideoSurface />
      <RecordBlock />
      <DeployBlock />
      <TelemetryCard />
    </div>
    <div className="h-fit min-w-0 space-y-4">
      <AudioCard />
      <ControlsStrip />
      <ActiveModeCard />
      <SchematicCard />
      <LogsCard />
    </div>
  </div>
);

// The one drawer set Cockpit and Stage share.
const SecondaryDrawers = () => (
  <Drawers
    items={[
      { id: "record", label: "record dataset", body: <RecordBlock open /> },
      { id: "deploy", label: "deploy policy", body: <DeployBlock open /> },
      {
        id: "telemetry", label: "full telemetry",
        body: <div className={PANEL}><TelemetryDetail /></div>,
      },
      { id: "audio", label: "audio", body: <AudioCard /> },
      { id: "logs", label: "robot logs", body: <LogBox /> },
    ]}
  />
);

// ---------------------------------------------------------------------------
// Cockpit — video-first: stage + vitals + drawers stack in the left column so
// there's no dead space under either column; the rail is controls only.
// Leader mode's embedded setup is far too tall for the rail, so it renders
// full-width below instead.
const CockpitLayout = () => {
  const { controlMode } = useRemoteUi();
  const leader = controlMode === "leader";
  return (
    <Breakout>
      <div className="space-y-3 px-1">
        <PageHeader />
        <Banners />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0 space-y-3">
            {/* Fixed aspect: the stage must not resize when the rail's mode card
                changes height (grid children stretch to the tallest by default). */}
            {/* 4:3 matches the real feed, so no pillar bars at all. */}
            <StageSwitcher
              className="aspect-[4/3]"
              video={<VideoSurface fill className="h-full" />}
              schematic={<SchematicCard bare heightClass="h-full" interactive />}
            />
            {/* Vitals as a strip UNDER the feed, not over it — chips are cream
                panels and read as noise on top of dark video. Drawers follow
                immediately, same column, so vitals→drawers has no gap. */}
            <div className={PANEL + " !py-2"}>
              <VitalsChips />
            </div>
            <SecondaryDrawers />
          </div>
          <div className="min-w-0 space-y-3">
            <ControlsStrip />
            {!leader && <ActiveModeCard />}
            {leader && (
              <div className={PANEL}>
                <p className={EYEBROW}>// leader arm</p>
                <p className="mt-2 text-sm text-nori-h6f6858">
                  Leader setup is open below the video — it needs the full page width.
                </p>
              </div>
            )}
          </div>
        </div>
        {leader && <ActiveModeCard wide />}
      </div>
    </Breakout>
  );
};

// ---------------------------------------------------------------------------
// Stage — one big canvas that swaps video <-> 3D, with an always-visible
// status strip (vitals + arm + E-STOP). The drawers ADAPT: while the rail's
// mode card runs taller than the stage, they stay in the stage's column and
// fill the space beside it; once the rail is the shorter one, they stretch
// across the full width below the grid instead of leaving a hole beside the
// rail. Leader mode drops below the grid, as in Cockpit.
const StageLayout = () => {
  const { controlMode, recordState } = useRemoteUi();
  const leader = controlMode === "leader";
  const recording = recordState?.recording ?? false;

  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [railTaller, setRailTaller] = useState(false);
  useEffect(() => {
    const measure = () => {
      const stage = stageRef.current?.offsetHeight ?? 0;
      const rail = railRef.current?.offsetHeight ?? 0;
      setRailTaller(rail > stage);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stageRef.current) ro.observe(stageRef.current);
    if (railRef.current) ro.observe(railRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    // Narrower than the other breakout layouts: the 4:3 feed in a wide 16:9
    // stage stranded huge pillar bars. 3:2 stage + this width leaves slim ones.
    <Breakout width="w-[min(92vw,1200px)]">
      <div className="space-y-3 px-1">
        <PageHeader extra={<ModePills />} />
        <Banners />
        <div className={PANEL + " flex flex-wrap items-center gap-3 !py-2"}>
          {recording && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-nori-h8f2318">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
              rec · {recordState?.episodesKept ?? 0} kept
            </span>
          )}
          <div className="min-w-0 flex-1"><VitalsChips dense /></div>
          <ArmControl compact />
          <EStopButton />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
          <div className="min-w-0 space-y-3">
            <div ref={stageRef}>
              <StageSwitcher
                className="aspect-[3/2]"
                video={<VideoSurface fill className="h-full" />}
                schematic={<SchematicCard bare heightClass="h-full" interactive />}
              />
            </div>
            {railTaller && <SecondaryDrawers />}
          </div>
          <div ref={railRef} className="min-w-0 space-y-3">
            {!leader && <ActiveModeCard />}
            {leader && (
              <div className={PANEL}>
                <p className={EYEBROW}>// leader arm</p>
                <p className="mt-2 text-sm text-nori-h6f6858">
                  Leader setup is open below the stage — it needs the full page width.
                </p>
              </div>
            )}
          </div>
        </div>
        {!railTaller && <SecondaryDrawers />}
        {leader && <ActiveModeCard wide />}
      </div>
    </Breakout>
  );
};

// ---------------------------------------------------------------------------
// registry

export type RemoteLayoutId = "classic" | "cockpit" | "stage";

export const REMOTE_LAYOUTS: { id: RemoteLayoutId; label: string; Component: () => JSX.Element }[] = [
  { id: "classic", label: "Classic", Component: ClassicLayout },
  { id: "cockpit", label: "Cockpit", Component: CockpitLayout },
  { id: "stage", label: "Stage", Component: StageLayout },
];

export const DEFAULT_REMOTE_LAYOUT: RemoteLayoutId = "classic";

const STORAGE_KEY = "nori.remoteLayout";

export function loadRemoteLayout(): RemoteLayoutId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    // Unknown ids (including deleted layouts, e.g. "mission"/"split") fall back cleanly.
    if (v && REMOTE_LAYOUTS.some((l) => l.id === v)) return v as RemoteLayoutId;
  } catch { /* storage unavailable (private mode) — fall through */ }
  return DEFAULT_REMOTE_LAYOUT;
}

export function saveRemoteLayout(id: RemoteLayoutId) {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* best effort */ }
}
