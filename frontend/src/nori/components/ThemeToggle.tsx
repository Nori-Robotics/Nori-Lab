// NORI: Additive. A fixed light/dark switch pinned to the bottom-right corner,
// on every page. Drives the existing ThemeProvider (contexts/ThemeContext),
// which toggles the `.dark` class on <html> + persists to localStorage. The
// shadcn CSS vars and the generated `--nori-*` palette tokens both flip off
// that class, so one click re-themes the whole app.
import { useContext, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { ThemeProviderContext } from "@/contexts/ThemeContext";

function prefersDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useContext(ThemeProviderContext);

  // Resolve the *effective* mode (theme may be "system").
  const [systemDark, setSystemDark] = useState(prefersDark);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const isDark = theme === "dark" || (theme === "system" && systemDark);

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="fixed bottom-4 right-4 z-[100] flex h-11 w-11 items-center justify-center
                 rounded-full border border-border bg-card text-foreground shadow-lg
                 transition-colors hover:text-nori-hb06a1c hover:border-nori-hb06a1c
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
