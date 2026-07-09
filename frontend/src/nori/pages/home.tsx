// NORI: Additive file. Landing page for /nori — a short get-started overview in the
// NoriWebsite visual language (paper/ink, // eyebrows, display headline, tinted
// feature cards) pointing at the app's three main surfaces.

import { Link } from "react-router-dom";
import { FadeIn } from "@/nori/components/FadeIn";
import { useNori } from "@/nori/NoriContext";

/** "NORI-L2-0042" -> "Nori L2". Unknown serial formats fall back to the generic name. */
function modelFromSerial(serial: string): string {
  const m = /^NORI-(L\d+)/i.exec(serial.trim());
  return m ? `Nori ${m[1].toUpperCase()}` : "Nori robot";
}

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
    body: "Drive your robot live with your keyboard, physical leader arm, or VR headset. Video, audio, and telemetry included.",
    to: "/nori/remote",
    tint: "bg-sticker",
  },
  {
    n: "02",
    title: "Run it with code",
    body: "Describe a task in plain words and let the built-in LLM write a routine (or write one yourself!) then run it against the live robot.",
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

const Home = () => {
  const { customer, activeRobotSerial, provisioning } = useNori();
  const serial = activeRobotSerial ?? customer?.robot_serial_number ?? null;
  const paired = !!customer?.is_paired && !!serial;

  return (
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
        <FadeIn>
          <span className="eyebrow">{"// welcome"}</span>
        </FadeIn>
        <FadeIn delay={60}>
          <h1 className="mt-4 font-display text-balance text-[clamp(2rem,4.5vw,3rem)] leading-[0.95] tracking-tight">
            Your robot, ready.
          </h1>
        </FadeIn>
        <FadeIn delay={140}>
          <p className="mt-3 max-w-2xl text-pretty text-[15px] leading-relaxed text-muted-foreground">
            This is the official Nori Lab app: everything you need to drive, program, and teach your robot lives here. 
            Get started below.
          </p>
        </FadeIn>
      </div>
    </div>

    {/* ROBOT — pairing status: a nudge to pair, or the active robot + its serial. */}
    <FadeIn delay={200}>
    <Link
      to="/nori/pairing"
      className="group mt-4 flex items-center gap-6 overflow-hidden rounded-[24px] border border-border bg-background p-6 transition-[transform,box-shadow] duration-200 ease-bounce hover:-translate-y-1 hover:shadow-pop md:px-8"
    >
      <div className="min-w-0 flex-1">
        <span className="eyebrow">{paired ? "// your robot" : "// get set up"}</span>
        <h2 className="mt-3 font-display text-[1.7rem] font-normal leading-[1] tracking-tight text-ink">
          {paired ? modelFromSerial(serial!) : "Pair your robot"}
        </h2>
        {paired ? (
          <p className="mt-3 text-[14px] leading-relaxed text-ink-2">
            <span className="rounded-full border border-ink/20 bg-background px-2.5 py-0.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink">
              {serial}
            </span>{" "}
            is linked to this account and ready to connect.
          </p>
        ) : (
          <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-ink-2">
            {provisioning
              ? "Checking your account…"
              : "No robot is linked to this account yet. Pair yours with the serial number on the sticker under the base — it takes a minute."}
          </p>
        )}
        <span className="eyebrow mt-5 block text-ink">
          {paired ? "manage pairing →" : "pair now →"}
        </span>
      </div>
      <img
        src="/images/nori-l2.png"
        alt="Nori L2 robot"
        className="mr-4 h-36 w-auto shrink-0 transition-transform duration-200 ease-bounce group-hover:scale-[1.03] md:mr-10 md:h-44"
      />
    </Link>
    </FadeIn>

    {/* FEATURES — the website's three-step tinted card rhythm, linking into the app. */}
    <div className="mt-6 grid gap-4 md:grid-cols-3">
      {FEATURES.map((f, i) => (
        <FadeIn key={f.n} delay={260 + i * 80} className="h-full">
        <Link
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
        </FadeIn>
      ))}
    </div>

    <FadeIn delay={480}>
      <p className="eyebrow mt-8">{"// manage your account under Account"}</p>
    </FadeIn>
  </section>
  );
};

export default Home;
