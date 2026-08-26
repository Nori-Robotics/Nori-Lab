// NORI: Shared chrome for the standalone auth screens (sign-in / sign-up,
// forgot-password, reset-password).
//
// These three were the last plain shadcn Cards on a flat background in the app —
// the first screen a new customer sees, and the least like the rest of it. This
// pulls them into the house style used by the home hero and the marketplace:
// dot-grid wash, blurred pastel orbs, a sticker eyebrow and a soft rounded card.
//
// The pages keep their own forms and all of their logic; this only wraps them.
import type { ReactNode } from "react";
import { FadeIn } from "@/nori/components/FadeIn";

type Props = {
  /** Sticker-pill line above the title — the friendly bit ("glad you made it"). */
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** The form. */
  children: ReactNode;
  /** Small print under the card (mode switch, "back to sign in"). */
  footer?: ReactNode;
  /**
   * Optional artwork, drawn floating over the card's top-right corner.
   * This is the slot for the robot decal — pass an <img>/<svg> and it lands
   * there without disturbing the form's layout (it is absolutely positioned
   * and click-through).
   */
  decal?: ReactNode;
};

export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
  decal,
}: Props) {
  return (
    // bg-background rather than a hardcoded cream: unlike /nori/model, these
    // screens are reachable with the app in dark mode.
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div
        className="dot-grid pointer-events-none absolute inset-0 opacity-60"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-leaf opacity-70 blur-3xl dark:opacity-75"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-24 top-24 h-64 w-64 rounded-full bg-sticker opacity-60 blur-3xl dark:opacity-70"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-24 left-1/3 h-72 w-72 rounded-full bg-sticker-2 opacity-50 blur-3xl dark:opacity-60"
        aria-hidden
      />

      <main className="relative flex min-h-screen items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <FadeIn>
              <span className="inline-flex -rotate-2 animate-floaty items-center rounded-full bg-sticker px-3 py-1 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ink shadow-soft">
                {eyebrow}
              </span>
            </FadeIn>
            <FadeIn delay={80}>
              <h1 className="mt-4 font-display text-[clamp(1.75rem,4vw,2.25rem)] leading-tight tracking-tight">
                {title}
              </h1>
            </FadeIn>
            {subtitle && (
              <FadeIn delay={150}>
                <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                  {subtitle}
                </p>
              </FadeIn>
            )}
          </div>

          <FadeIn delay={210}>
            <div className="relative rounded-[24px] border border-ink/10 bg-card/85 shadow-soft backdrop-blur">
              {/* Colour along the top edge. The clip lives on this wrapper, not
                  on the card: the card must NOT be overflow-hidden or it would
                  crop the decal, which is positioned to float outside it. The
                  wrapper spans the whole card: a wrapper only as tall as the
                  band forces the browser to scale its 23px corner radius down
                  to the band height, letting the gradient poke past the
                  card's larger curve at the top corners. */}
              <div
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-[23px]"
                aria-hidden
              >
                <div className="h-1.5 w-full bg-gradient-to-r from-leaf via-sticker to-sticker-2" />
              </div>
              {decal && (
                <div
                  className="pointer-events-none absolute -right-4 -top-12 z-10"
                  aria-hidden
                >
                  {decal}
                </div>
              )}
              <div className="p-6 pt-7">{children}</div>
            </div>
          </FadeIn>

          {footer && (
            <FadeIn delay={280}>
              <div className="mt-5 text-center text-sm text-muted-foreground">
                {footer}
              </div>
            </FadeIn>
          )}
        </div>
      </main>
    </div>
  );
}

export default AuthShell;
