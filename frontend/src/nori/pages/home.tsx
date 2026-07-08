// NORI: Additive file. Landing page for /nori — a short get-started overview in the
// NoriWebsite visual language (paper/ink, // eyebrows, display headline, tinted
// feature cards) pointing at the app's three main surfaces.

import { Link } from "react-router-dom";

const FEATURES: {
  n: string;
  title: string;
  body: string;
  to: string;
  tint: string;
}[] = [
  {
    n: "01",
    title: "Teleoperate",
    body: "Drive your robot live over the internet — with the keyboard, the physical dual leader arms, or a VR headset. Video, audio, and telemetry included.",
    to: "/nori/remote",
    tint: "bg-sticker",
  },
  {
    n: "02",
    title: "Run it with code",
    body: "Describe a task in plain words and let the built-in LLM write a routine for you — or write one yourself, then run it against the live robot.",
    to: "/nori/coding",
    tint: "bg-leaf",
  },
  {
    n: "03",
    title: "Train",
    body: "Turn your teleop recordings into policies: launch cloud training, watch it live, and install the result from the marketplace.",
    to: "/nori/training",
    tint: "bg-sticker-2",
  },
];

const Home = () => (
  <section>
    {/* HERO — the marketplace-style wash: dot grid + pastel blobs behind a display headline. */}
    <div className="relative overflow-hidden rounded-[24px] border border-border bg-background px-5 py-8 md:px-8 md:py-10">
      <div className="dot-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div
        className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-leaf opacity-70 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-12 top-10 h-40 w-40 rounded-full bg-sticker opacity-60 blur-3xl"
        aria-hidden
      />

      <div className="relative">
        <span className="eyebrow">{"// welcome"}</span>
        <h1 className="mt-4 font-display text-balance text-[clamp(2rem,4.5vw,3rem)] leading-[0.95] tracking-tight">
          Your robot, ready.
        </h1>
        <p className="mt-3 max-w-2xl text-pretty text-[15px] leading-relaxed text-muted-foreground">
          This is the Nori app — everything you need to drive, program, and teach your
          robot lives here. Start with any of the three below.
        </p>
      </div>
    </div>

    {/* FEATURES — the website's three-step tinted card rhythm, linking into the app. */}
    <div className="mt-6 grid gap-4 md:grid-cols-3">
      {FEATURES.map((f) => (
        <Link
          key={f.n}
          to={f.to}
          className={`group flex h-full flex-col rounded-[24px] border border-border p-6 transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop ${f.tint}`}
        >
          <span className="w-fit rounded-full border border-ink/20 bg-background px-2.5 py-0.5 font-mono text-[11px] font-semibold tracking-[0.14em] text-ink">
            {f.n}
          </span>
          <h3 className="mt-5 font-display text-[1.7rem] font-normal leading-[1] tracking-tight text-ink">
            {f.title}
          </h3>
          <p className="mt-3 flex-1 text-[14px] leading-relaxed text-ink-2">{f.body}</p>
          <span className="eyebrow mt-5 text-ink">open →</span>
        </Link>
      ))}
    </div>

    <p className="eyebrow mt-8">
      {"// pair your robot under Pairing, manage your account under Account"}
    </p>
  </section>
);

export default Home;
