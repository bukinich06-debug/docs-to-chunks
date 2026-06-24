export interface ICoverageAnalysisResult {
  coveragePercent: number;
  summary: string;
  coveredTopics: string[];
  missingTopics: string[];
  intentionallyExcluded: string[];
  notes?: string;
}
