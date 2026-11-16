import Link from "next/link";
import { models } from "@/lib/models";
import { Hero } from "./hero";

const FEATURES = [
  {
    title: "Run models",
    body: "Install and run molecular AI models like Boltz-2 and ProteinMPNN without complex setup.",
  },
  {
    title: "Build workflows",
    body: "Connect multiple models into reproducible workflows, with Claude Code, Codex, or YAML.",
  },
  {
    title: "Explore in Studio",
    body: "Visualize workflows, monitor runs, and inspect molecular structures and results in one place.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-[1240px] px-8 pt-[84px] pb-[88px]">
        <Hero />
      </header>

      <section className="border-t border-b border-border bg-white">
        <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center gap-x-11 gap-y-5 px-8 py-9">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted">
              Supported models
            </span>
            {Object.values(models).filter((model) => model.status !== "soon").map((model) => (
              <span
                key={model.slug}
                className="rounded-full border border-accent bg-accent-soft px-4 py-[7px] font-mono text-[13px] text-foreground"
              >
                {model.displayName}{model.status === "beta" && " (Beta)"}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 opacity-45">
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted">
              Coming soon
            </span>
            {Object.values(models).filter((model) => model.status === "soon").map((model) => (
              <span
                key={model.slug}
                className="rounded-full border border-border px-4 py-[7px] font-mono text-[13px] text-muted"
              >
                {model.displayName}
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

      <section className="border-t border-border bg-white">
        <div className="mx-auto w-full max-w-[1240px] px-8 py-14">
          <h2 className="text-2xl font-semibold tracking-tight">From models to complete workflows</h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            Go beyond single predictions. Connect molecular AI models, automate experiments, and explore results in MoleDesk Studio.
          </p>
          <p className="mt-6 text-sm font-semibold">Explore the documentation:</p>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <Link href="/docs/guides/run-boltz-locally" className="text-accent hover:underline">
              Run your first Boltz-2 prediction →
            </Link>
            <Link href="/docs/agent-skills" className="text-accent hover:underline">
              Build a molecular AI workflow with Claude Code →
            </Link>
            <Link href="/docs/cli-usage" className="text-accent hover:underline">
              Visualize and inspect results in MoleDesk Studio →
            </Link>
          </div>
        </div>
      </section>
      <footer className="mt-auto border-t border-border">
        <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-4 px-8 py-7">
          <span className="text-sm text-muted">MoleculeDesk · Open source</span>
          <div className="flex flex-wrap gap-5 text-sm">
            <a href="https://github.com/pooriyapfn/moldesk" className="text-muted hover:text-foreground">
              GitHub
            </a>
            <Link href="/docs" className="text-muted hover:text-foreground">
              Docs
            </Link>
            <Link href="/competitions" className="text-muted hover:text-foreground">
              Competitions
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
