import React from "react";
import { useNavigate } from "react-router-dom";
import { Bot } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { RobotRecord } from "@/hooks/useRobots";
import RobotTile from "./RobotTile";
import AddRobotPicker from "./AddRobotPicker";

interface RobotConfigManagerProps {
  visibleRecords: RobotRecord[];
  hiddenNames: string[];
  isLoading: boolean;
  addToSession: (name: string) => void;
  removeFromSession: (name: string) => void;
  createRobot: (name: string) => Promise<boolean>;
  deleteRobot: (name: string) => Promise<boolean>;
}

const RobotConfigManager: React.FC<RobotConfigManagerProps> = ({
  visibleRecords,
  hiddenNames,
  isLoading,
  addToSession,
  removeFromSession,
  createRobot,
  deleteRobot,
}) => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const handleConfigure = (name: string) => {
    navigate("/calibration", { state: { robot_name: name } });
  };

  const handleTeleop = async (robot: RobotRecord) => {
    try {
      const res = await fetchWithHeaders(`${baseUrl}/move-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leader_port: robot.leader_port,
          follower_port: robot.follower_port,
          leader_config: robot.leader_config,
          follower_config: robot.follower_config,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({
          title: "Teleoperation Started",
          description: data.message || `Started teleoperation for ${robot.name}.`,
        });
        navigate("/teleoperation");
      } else {
        toast({
          title: "Error Starting Teleoperation",
          description: data.message || "Failed to start.",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <AddRobotPicker
        hiddenNames={hiddenNames}
        onAddExisting={addToSession}
        onCreateNew={createRobot}
        isLoading={isLoading}
      />

      {visibleRecords.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visibleRecords.map((r) => (
            <RobotTile
              key={r.name}
              robot={r}
              onConfigure={handleConfigure}
              onTeleop={handleTeleop}
              onRemoveFromSession={removeFromSession}
              onDelete={deleteRobot}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">
          <Bot className="w-12 h-12 mx-auto mb-4 text-gray-600" />
          <p>No robots configured. Add one to get started.</p>
        </div>
      )}
    </div>
  );
};

export default RobotConfigManager;
