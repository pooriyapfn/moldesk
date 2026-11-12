"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  competitionPath,
  daysUntil,
  formatMilestone,
  isMilestoneUpcoming,
  matchesCompetition,
  milestoneDate,
  type Competition,
  type CompetitionMilestone,
} from "@/lib/competitions";

function Countdown({ milestone, now }: { milestone: CompetitionMilestone; now: number }) {
  if ("day" in milestone) {
    const days = daysUntil(milestone.day, milestone.timeZone, now);
    return (
      <p className="text-3xl font-semibold tracking-tight">
        {days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`}
      </p>
    );
  }

  const seconds = Math.max(0, Math.ceil((Date.parse(milestone.at) - now) / 1000));
  const units = [
    { label: "Days", value: Math.floor(seconds / 86_400) },
    { label: "Hours", value: Math.floor(seconds / 3600) % 24 },
    { label: "Minutes", value: Math.floor(seconds / 60) % 60 },
    { label: "Seconds", value: seconds % 60 },
  ];

  return (
    <dl className="grid grid-cols-4 gap-2">
      {units.map(({ label, value }) => (
        <div key={label} className="flex min-w-0 flex-col-reverse items-center gap-1 rounded-md border border-white/20 bg-white/5 px-1 py-3">
          <dt className="text-xs text-emerald-100/85">{label}</dt>
          <dd className="font-mono text-2xl leading-none font-medium tabular-nums sm:text-3xl">
            {String(value).padStart(2, "0")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CompetitionRow({ competition }: { competition: Competition }) {
  const { milestone } = competition;
  const path = competitionPath(competition.slug);

  return (
    <li className="grid gap-3 px-5 py-5 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6">
      <div className="text-sm">
        <div className="font-mono text-foreground">
          {milestone ? (
            <time dateTime={milestoneDate(milestone)}>{formatMilestone(milestone)}</time>
          ) : (
            "Weekly"
          )}
        </div>
        <p className="mt-1 text-muted">{milestone?.label ?? "Rolling benchmark"}</p>
      </div>
      <div className="min-w-0">
        <h4 className="text-lg leading-snug font-semibold">
          <Link href={path} className="text-foreground hover:text-accent hover:underline">
            {competition.name}
          </Link>
        </h4>
        <p className="mt-1 text-sm leading-relaxed text-muted">{competition.description}</p>
        <ul aria-label="Targets and actions" className="mt-3 flex flex-wrap gap-1.5">
          {competition.targets.map((target) => (
            <li key={target} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-hover">
              {target}
            </li>
          ))}
          {competition.actions.map((action) => (
            <li key={action} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">
              {action}
            </li>
          ))}
        </ul>
      </div>
      {competition.solutions?.length ? (
        <Link href={`${path}#solutions`} className="w-fit text-sm font-medium hover:underline">
          Solutions and results <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </li>
  );
}

export function CompetitionCalendar({
  competitions,
  initialNow,
}: {
  competitions: readonly Competition[];
  initialNow: number;
}) {
  const [now, setNow] = useState(initialNow);
  const [query, setQuery] = useState("");
  const [solutionsOnly, setSolutionsOnly] = useState(false);

  const scheduled = useMemo(() => competitions
    .filter((item): item is Competition & { milestone: CompetitionMilestone } => Boolean(item.milestone))
    .sort((a, b) => Date.parse(milestoneDate(a.milestone)) - Date.parse(milestoneDate(b.milestone))), [competitions]);
  const beforeDeadline = scheduled.filter(({ milestone }) => isMilestoneUpcoming(milestone, now));
  const upcoming = beforeDeadline.filter(({ opensOn, milestone }) => (
    opensOn && daysUntil(opensOn, milestone.timeZone, now) > 0
  ));
  const featured = beforeDeadline[0];
  const featuredDate = featured && milestoneDate(featured.milestone);
  const entry = featured?.entry ?? featured?.reference;
  const preciseCountdown = Boolean(featured && "at" in featured.milestone);

  useEffect(() => {
    if (!featuredDate) return;
    const timer = window.setInterval(() => setNow(Date.now()), preciseCountdown ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  }, [featuredDate, preciseCountdown]);

  const groups = [
    { title: "Upcoming competitions", items: upcoming },
    { title: "Active competitions", items: beforeDeadline.filter((item) => !upcoming.includes(item)) },
    { title: "Ongoing benchmarks", items: competitions.filter((item) => !item.milestone) },
    { title: "Past competitions", items: scheduled.filter((item) => !beforeDeadline.includes(item)).reverse() },
  ].map(({ title, items }) => ({
    title,
    items: items.filter((item) => matchesCompetition(item, query) && (!solutionsOnly || item.solutions?.length)),
  }));
  const resultCount = groups.reduce((total, group) => total + group.items.length, 0);

  return (
    <>
      <section aria-labelledby="next-deadline" className="mt-9 overflow-hidden rounded-xl border border-border">
        <div className="grid gap-7 bg-[#132b24] px-5 py-7 text-white sm:px-8 sm:py-9 md:grid-cols-[minmax(0,1fr)_18rem] md:items-center lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div>
            <h2 id="next-deadline" className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-emerald-200">
              Next deadline
            </h2>
            {featured ? (
              <>
                <h3 className="mt-3 text-[clamp(1.75rem,4vw,2.65rem)] leading-[1.08] font-semibold tracking-tight text-balance">
                  <Link href={competitionPath(featured.slug)} className="text-white hover:text-emerald-100 hover:underline">
                    {featured.name}
                  </Link>
                </h3>
                <p className="mt-3 max-w-lg leading-relaxed text-emerald-50/85">{featured.description}</p>
              </>
            ) : (
              <p className="mt-3 text-2xl font-semibold">No upcoming deadlines on the calendar</p>
            )}
          </div>
          {featured && (
            <div>
              <p className="mb-2 text-sm font-medium text-emerald-100">{featured.milestone.label}</p>
              <Countdown milestone={featured.milestone} now={now} />
              <time dateTime={featuredDate} className="mt-3 block text-sm text-emerald-50/85">
                {formatMilestone(featured.milestone, true)}
              </time>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 bg-white px-5 py-5 sm:px-8">
          <div className="max-w-xl">
            <h3 className="font-semibold">How to start</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {featured?.gettingStarted ?? "Browse ongoing benchmarks or learn from past entries and published solutions."}
            </p>
          </div>
          {entry ? (
            <a
              href={entry.url}
              className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover hover:text-white"
            >
              {entry.label} <span aria-hidden="true">↗</span>
            </a>
          ) : (
            <a href="#calendar" className="text-sm font-medium hover:underline">
              Browse calendar <span aria-hidden="true">↓</span>
            </a>
          )}
        </div>
      </section>

      <section id="calendar" aria-labelledby="calendar-title" className="mt-12 scroll-mt-6 sm:mt-16">
        <h2 id="calendar-title" className="text-3xl font-semibold tracking-tight">Competition calendar</h2>
        <div className="mt-5 flex flex-wrap items-end gap-x-5 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <label htmlFor="competition-search" className="text-sm font-medium">Search competitions</label>
            <input
              id="competition-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, target, or action"
              className="mt-1.5 block w-full rounded-md border border-border bg-white px-3.5 py-2.5 text-base placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={solutionsOnly}
              onChange={(event) => setSolutionsOnly(event.target.checked)}
              className="size-4 accent-accent"
            />
            With solutions or results
          </label>
        </div>
        <p role="status" className="mt-3 text-sm text-muted">
          {resultCount} {resultCount === 1 ? "competition" : "competitions"}
        </p>
        {groups.map(({ title, items }) => items.length > 0 && (
          <div key={title} className="mt-6">
            <h3 className="mb-2 text-base font-semibold">{title}</h3>
            <ul className="divide-y divide-border rounded-lg border border-border bg-white">
              {items.map((competition) => <CompetitionRow key={competition.slug} competition={competition} />)}
            </ul>
          </div>
        ))}
        {resultCount === 0 && (
          <div className="mt-4 rounded-lg border border-border bg-white px-5 py-6">
            <p>No competitions match your search.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSolutionsOnly(false);
              }}
              className="mt-2 cursor-pointer text-sm font-medium text-accent hover:underline"
            >
              Clear search and filters
            </button>
          </div>
        )}
      </section>
    </>
  );
}
