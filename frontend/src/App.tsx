import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { UrdfProvider } from "@/contexts/UrdfContext";
import { DragAndDropProvider } from "@/contexts/DragAndDropContext";
import { Toaster } from "@/components/ui/toaster";
import Landing from "@/pages/Landing";
import Teleoperation from "@/pages/Teleoperation";
import Calibration from "@/pages/Calibration";
import Recording from "@/pages/Recording";
import Training from "@/pages/Training";
import Inference from "@/pages/Inference";
import EditDataset from "@/pages/EditDataset";
import Upload from "@/pages/Upload";

import NotFound from "@/pages/NotFound";
import SingleTabGuard from "@/components/SingleTabGuard";
import TeleopStopNotice from "@/components/TeleopStopNotice";
import UpdateNotice from "@/components/UpdateNotice";
// NORI: additive Nori laptop-app surface (all under /nori/*; no upstream routes touched).
import { NoriProvider } from "@/nori/NoriContext";
import { TeleopSessionProvider } from "@/nori/TeleopSessionContext";
import NoriLayout from "@/nori/components/NoriLayout";
import SignIn from "@/nori/pages/sign-in";
import Account from "@/nori/pages/account";
import Pairing from "@/nori/pages/pairing";
import Marketplace from "@/nori/pages/marketplace";
import TrainingHistory from "@/nori/pages/training-history";
import Remote from "@/nori/pages/remote";
import LeaderSetup from "@/nori/pages/leader-setup";
import NoriCoding from "@/nori/pages/coding";
import NoriTraining from "@/nori/pages/training";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { ApiProvider } from "./contexts/ApiContext";
import { HfAuthProvider } from "./contexts/HfAuthContext";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider defaultTheme="light" storageKey="nori-ui-theme">
          <ApiProvider>
            <HfAuthProvider>
              <UrdfProvider>
                <DragAndDropProvider>
                  <BrowserRouter>
                    <SingleTabGuard>
                      <TeleopStopNotice />
                      <UpdateNotice />
                      <Routes>
                        {/* NORI: start on the Nori app; the upstream LeLab landing lives at /lelab. */}
                        <Route path="/" element={<Navigate to="/nori" replace />} />
                        <Route path="/lelab" element={<Landing />} />
                        <Route path="/teleoperation" element={<Teleoperation />} />
                        <Route path="/recording" element={<Recording />} />
                        <Route path="/upload" element={<Upload />} />
                        <Route path="/training" element={<Training />} />
                        <Route path="/training/:jobId" element={<Training />} />
                        <Route path="/inference" element={<Inference />} />
                        <Route path="/calibration" element={<Calibration />} />
                        <Route path="/edit-dataset" element={<EditDataset />} />

                        {/* NORI: Nori app routes, isolated under a NoriProvider + layout. */}
                        <Route path="/nori/sign-in" element={<NoriProvider><SignIn /></NoriProvider>} />
                        <Route
                          path="/nori"
                          element={
                            <NoriProvider>
                              <TeleopSessionProvider>
                                <NoriLayout />
                              </TeleopSessionProvider>
                            </NoriProvider>
                          }
                        >
                          <Route index element={<Account />} />
                          <Route path="account" element={<Account />} />
                          <Route path="coding" element={<NoriCoding />} />
                          <Route path="training" element={<NoriTraining />} />
                          <Route path="training/:jobId" element={<NoriTraining />} />
                          <Route path="remote" element={<Remote />} />
                          <Route path="leader-setup" element={<LeaderSetup />} />
                          <Route path="pairing" element={<Pairing />} />
                          <Route path="marketplace" element={<Marketplace />} />
                          <Route path="training-history" element={<TrainingHistory />} />
                        </Route>

                        <Route path="*" element={<NotFound />} />
                      </Routes>
                    </SingleTabGuard>
                    <Toaster />
                  </BrowserRouter>
                </DragAndDropProvider>
              </UrdfProvider>
            </HfAuthProvider>
          </ApiProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
