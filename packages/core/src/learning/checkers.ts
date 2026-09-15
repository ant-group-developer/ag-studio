import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelBriefSchema, TopicProposalSchema, type Checker, type StateStore } from "@harness/contracts";

const skip = (reason: string) => ({ verdict: "skip" as const, evidence: { reason } });

function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** lowercase, trim, collapse internal whitespace -- the normalization the brief specifies for duplicate
 * topic detection. */
function normalizeTopic(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * `topics-valid` (spec §4.2): validates a `topic_proposal` output against `TopicProposalSchema`, then (when
 * the run declared a `channel_brief` input) rejects any topic that duplicates one of that channel's open
 * requests or one of its 20 most recent committed package titles. Without a `channel_brief` input, only the
 * schema check runs -- there is nothing to compare against.
 */
export function learningCheckers(d: { store: StateStore }): Checker[] {
  const topicsValid: Checker = {
    id: "topics-valid",
    version: "1.0.0",
    async check(input) {
      const outputs = input.result.outputs.filter((o) => o.type === "topic_proposal");
      if (outputs.length === 0) return skip("no matching output");

      for (const o of outputs) {
        const path = join(input.workspaceDir, o.path);
        const json = readJson(path);
        if (!json.ok) return { verdict: "fail", evidence: { path: o.path, reason: "unreadable", error: json.reason } };
        const parsed = TopicProposalSchema.safeParse(json.value);
        if (!parsed.success) {
          return { verdict: "fail", evidence: { path: o.path, reason: "invalid topic proposal", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }

        const briefInput = input.request.inputs.find((i) => i.type === "channel_brief");
        if (!briefInput) continue;

        const briefPath = join(input.workspaceDir, briefInput.path);
        const briefJson = readJson(briefPath);
        if (!briefJson.ok) return { verdict: "fail", evidence: { path: briefInput.path, reason: "channel_brief unreadable", error: briefJson.reason } };
        const briefParsed = ChannelBriefSchema.safeParse(briefJson.value);
        if (!briefParsed.success) {
          return { verdict: "fail", evidence: { path: briefInput.path, reason: "invalid channel_brief", issues: briefParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
        }
        const brief = briefParsed.data;

        const seen = new Set<string>(brief.open_requests.map((r) => normalizeTopic(r.topic)));
        const recentPackages = [...d.store.listChannelPackages({ channel_id: brief.channel.channel_id, status: "committed" })]
          .sort((a, b) => b.episode_no - a.episode_no)
          .slice(0, 20);
        for (const pkg of recentPackages) seen.add(normalizeTopic(pkg.metadata.title));

        const duplicates = parsed.data.topics.map((t) => t.topic).filter((topic) => seen.has(normalizeTopic(topic)));
        if (duplicates.length > 0) return { verdict: "fail", evidence: { path: o.path, duplicates } };
      }

      return { verdict: "pass", evidence: {} };
    },
  };

  return [topicsValid];
}
