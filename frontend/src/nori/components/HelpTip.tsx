// NORI: Additive file. Hover (?) explainer — the RailHeightHelp pattern (TeleopStatus.tsx)
// generalized, so any label can carry a short tooltip without repeating the trigger markup.

import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-[#857b6b] hover:text-[#14131a]" aria-label={label}>
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

export default HelpTip;
