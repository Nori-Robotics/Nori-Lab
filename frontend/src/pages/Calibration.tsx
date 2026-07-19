import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import LeaderSetup from "@/nori/pages/leader-setup";

const Calibration = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-nori-h0f0e0c text-nori-hf8f4ea">
      <div className="mx-auto max-w-7xl px-3 py-3 sm:px-4">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-3 rounded-md border border-nori-hf5f0e6/10 bg-nori-h171512 text-nori-hd9d1c5 hover:bg-nori-h242019 hover:text-nori-hf8f4ea"
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
