// Standard pill toggle, Skill Hub style: rounded-full outline, active fills solid
// ink, inactive gets a slight tint on hover. Use for mode/filter strips so they
// look the same on every page (marketplace source filters, remote control modes…).

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type PillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  size?: "default" | "sm";
};

const Pill = forwardRef<HTMLButtonElement, PillProps>(
  ({ active = false, size = "default", className, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "rounded-full border font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "px-3 py-1 text-xs" : "px-3.5 py-1.5 text-[13px]",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-foreground hover:bg-foreground/5",
        className
      )}
      {...props}
    />
  )
);
Pill.displayName = "Pill";

export { Pill };
