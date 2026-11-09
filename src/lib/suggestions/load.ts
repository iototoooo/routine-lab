// 改善提案の画面で使う読み込み（記録と判断の記録を読み、提案を計算する）。一覧・確認画面・分析画面で共通。
import { listDecisions, loadAnalyticsData } from "@/lib/data/api";
import { generateSuggestions, type Decision, type SuggestionResult } from "./rules";
import type { VersionInfo } from "@/lib/analytics/types";

export type LoadedSuggestions = {
  result: SuggestionResult;
  decisions: Decision[];
  names: Map<string, string>;
  versions: VersionInfo[];
};

export async function loadSuggestions(today: string): Promise<LoadedSuggestions> {
  const [data, decisions] = await Promise.all([loadAnalyticsData(today), listDecisions()]);
  return {
    result: generateSuggestions({ facts: data.facts, routines: data.routines, versions: data.versions, decisions, today }),
    decisions,
    names: new Map(data.routines.map((r) => [r.id, r.name])),
    versions: data.versions,
  };
}
