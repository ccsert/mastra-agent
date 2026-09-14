import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "../packages/contracts/src/index.ts";
export const EvaluationDataset = z.object({
  name: z.string(),
  version: z.string(),
  synthetic: z.boolean(),
  description: z.string(),
  documents: z
    .array(z.object({ filename: z.string(), content: z.string() }))
    .min(1)
    .max(100),
  cases: z
    .array(
      z.object({
        id: z.string(),
        category: z.string(),
        query: z.string(),
        expected: z.array(z.object({ filename: z.string(), contains: z.string() })),
      }),
    )
    .min(1)
    .max(100),
});
export type EvaluationCase = z.infer<typeof EvaluationDataset>["cases"][number];
export type Evidence = {
  filename: string;
  content: string;
  versionId?: string;
  contentHash: string;
  similarity: number;
  rerankScore: number | null;
};
const normalize = (text: string) => text.replace(/\s+/g, "");
export function scoreEvidence(item: EvaluationCase, hits: Evidence[]) {
  const ranks = item.expected.map((e) =>
    hits.findIndex(
      (h) => h.filename === e.filename && normalize(h.content).includes(normalize(e.contains)),
    ),
  );
  const found = ranks.filter((r) => r >= 0),
    answerable = !!item.expected.length;
  return {
    id: item.id,
    category: item.category,
    query: item.query,
    answerable,
    evidenceRecall: answerable ? found.length / ranks.length : null,
    completeEvidence: answerable ? found.length === ranks.length : null,
    reciprocalRank: answerable ? (found.length ? 1 / (Math.min(...found) + 1) : 0) : null,
    unsupportedCandidates: !answerable ? hits.length : null,
    missing: item.expected.filter((_, i) => ranks[i] < 0),
  };
}
export function summarizeEvidence(rows: ReturnType<typeof scoreEvidence>[]) {
  const answerable = rows.filter((r) => r.answerable),
    absent = rows.filter((r) => !r.answerable);
  return {
    cases: rows.length,
    answerable: answerable.length,
    unanswerable: absent.length,
    completeEvidenceRate: answerable.length
      ? answerable.filter((r) => r.completeEvidence).length / answerable.length
      : null,
    meanEvidenceRecall: answerable.length
      ? answerable.reduce((s, r) => s + (r.evidenceRecall ?? 0), 0) / answerable.length
      : null,
    meanReciprocalRank: answerable.length
      ? answerable.reduce((s, r) => s + (r.reciprocalRank ?? 0), 0) / answerable.length
      : null,
    unanswerableCandidateRate: absent.length
      ? absent.filter((r) => (r.unsupportedCandidates ?? 0) > 0).length / absent.length
      : null,
  };
}
export function datasetDigest(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
export async function retryEvaluationRequest<T>(request: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await request(), attempts: attempt };
    } catch (error) {
      const transient =
        error instanceof Error &&
        ((error instanceof TypeError && error.message === "fetch failed") ||
          error.name === "TimeoutError");
      if (!transient || attempt === 3) throw error;
      await setTimeout(500 * attempt);
    }
  }
}
