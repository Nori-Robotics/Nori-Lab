// NORI: Additive file. Warm leader-setup-style panel: cream card, ink hairline,
// orange "// eyebrow" mono label. Shared visual language for the Nori pages.

import { cn } from "@/lib/utils";

export function Panel({
  eyebrow,
  title,
  className,
  bodyClassName,
  children,
}: {
  eyebrow?: string;
  title?: string;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm",
        className,
      )}
    >
      {eyebrow && (
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">
          // {eyebrow}
        </p>
      )}
      {title && <h2 className="mt-1 text-lg font-semibold">{title}</h2>}
      <div className={cn((eyebrow || title) && "mt-3", bodyClassName)}>{children}</div>
    </div>
  );
}

export default Panel;
