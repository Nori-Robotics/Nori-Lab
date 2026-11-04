// A labelled 0-100% slider, shared by the Remote and Agent pages. Its own file so the Agent page does not pull in
// the Remote layout (the URDF viewer and everything behind it).
export const TuneSlider = ({
  label, value, min, max, title, onChange,
}: {
  label: string; value: number; min: number; max: number; title: string;
  onChange: (v: number) => void;
}) => (
  <label className="flex w-full items-center gap-2" title={title}>
    <span className="w-24 shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
    <input
      type="range" min={min} max={max} step={0.05} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1 min-w-0 flex-1 cursor-pointer accent-nori-h14131a"
    />
    <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{Math.round(value * 100)}%</span>
  </label>
);
