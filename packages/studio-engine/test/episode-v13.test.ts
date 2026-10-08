/**
 * Episode 1.3.0 (chat first): build-timeline -> [approve-timeline] -> youtube-kit -> [approve-youtube-kit] -> freeze
 * -> render -> thumbnails -> export. The timeline approved is the latest revision at the time; the render uses that
 * one even if someone edits again afterwards, and "Render lại" asks for the timeline to be approved again.
 */
import { afterEach, describe, expect, it } from "vitest";
import { TimelineV3Schema, YoutubeKitSchema } from "@harness/contracts";
import {
  episodeRunView, episodeTimelineApproved, episodeWorkflowForPlan, episodeState, latestEpisodeRevision, readStageDocument, rerenderEpisode,
  saveEpisodeRevision, STUDIO_GATES, STUDIO_WORKFLOWS, submitEpisodeTimelineGate, submitStudioGate,
} from "../src/index.js";
import { drain, oneEpisode, setup, type Setup } from "./episode-flow.js";

describe("ag-studio-episode@1.3.0", () => {
  let s: Setup;
  afterEach(() => s?.core.close());

  it("is the episode release new episodes use, with a gate for the timeline and one for the kit", () => {
    expect(STUDIO_WORKFLOWS.episode.workflow).toBe("ag-studio-episode@1.3.0");
    expect(STUDIO_GATES["approve-timeline"]).toBe("timeline.json");
    expect(STUDIO_GATES["approve-youtube-kit"]).toBe("youtube-kit.json");
  });

  it("is spawned by chat-first plans only: a series planned before keeps episodes without gates", () => {
    expect(episodeWorkflowForPlan("3.0.0")).toBe("ag-studio-episode@1.3.0");
    expect(episodeWorkflowForPlan("2.0.0")).toBe("ag-studio-episode@1.2.0");
    expect(episodeWorkflowForPlan("1.0.0")).toBe("ag-studio-episode@1.2.0");
  });

  it("waits for the timeline, then the kit; renders the timeline as approved; Render lại asks again", async () => {
    s = setup();
    const ep = await oneEpisode(s);
    expect(episodeState(s.core, s.db, ep)).toMatchObject({ status: "waiting_approval", current_stage: "approve-timeline" });
    expect(episodeTimelineApproved(s.core, s.db, ep.id)).toBe(false);

    // the person edits the draft (chat or editor), then approves: the latest revision is what is submitted
    const draft = latestEpisodeRevision(s.db, ep.id)!;
    const edited = { ...draft.data, texts: [{ text_id: "T901", kind: "lower_third" as const, text: "Phở sáng", start: 1, duration: 3, position: "bottom_left" as const }] };
    saveEpisodeRevision(s.db, ep.id, { baseRevision: draft.revision, data: edited, authorId: "editor-1" });
    const approved = await submitEpisodeTimelineGate(s.core, s.db, ep.id);
    expect(approved.revision).toBe(draft.revision + 1);
    await drain(s);
    let view = episodeRunView(s.core, s.db, ep.id);
    expect(view.waiting_gate).toBe("approve-youtube-kit");
    expect(episodeState(s.core, s.db, ep).status).toBe("waiting_approval");

    // an edit after approving is not what gets rendered
    expect(episodeTimelineApproved(s.core, s.db, ep.id)).toBe(true);
    const later = latestEpisodeRevision(s.db, ep.id)!;
    saveEpisodeRevision(s.db, ep.id, { baseRevision: later.revision, data: { ...later.data, texts: [] }, authorId: "editor-1" });

    const runId = view.run_id;
    const kit = YoutubeKitSchema.parse(readStageDocument(s.core, runId, "youtube-kit", "youtube-kit.json"));
    await submitStudioGate(s.core, s.db, runId, "approve-youtube-kit", { ...kit, titles: [...kit.titles].reverse() });
    await drain(s);
    expect(episodeState(s.core, s.db, ep).status).toBe("ready");
    const frozen = TimelineV3Schema.parse(readStageDocument(s.core, runId, "freeze-timeline", "timeline.json"));
    expect(frozen.texts.map((t) => t.text)).toEqual(["Phở sáng"]);

    // Render lại: the new run waits at approve-timeline for the latest revision
    const again = rerenderEpisode(s.core, s.db, ep.id);
    expect(again.reused).toEqual(expect.arrayContaining(["episode-intake", "build-timeline"]));
    await drain(s);
    view = episodeRunView(s.core, s.db, ep.id);
    expect(view.waiting_gate).toBe("approve-timeline");
  }, 60_000);
});
