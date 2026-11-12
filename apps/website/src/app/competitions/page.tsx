import type { Metadata } from "next";
import { connection } from "next/server";
import { competitionCatalog, competitionRepository, competitionSummaries } from "@/lib/competition-catalog";
import { CompetitionCalendar } from "./competition-calendar";

const title = "Biology Competitions — MoleculeDesk";
const description =
  "Find biology competitions by name, target, or action. Track deadlines, learn how to enter, and explore published solutions.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/competitions" },
  openGraph: { title, description, url: "/competitions" },
};

export default async function CompetitionsPage() {
  await connection();
  // eslint-disable-next-line react-hooks/purity -- Read the clock after the server receives a request.
  const initialNow = Date.now();

  return (
    <main className="mx-auto w-full max-w-[1120px] px-5 pt-12 pb-20 sm:px-8 sm:pt-16">
      <h1 className="text-[clamp(2.5rem,6vw,4rem)] leading-[1.05] font-semibold tracking-[-0.045em] text-balance">
        Biology competitions
      </h1>
      <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
        Find your next challenge, track deadlines, and explore published solutions.
      </p>
      <CompetitionCalendar competitions={competitionSummaries} initialNow={initialNow} />
      <a href={`${competitionRepository}/blob/${competitionCatalog.revision}/CONTRIBUTING.md`} className="mt-8 inline-block text-sm font-medium hover:underline">
        Contribute a competition on GitHub <span aria-hidden="true">↗</span>
      </a>
    </main>
  );
}
