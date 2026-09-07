export interface ScoreInput {
  followerCount: number | null;
  diggCount: number;
  collectCount: number | null;
  commentCount: number | null;
  publishedAt: Date | null;
  title: string;
  transcript: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const AI_TERMS = /AI|人工智能|大模型|ChatGPT|Claude|Codex|提示词|工作流|教程|转行|入门|实操|工具/i;

export function scoreCandidate(input: ScoreInput) {
  const followers = Math.max(1, input.followerCount ?? 10_000);
  const viral = clamp((input.diggCount / followers) * 70);
  const ageHours = input.publishedAt ? Math.max(1, (Date.now() - input.publishedAt.getTime()) / 3_600_000) : 168;
  const velocity = clamp((input.diggCount / ageHours) / 30 * 100);
  const collect = input.collectCount == null ? null : clamp((input.collectCount / Math.max(1, input.diggCount)) * 500);
  const discuss = input.commentCount == null ? null : clamp((input.commentCount / Math.max(1, input.diggCount)) * 1000);
  const match = AI_TERMS.test(`${input.title} ${input.transcript}`) ? 90 : 45;
  const originality = input.transcript.length >= 200 ? 75 : 55;
  const freshness = clamp(100 - (ageHours / 168) * 100);
  const dimensions = [
    ["viral", viral, 20], ["velocity", velocity, 15], ["collect", collect, 20],
    ["discuss", discuss, 10], ["match", match, 20], ["originality", originality, 10], ["freshness", freshness, 5],
  ] as const;
  const available = dimensions.filter(([, value]) => value != null);
  const totalWeight = available.reduce((sum, [, , weight]) => sum + weight, 0);
  const score = available.reduce((sum, [, value, weight]) => sum + Number(value) * weight / totalWeight, 0);
  return {
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries(dimensions.map(([key, value]) => [key, value == null ? null : Math.round(value * 10) / 10])),
    level: score >= 80 ? "立即跟进" : score >= 65 ? "可储备" : score >= 50 ? "仅供参考" : "不建议",
  };
}
