// NORI: Additive file. The selectable Remote-page layouts.
//
// A layout is arrangement ONLY: every functional element comes from blocks.tsx
// and behaves identically everywhere. The registry at the bottom drives the
// layout picker in pages/remote.tsx; switching is locked while a session is
// live, so layouts can assume they mount with no active stream.
//
// Field-test set — expect most of these to be deleted once usage narrows the
// list to one or two. Deleting a layout = removing its entry + component here.

import { useRemoteUi, PANEL, EYEBROW, PageHeader, Banners, VideoSurface, VitalsChips,
  TelemetryDetail, TelemetryCard, AudioCard, ModePills, ControlsStrip, ActiveModeCard,
  SchematicCard, LogsCard, LogBox, LogTicker, RecordBlock, DeployBlock, EStopButton, ArmControl,
  Drawers, TabPanes, StageSwitcher, Breakout } from "./blocks";

// ---------------------------------------------------------------------------
// Classic — the page as it shipped: video column + 400px rail. The safe
// baseline for the field test (and the fallback for narrow screens).
const ClassicLayout = () => (
  <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
    <div className="min-w-0 space-y-3">
      <PageHeader extra={<><ArmControl /><EStopButton compact /></>} />
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

// ---------------------------------------------------------------------------
// Cockpit — video-first, vitals as a HUD over the feed, 3D as a click-to-swap
// PIP, everything secondary in a bottom drawer bar. Leader mode's embedded
// setup is far too tall for the rail, so it renders full-width below instead.
const CockpitLayout = () => {
  const { controlMode } = useRemoteUi();
  const leader = controlMode === "leader";
  return (
    <Breakout>
      <div className="space-y-3 px-1">
        <PageHeader extra={<><ArmControl /><EStopButton /></>} />
        <Banners />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div className="min-w-0 space-y-3">
            {/* Fixed aspect: the stage must not resize when the rail's mode card
                changes height (grid children stretch to the tallest by default). */}
            <StageSwitcher
              className="aspect-[16/10]"
              video={<VideoSurface fill className="h-full" />}
              schematic={<SchematicCard bare heightClass="h-full" interactive />}
            />
            {/* Vitals as a strip UNDER the feed, not over it — chips are cream
                panels and read as noise on top of dark video. */}
            <div className={PANEL + " !py-2"}>
              <VitalsChips />
            </div>
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
            <AudioCard />
          </div>
        </div>
        {leader && <ActiveModeCard />}
        <Drawers
          items={[
            { id: "record", label: "record dataset", body: <RecordBlock open /> },
            { id: "deploy", label: "deploy policy", body: <DeployBlock open /> },
            {
              id: "telemetry", label: "full telemetry",
              body: <div className={PANEL}><TelemetryDetail /></div>,
            },
            { id: "logs", label: "robot logs", body: <LogBox /> },
          ]}
        />
      </div>
    </Breakout>
  );
};

// ---------------------------------------------------------------------------
// Mission control — three columns, nothing hidden: telemetry left, video
// center with a log ticker, controls + 3D right.
const MissionControlLayout = () => (
  <Breakout>
    <div className="space-y-3 px-1">
      <PageHeader extra={<><ArmControl /><EStopButton /></>} />
      <Banners />
      <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <div className={PANEL}>
            <p className={EYEBROW}>// vitals</p>
            <div className="mt-3"><VitalsChips /></div>
          </div>
          <div className={PANEL}><TelemetryDetail /></div>
        </div>
        <div className="min-w-0 space-y-3">
          <VideoSurface />
          <LogTicker />
        </div>
        <div className="min-w-0 space-y-3">
          <ControlsStrip />
          <ActiveModeCard />
          <SchematicCard />
          <AudioCard />
          <Drawers
            items={[
              { id: "record", label: "record", body: <RecordBlock open /> },
              { id: "deploy", label: "deploy", body: <DeployBlock open /> },
            ]}
          />
        </div>
      </div>
    </div>
  </Breakout>
);

// ---------------------------------------------------------------------------
// Split + tabs — pairing's proven 2:1 split: video and a TALL, orbitable 3D
// viewer as equals, everything secondary in one tabbed panel below. The vitals
// chip row stays pinned above the tabs so a warning can't hide behind them.
const SplitTabsLayout = () => (
  <Breakout>
    <div className="space-y-3 px-1">
      <PageHeader extra={<><ArmControl /><EStopButton /></>} />
      <Banners />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <VideoSurface />
        {/* The video's 4:3 height leaves this column headroom, so the mode
            pills live here, above the schematic, instead of in the header. */}
        <div className="min-w-0 space-y-3">
          <ControlsStrip />
          <SchematicCard heightClass="h-[420px]" interactive />
        </div>
      </div>
      <div className={PANEL}>
        <div className="mb-3"><VitalsChips /></div>
        <TabPanes
          initial="telemetry"
          items={[
            { id: "telemetry", label: "Telemetry", body: <TelemetryDetail /> },
            { id: "controls", label: "Controls", body: <ActiveModeCard /> },
            { id: "record", label: "Record dataset", body: <RecordBlock open /> },
            { id: "deploy", label: "Deploy policy", body: <DeployBlock open /> },
            { id: "audio", label: "Audio", body: <AudioCard /> },
            { id: "logs", label: "Logs", body: <LogBox /> },
          ]}
        />
      </div>
    </div>
  </Breakout>
);

// ---------------------------------------------------------------------------
// Stage — one big canvas that swaps video <-> 3D, with an always-visible
// status strip (vitals + E-STOP) that never scrolls away and never covers the
// feed. Leader mode drops below the grid, as in Cockpit.
const StageLayout = () => {
  const { controlMode, recordState } = useRemoteUi();
  const leader = controlMode === "leader";
  const recording = recordState?.recording ?? false;
  return (
    <Breakout>
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
          <div className="min-w-0 flex-1"><VitalsChips /></div>
          <ArmControl />
          <EStopButton />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px] lg:items-start">
          <StageSwitcher
            className="aspect-[16/9]"
            video={<VideoSurface fill className="h-full" />}
            schematic={<SchematicCard bare heightClass="h-full" interactive />}
          />
          <div className="min-w-0 space-y-3">
            {!leader && <ActiveModeCard />}
            {leader && (
              <div className={PANEL}>
                <p className={EYEBROW}>// leader arm</p>
                <p className="mt-2 text-sm text-nori-h6f6858">
                  Leader setup is open below the stage — it needs the full page width.
                </p>
              </div>
            )}
            <AudioCard />
          </div>
        </div>
        {leader && <ActiveModeCard />}
        <Drawers
          items={[
            { id: "record", label: "record dataset", body: <RecordBlock open /> },
            { id: "deploy", label: "deploy policy", body: <DeployBlock open /> },
            {
              id: "telemetry", label: "full telemetry",
              body: <div className={PANEL}><TelemetryDetail /></div>,
            },
            { id: "logs", label: "robot logs", body: <LogBox /> },
          ]}
        />
      </div>
    </Breakout>
  );
};

// ---------------------------------------------------------------------------
// registry

export type RemoteLayoutId = "classic" | "cockpit" | "mission" | "split" | "stage";

export const REMOTE_LAYOUTS: { id: RemoteLayoutId; label: string; Component: () => JSX.Element }[] = [
  { id: "classic", label: "Classic", Component: ClassicLayout },
  { id: "cockpit", label: "Cockpit", Component: CockpitLayout },
  { id: "mission", label: "Mission control", Component: MissionControlLayout },
  { id: "split", label: "Split + tabs", Component: SplitTabsLayout },
  { id: "stage", label: "Stage", Component: StageLayout },
];

export const DEFAULT_REMOTE_LAYOUT: RemoteLayoutId = "classic";

const STORAGE_KEY = "nori.remoteLayout";

export function loadRemoteLayout(): RemoteLayoutId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && REMOTE_LAYOUTS.some((l) => l.id === v)) return v as RemoteLayoutId;
  } catch { /* storage unavailable (private mode) — fall through */ }
  return DEFAULT_REMOTE_LAYOUT;
}

export function saveRemoteLayout(id: RemoteLayoutId) {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* best effort */ }
}
