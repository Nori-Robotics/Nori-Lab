// NORI: Additive file. Hollow coding workspace — layout only, ready for backend
// integration and a future style overhaul. No API calls are wired up yet.

import { useContext, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThemeProviderContext } from "@/contexts/ThemeContext";
import { Play, Square } from "lucide-react";

const CODE_EXTENSIONS = [javascript({ typescript: true })];

const Coding = () => {
  const [prompt, setPrompt] = useState("");
  const [code, setCode] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  // Match the editor's built-in light/dark theme to the app theme.
  const { theme } = useContext(ThemeProviderContext);
  const editorTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  const handleRunStop = () => {
    // TODO: hook up to backend run/stop endpoints.
    setIsRunning((running) => !running);
  };

  const handleSendPrompt = () => {
    // TODO: send prompt to LLM backend and stream the response below.
  };

  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold">Run Nori with code</h1>

      <div className="grid h-[calc(100vh-13rem)] grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Left: prompt input + LLM response */}
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex flex-1 min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// prompt</span>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask something..."
            className="flex-1 resize-none border-[#14131a]/12 bg-[#fffdf7]"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSendPrompt} disabled={!prompt.trim()}
              className="rounded-md bg-[#d98b3d] text-foreground hover:bg-[#c97929]">
              Send
            </Button>
          </div>
        </div>
        <div className="flex flex-1 min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// response</span>
          <div className="flex-1 overflow-y-auto rounded-md border border-[#14131a]/10 bg-[#f3f1e8] p-3 font-mono text-xs text-[#857b6b]">
            LLM responses will appear here.
          </div>
        </div>
      </div>

      {/* Right: code editor + run/stop */}
      <div className="flex h-full min-h-0 flex-col gap-2 rounded-md border border-[#14131a]/10 bg-[#f6f4eb] p-4 text-[#14131a] shadow-sm">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#b06a1c]">// code</span>
        <div className="flex-1 min-h-0 overflow-hidden rounded-md border border-[#14131a]/12">
          <CodeMirror
            value={code}
            onChange={setCode}
            extensions={CODE_EXTENSIONS}
            theme={editorTheme}
            placeholder="// Write code here"
            height="100%"
            style={{ height: "100%" }}
            className="h-full text-sm [&_.cm-editor]:h-full"
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant={isRunning ? "destructive" : "default"}
            onClick={handleRunStop}
            className={isRunning ? undefined : "rounded-md bg-[#8ab135] text-foreground hover:bg-[#4d8754]"}
          >
            {isRunning ? (
              <>
                <Square className="mr-2 h-4 w-4" /> Stop
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" /> Run
              </>
            )}
          </Button>
        </div>
      </div>
      </div>
    </section>
  );
};

export default Coding;
