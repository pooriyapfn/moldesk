import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { competitionCatalog, competitionRepository, competitionSummaries } from "@/lib/competition-catalog";
import { competitionPath, formatMilestone, milestoneDate } from "@/lib/competitions";

export const dynamicParams = false;

export function generateStaticParams() {
  return competitionSummaries.map(({ slug }) => ({ slug }));
}

type CompetitionPageProps = { params: Promise<{ slug: string }> };

async function getCompetition(params: CompetitionPageProps["params"]) {
  const { slug } = await params;
  const competition = competitionCatalog.competitions.find(({ summary }) => summary.slug === slug);
  if (!competition) notFound();
  return competition;
}

export async function generateMetadata({ params }: CompetitionPageProps): Promise<Metadata> {
  const { summary: { name, description, slug } } = await getCompetition(params);
  const title = `${name} — MoleculeDesk Competitions`;
  const url = competitionPath(slug);

  return { title, description, alternates: { canonical: url }, openGraph: { title, description, url } };
}

export default async function CompetitionPage({ params }: CompetitionPageProps) {
  const { summary: competition, guide, lastVerified } = await getCompetition(params);
  const { milestone, reference, entry, solutions } = competition;
  const readmePath = `${competitionCatalog.revision}/competitions/${competition.slug}/README.md`;
  const githubReadme = `${competitionRepository}/blob/${readmePath}`;

  return (
    <main className="mx-auto w-full max-w-[1120px] px-5 pt-9 pb-20 sm:px-8 sm:pt-12">
      <Link href="/competitions#calendar" className="text-sm font-medium hover:underline">
        <span aria-hidden="true">← </span>Competition calendar
      </Link>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-14">
        <div>
          <p className="text-sm font-medium text-muted">{competition.organizer}</p>
          <h1 className="mt-2 text-[clamp(2.25rem,5.5vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.04em] text-balance">
            {competition.name}
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">{competition.description}</p>
          <a
            href={reference.url}
            className="mt-6 inline-block rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover hover:text-white"
          >
            {reference.label} <span aria-hidden="true">↗</span>
          </a>
          <a href={githubReadme} className="mt-3 block w-fit text-sm font-medium hover:underline">
            View this entry on GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>

        <dl className="divide-y divide-border rounded-lg border border-border bg-white px-5">
          <div className="py-4">
            <dt className="text-sm font-medium text-muted">{milestone?.label ?? "Schedule"}</dt>
            <dd className="mt-1 font-medium">
              {milestone ? (
                <time dateTime={milestoneDate(milestone)}>{formatMilestone(milestone, true)}</time>
              ) : (
                "Weekly evaluations"
              )}
            </dd>
          </div>
          <div className="py-4">
            <dt className="text-sm font-medium text-muted">Targets</dt>
            <dd className="mt-1">{competition.targets.join(", ")}</dd>
          </div>
          <div className="py-4">
            <dt className="text-sm font-medium text-muted">Actions</dt>
            <dd className="mt-1">{competition.actions.join(", ")}</dd>
          </div>
          <div className="py-4">
            <dt className="text-sm font-medium text-muted">Source last verified</dt>
            <dd className="mt-1"><time dateTime={lastVerified}>{lastVerified}</time></dd>
          </div>
        </dl>
      </div>

      <section aria-labelledby="getting-started" className="mt-10 border-t border-border pt-7">
        <h2 id="getting-started" className="text-2xl font-semibold tracking-tight">How to start</h2>
        <div className="prose prose-neutral mt-2 max-w-2xl prose-p:text-muted prose-a:text-accent">
          <Markdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            urlTransform={(url, key) => {
              const safeUrl = defaultUrlTransform(url);
              if (!safeUrl || safeUrl.startsWith("#")) return safeUrl;
              const base = key === "src"
                ? `https://raw.githubusercontent.com/pooriyapfn/bio-challenges/${readmePath}`
                : githubReadme;
              try {
                return new URL(safeUrl, base).href;
              } catch {
                return "";
              }
            }}
          >
            {guide}
          </Markdown>
        </div>
        {entry && (
          <a href={entry.url} className="mt-3 inline-block text-sm font-medium hover:underline">
            {entry.label} <span aria-hidden="true">↗</span>
          </a>
        )}
      </section>

      <section id="solutions" aria-labelledby="solutions-title" className="mt-8 scroll-mt-6 border-t border-border pt-7">
        <h2 id="solutions-title" className="text-2xl font-semibold tracking-tight">Solutions and results</h2>
        {solutions?.length ? (
          <ul className="mt-3 max-w-2xl divide-y divide-border rounded-lg border border-border bg-white">
            {solutions.map(({ label, url, description }) => (
              <li key={url} className="px-5 py-4">
                <a href={url} className="font-medium hover:underline">
                  {label} <span aria-hidden="true">↗</span>
                </a>
                <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-muted">No solutions or results are listed yet.</p>
        )}
      </section>

      <section aria-labelledby="workflow-title" className="mt-8 rounded-lg border border-border bg-accent-soft px-5 py-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="workflow-title" className="text-xl font-semibold">MoleculeDesk workflows</h2>
          <span className="text-sm font-medium text-accent-hover">Coming soon</span>
        </div>
        <p className="mt-2 text-muted">Competition-specific workflow suggestions will appear here after launch.</p>
      </section>
    </main>
  );
}
