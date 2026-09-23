import Link from "next/link";
import { InstallCommand } from "./install-command";
import { TerminalDemo } from "./terminal-demo";

const FEATURES = [
  {
    title: "Run models",
    body: "Use supported molecular AI models without complex setup.",
  },
  {
    title: "Inspect results",
    body: "Open molecular structures and examine model outputs.",
  },
  {
    title: "Stay in control",
    body: "Keep visibility over your models, inputs, and runs.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-[1240px] px-8 pt-[84px] pb-[88px]">
        <div className="grid items-center gap-16 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
          <div>
            <div className="mb-[26px] font-mono text-[11.5px] uppercase tracking-[0.13em] text-muted">
              MoleculeDesk
            </div>
            <h1 className="max-w-[14ch] text-[clamp(38px,4.6vw,62px)] leading-[1.04] font-semibold tracking-[-0.036em] text-balance">
              Take control of your molecular AI.
            </h1>
            <p className="mt-[26px] max-w-[44ch] text-[clamp(16px,1.4vw,19px)] leading-[1.55] text-muted text-pretty">
              A simpler way to run and inspect molecular AI models while
              keeping control of your data.
            </p>

            <InstallCommand />

            <div className="mt-[18px] flex gap-2.5">
              <a
                href="#github"
                className="rounded-md border border-foreground bg-white px-[22px] py-[11px] text-sm font-medium text-foreground hover:bg-foreground hover:text-white"
              >
                GitHub
              </a>
              <Link
                href="/docs"
                className="rounded-md border border-border bg-transparent px-[22px] py-[11px] text-sm font-medium text-muted hover:border-foreground hover:text-foreground"
              >
                Docs
              </Link>
            </div>
          </div>

          <TerminalDemo />
        </div>
      </header>

      <section className="border-t border-b border-border bg-white">
        <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-11 gap-y-5 px-8 py-9">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted">
              Supported models
            </span>
            {["Boltz", "ProteinMPNN", "LigandMPNN"].map((name) => (
              <span
                key={name}
                className="rounded-full border border-accent bg-accent-soft px-4 py-[7px] font-mono text-[13px] text-foreground"
              >
                {name}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 opacity-45">
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted">
              Coming soon
            </span>
            {["AlphaFold", "ColabFold", "Chai"].map((name) => (
              <span
                key={name}
                className="rounded-full border border-border px-4 py-[7px] font-mono text-[13px] text-muted"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1240px] px-8 py-[88px]">
        <div className="grid gap-12 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          {FEATURES.map((feature) => (
            <div key={feature.title}>
              <h2 className="mb-2.5 text-[17px] font-semibold tracking-[-0.01em]">
                {feature.title}
              </h2>
              <p className="text-[15px] leading-[1.6] text-muted text-pretty">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-auto border-t border-border">
        <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-4 px-8 py-7">
          <span className="text-sm text-muted">MoleculeDesk · Open source</span>
          <div className="flex gap-5 text-sm">
            <a href="#github" className="text-muted hover:text-foreground">
              GitHub
            </a>
            <Link href="/docs" className="text-muted hover:text-foreground">
              Docs
            </Link>
            <a href="#license" className="text-muted hover:text-foreground">
              License
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
