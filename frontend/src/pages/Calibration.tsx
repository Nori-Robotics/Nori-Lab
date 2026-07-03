import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import LeaderSetup from "@/nori/pages/leader-setup";

const Calibration = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0f0e0c] text-[#f8f4ea]">
      <div className="mx-auto max-w-7xl px-3 py-3 sm:px-4">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-3 rounded-md border border-[#f5f0e6]/10 bg-[#171512] text-[#d9d1c5] hover:bg-[#242019] hover:text-[#f8f4ea]"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          back
        </Button>
        <LeaderSetup />
      </div>
    </div>
  );
};

export default Calibration;
