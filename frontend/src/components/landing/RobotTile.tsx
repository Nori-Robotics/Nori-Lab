import React, { useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RobotRecord } from "@/hooks/useRobots";
import RobotSelector from "./RobotSelector";

interface RobotTileProps {
  robot: RobotRecord | null;
  selectedName: string | null;
  availableNames: string[];
  isLoading: boolean;
  onSelect: (name: string) => void;
  onCreateNew: (name: string) => Promise<boolean>;
  onConfigure: (name: string) => void;
  onTeleop: (robot: RobotRecord) => void;
  onDelete: (name: string) => void;
}

const RobotTile: React.FC<RobotTileProps> = ({
  robot,
  selectedName,
  availableNames,
  isLoading,
  onSelect,
  onCreateNew,
  onConfigure,
  onTeleop,
  onDelete,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = robot ? (robot.is_clean ? "Ready" : "Needs configuration") : null;
  const teleopDisabled = !robot || !robot.is_clean;

  return (
    <div className="bg-secondary rounded-lg border border-border p-3 flex flex-col gap-2 relative">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <RobotSelector
            selectedName={selectedName}
            availableNames={availableNames}
            onSelect={onSelect}
            onCreateNew={onCreateNew}
            isLoading={isLoading}
          />
        </div>
        {status && (
          <p
            className={`text-xs truncate shrink-0 ${
              robot!.is_clean ? "text-green-600" : "text-amber-600"
            }`}
          >
            {status}
          </p>
        )}
        {robot && (
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => onConfigure(robot.name)}
                  aria-label="Configure"
                >
                  <Settings className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Configure (calibrate)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-100"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete robot"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete robot config</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {robot && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="w-full">
              <Button
                onClick={() => onTeleop(robot)}
                disabled={teleopDisabled}
                className={`w-full ${
                  teleopDisabled
                    ? "bg-red-500/30 hover:bg-red-500/30 text-red-700 cursor-not-allowed"
                    : "bg-yellow-500 hover:bg-yellow-600 text-foreground"
                }`}
              >
                Teleoperation
              </Button>
            </div>
          </TooltipTrigger>
          {teleopDisabled && (
            <TooltipContent>Configure the robot first.</TooltipContent>
          )}
        </Tooltip>
      )}

      {robot && (
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent className="bg-card border-border text-foreground">
            <DialogHeader>
              <DialogTitle>Delete robot config?</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                This deletes the robot config file from disk. Calibration files
                are not removed. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="border-border text-muted-foreground"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                className="bg-red-500 hover:bg-red-600 text-white"
                onClick={async () => {
                  setConfirmDelete(false);
                  await onDelete(robot.name);
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default RobotTile;
