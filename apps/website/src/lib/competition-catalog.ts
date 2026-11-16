import snapshot from "@/generated/competitions.json";
import type { Competition } from "./competitions";

type CompetitionCatalog = {
  revision: string;
  competitions: Array<{ summary: Competition; guide: string; lastVerified: string }>;
};

export const competitionCatalog: CompetitionCatalog = snapshot;
export const competitionSummaries = competitionCatalog.competitions.map(({ summary }) => summary);
export const competitionRepository = "https://github.com/pooriyapfn/bio-challenges";
