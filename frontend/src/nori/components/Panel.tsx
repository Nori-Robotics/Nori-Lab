// NORI: Additive file. Warm leader-setup-style panel: cream card, ink hairline,
// orange "// eyebrow" mono label. Shared visual language for the Nori pages.

import { cn } from "@/lib/utils";

export function Panel({
  eyebrow,
  title,
  titleExtra,
  className,
  bodyClassName,
  children,
}: {
  eyebrow?: string;
  title?: string;
  titleExtra?: React.ReactNode; // rendered inline after the title (e.g. a HelpTip)
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-nori-h14131a/10 bg-nori-hf6f4eb p-4 text-nori-h14131a shadow-sm",
        className,
      )}
    >
      {eyebrow && (
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-nori-hb06a1c">
          // {eyebrow}
        </p>
      )}
      {title && (
        <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold">
          {title}
          {titleExtra}
        </h2>
      )}
      <div className={cn((eyebrow || title) && "mt-3", bodyClassName)}>{children}</div>
    </div>
  );
}

export default Panel;
