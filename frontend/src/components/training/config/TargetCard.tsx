import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigComponentProps } from "../types";
import { RunnerFlavor } from "@/lib/jobsApi";

interface TargetCardProps extends ConfigComponentProps {
  authenticated: boolean;
  flavors: RunnerFlavor[];
  loading: boolean;
}

const formatHourly = (unitCostUsd: number, unitLabel: string): string => {
  const hourly = unitLabel === "minute" ? unitCostUsd * 60 : unitCostUsd;
  return `$${hourly.toFixed(2)}/hr`;
};

const formatFlavorLine = (f: RunnerFlavor): string => {
  const accel = f.accelerator ? f.accelerator : f.cpu;
  return `${f.pretty_name} · ${accel} · ${formatHourly(f.unit_cost_usd, f.unit_label)}`;
};

const TargetCard: React.FC<TargetCardProps> = ({
  config,
  updateConfig,
  authenticated,
  flavors,
  loading,
}) => {
  const target = config.target;
  const value =
    target.runner === "local" ? "local" : `hf:${target.flavor ?? ""}`;

  const handleChange = (v: string) => {
    if (v === "local") {
      updateConfig("target", { runner: "local" });
    } else if (v.startsWith("hf:")) {
      const flavor = v.slice("hf:".length);
      updateConfig("target", { runner: "hf_cloud", flavor });
    }
  };

  return (
    <Card className="bg-secondary/50 border-border rounded-xl">
      <CardHeader>
        <CardTitle className="text-foreground">Compute target</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-muted-foreground">Run training on</Label>
          <Select value={value} onValueChange={handleChange}>
            <SelectTrigger className="bg-card border-border text-foreground rounded-lg mt-1">
              <SelectValue placeholder={loading ? "Loading…" : "Select target"} />
            </SelectTrigger>
            <SelectContent className="bg-secondary border-border text-foreground">
              <SelectItem value="local">Local — your machine (free)</SelectItem>
              {flavors.map((f) => (
                <SelectItem
                  key={f.name}
                  value={`hf:${f.name}`}
                  disabled={!authenticated}
                >
                  {formatFlavorLine(f)}
                  {!authenticated && (
                    <span className="text-amber-700 ml-2 text-xs">
                      log in to HF
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            Cost shown is per running hour. Final policy uploads to your HF
            account when training completes.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

export default TargetCard;
