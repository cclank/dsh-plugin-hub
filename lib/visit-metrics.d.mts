export interface VisitCounterEnv {
  VISIT_METRICS?: D1Database;
  VISIT_DISPLAY_MULTIPLIER?: string;
}

export interface VisitCounterRow {
  name: string;
  value: number;
  source: string;
  cutoff_at: string | null;
  updated_at: string;
}

export interface VisitStats {
  available: boolean;
  displayCount: number | null;
  realCount: number | null;
  multiplier: number;
  trackedCount: number | null;
  historicalCount: number | null;
  historicalCutoff: string | null;
  updatedAt: string | null;
  methodology: "root-document-requests";
}

export declare function parseDisplayMultiplier(value: unknown): number;
export declare function buildVisitStats(rows: VisitCounterRow[], multiplierValue: unknown): VisitStats;
export declare function unavailableVisitStats(multiplierValue: unknown): VisitStats;
export declare function incrementVisit(env: VisitCounterEnv): Promise<void>;
export declare function readVisitStats(env: VisitCounterEnv): Promise<VisitStats>;
