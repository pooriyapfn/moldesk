export type CompetitionMilestone = {
  label: string;
  timeZone: string;
} & ({ at: string } | { day: string });

type Resource = { label: string; url: string };

export type Competition = {
  slug: string;
  name: string;
  organizer: string;
  description: string;
  targets: readonly string[];
  actions: readonly string[];
  reference: Resource;
  opensOn?: string;
  milestone?: CompetitionMilestone;
  gettingStarted: string;
  entry?: Resource;
  solutions?: readonly (Resource & { description: string })[];
};

export function competitionPath(slug: string) {
  return `/competitions/${slug}`;
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replaceAll("α", "alpha").replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchesCompetition(competition: Competition, query: string) {
  const terms = query.trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
  const fields = [
    competition.name,
    competition.slug,
    competition.organizer,
    ...competition.targets,
    ...competition.actions,
  ].map(normalizeSearch);
  return terms.every((term) => fields.some((field) => field.includes(term)));
}

const dayInMs = 86_400_000;

export function daysUntil(day: string, timeZone: string, now: number) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = `${date.year}-${date.month}-${date.day}`;
  return (Date.parse(day) - Date.parse(today)) / dayInMs;
}

export function isMilestoneUpcoming(milestone: CompetitionMilestone, now: number) {
  return "at" in milestone
    ? Date.parse(milestone.at) > now
    : daysUntil(milestone.day, milestone.timeZone, now) >= 0;
}

export function milestoneDate(milestone: CompetitionMilestone) {
  return "at" in milestone ? milestone.at : milestone.day;
}

export function formatMilestone(milestone: CompetitionMilestone, includeTime = false) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "at" in milestone ? milestone.timeZone : "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime && "at" in milestone
      ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : {}),
  }).format(new Date(milestoneDate(milestone)));
}
