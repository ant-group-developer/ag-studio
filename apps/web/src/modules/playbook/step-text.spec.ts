/**
 * The default steps read in the UI language by key: the Vietnamese words in `ws.steps.def` must be the engine's own
 * (a step is translated only while its words are still the default's), and every default step has English words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wsEn } from "../../i18n/locales/ws.en";
import { wsVi } from "../../i18n/locales/ws.vi";

const PLAYBOOK_SRC = join(__dirname, "../../../../../packages/studio-engine/src/workspace/playbook.ts");

function engineSteps(): { key: string; title: string; description: string }[] {
  const text = readFileSync(PLAYBOOK_SRC, "utf8");
  return [...text.matchAll(/key: "([a-z-]+)", scope: "(?:project|video)", title: "([^"]+)"[\s\S]*?description: "([^"]+)"/g)]
    .map((m) => ({ key: m[1]!, title: m[2]!, description: m[3]! }));
}

describe("default step words", () => {
  const steps = engineSteps();

  it("finds the engine's default steps", () => {
    expect(steps.map((s) => s.key)).toEqual(["research", "channel", "style", "branding", "brief", "prepare", "scenes", "edit-plan", "timeline", "preview", "youtube-kit", "thumbnail", "final"]);
  });

  it("the Vietnamese words are the engine's, word for word", () => {
    const def = wsVi.steps.def as Record<string, { title: string; description: string }>;
    expect(steps.map((s) => ({ key: s.key, ...def[s.key] }))).toEqual(steps);
  });

  it("every default step has English words", () => {
    const def = wsEn.steps.def as Record<string, { title: string; description: string } | undefined>;
    expect(steps.filter((s) => !def[s.key]?.title || !def[s.key]?.description).map((s) => s.key)).toEqual([]);
  });
});
