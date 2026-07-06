import React from "react";
import { Link } from "react-router-dom";
import HfAuthChip from "./HfAuthChip";

const LandingTopBar: React.FC = () => {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <img
            src="/nori-logo.png"
            alt="Nori"
            className="h-7 w-7"
          />
          <span className="text-base font-semibold tracking-tight text-foreground">
            LeLab
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* NORI: entry point into the Nori laptop-app surface (all under /nori/*). */}
          <Link
            to="/nori/account"
            className="rounded-md border border-border px-3 py-1 text-sm font-medium text-foreground hover:bg-secondary hover:text-foreground"
          >
            Nori
          </Link>
          <HfAuthChip />
        </div>
      </div>
    </header>
  );
};

export default LandingTopBar;
