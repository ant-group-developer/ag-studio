import type { guideVi } from "./guide.vi";

type Messages<T> = { [K in keyof T]: T[K] extends string ? string : Messages<T[K]> };

/** The Guide page (`/guide`) in English; same shape and markup as `guide.vi.ts`. */
export const guideEn: Messages<typeof guideVi> = {
  title: "Guide",
  lead: "Making videos in Studio: from teams and projects, adding footage, to the final cut.",
  toc: "On this page",
  replayTour: "Replay the quick tour",
  showChecklist: "Show the Getting started list again",
  sections: {
    teams: {
      title: "Teams and roles",
      body: `Everything in Studio lives in a **team**: its projects, its people, its shared standards and skills. Pick the team in the first box of the top bar; **New team** and **Manage teams** are there too.

In no team yet? Make one (you own it and invite people later), or ask a team's owner to add you.

Roles in a team, from least to most:
- **Viewer**: sees the projects, the chats and the renders.
- **Editor**: also chats with {{ai}}, adds footage, makes videos, edits files, picks background music.
- **Producer**: also makes projects, picks the voice, confirms final renders and Premiere exports.
- **Owner**: also manages the team's people, standards and skills.`,
    },
    projects: {
      title: "What projects and videos are",
      body: `A **project** is one YouTube channel. Each project has its own working folder: notes on the channel, research, strategy, branding and every video. {{ai}} reads and writes in that folder; you open and edit every file in the **Files** tab.

To make a project: on the team's projects page, press **New project** and give a name, the channel link (if any), the language and the frame (16:9 or 9:16). It takes the producer role.

Each project has a **Channel** chat for the shared work (market research, channel strategy, edit style, branding), plus free chats when you need them. Each **video** is its own chat with {{ai}}, with suggested steps from the idea to the final cut.

Tip: edit **CLAUDE.md** in the Files tab to describe the channel, the audience, the tone and what never to do. Every chat of the project reads it.`,
    },
    footage: {
      title: "Adding footage from {{site}}",
      body: `A video's footage only comes from {{site}}. Open the **Inputs** tab in the project's right column:
- **Add project**: pick one or more {{site}} projects. {{ai}} searches their videos when it works on each video.
- In a video: pick exactly the {{site}} videos to use (as a table or a grid, filtered and searched as on {{site}}).

You only see footage the **project's owner** may view on {{site}}: {{ai}} and the render machines use the owner's access.

**Preparing inputs.** Before scenes are picked, each video needs preparing: its shots cut, frames, contact sheets and speech. {{site}} does this ahead of time when footage is uploaded, so Studio only copies it, usually in seconds. When {{site}} has not prepared a video yet, Studio asks {{site}} to do it right away and waits; the job card shows where it is (waiting for a machine, cutting shots, reading speech), its progress and a Stop button.

The summary line at the top of the tab says how many videos are ready, preparing or failed (click one to filter). **Prepare the videos not prepared** and **Retry the failed videos** do a whole batch at once.

Documents (PDF, markdown, CSV…), images and audio: **Upload** in the Documents, images, audio section. Save Word files as PDF first. Sample videos for {{ai}} to learn an edit style from are uploaded there too.`,
    },
    audio: {
      title: "Voice and background music",
      body: `The first card of the **Inputs** tab. Voice and music never come from {{site}}.

**Voice** (producer role):
- **Upload a voice sample** (3–20 seconds) or **Pick an uploaded file**, then say where the voice comes from (synthetic, my own, licensed). Only use a voice you have the right to use.
- **No narration**: the words become on-screen captions.

**Background music** (editor role):
- **Upload music** (up to 300 MB): used at once.
- **Pick an uploaded file**: a two-column picker. On the left, search, listen and tick tracks; on the right, the play order, which you drag (mouse or keyboard) to change. The total length already takes off the crossfades between tracks.
- **Pick from the library**: listen, then pick a track from the shared library.
- **Pick by mood**: no music of its own; when the timeline is built, Studio takes a library track matching the mood of the edit plan and the branding.

A video can have its own music, apart from the project's. A button that cannot be used is greyed out and says why (missing role, machine not ready).`,
    },
    video: {
      title: "One video, from brief to final cut",
      body: `1. **New video** (left column): say what the video is about and whether it learns from older chats (the project's lessons, or a few chosen chats).
2. **Idea & brief**: {{ai}} writes what the video tells, for whom, how long, with which footage, with narration or not.
3. **Prepare inputs**: add {{site}} videos and prepare them (see Adding footage).
4. **Pick scenes**: {{ai}} looks at the frames, scores them and picks the usable scenes.
5. **Edit plan**: shot order, the parts used, narration, on-screen text.
6. **Timeline** and **Preview**: {{ai}} builds the timeline and renders a preview; watch it in the **Preview** tab.
7. **YouTube kit** and **Thumbnail**: title, description, tags, cover image.
8. **Final cut**: {{ai}} proposes a "Final render" card; someone with the producer role presses Confirm.

The step bar above the chat shows which steps are done and which to do next. Click a step to see its files and ask {{ai}} to do it or redo it. The order is only a suggestion: do any step, go back to any step.`,
    },
    chat: {
      title: "Changing things by chat",
      body: `To change something, tell {{ai}} in the video's chat, as precisely as you can:
- "Drop scene 3 and open on the boat on the river."
- "Bigger on-screen text, in white."
- "A faster opening, about 60 seconds overall."
- "Switch the music to something more upbeat."

{{ai}} edits the files and rebuilds. Under its answer, a **changed files** card has Open and See changes. You can also edit the files yourself in the Files tab and ask {{ai}} to rebuild.

Tips:
- In the Files tab, **Add to the message** attaches a file to the message being written.
- Heavy work (renders, preparing footage) runs in the background. The **Running** button in the top bar shows who does what and for how long, and stops it.
- When {{ai}} proposes a lesson, **Keep in the project's lessons** so the next videos get it right from the start.
- Work with real effects (final render, Premiere export, deleting a video) always waits for someone with the role to confirm; {{ai}} never does it alone.`,
    },
    renders: {
      title: "Preview, final cut and Premiere",
      body: `- **Preview**: light, for a quick review. Watch it in the video's **Preview** tab. Anyone in the project can watch it.
- **Final cut**: full quality, rendered on a farm machine. {{ai}} proposes a "Final render" card and someone with the producer role presses Confirm (or presses it in the Preview tab). Anyone in the project can watch and download the mp4.
- **Premiere export**: a zip to keep editing in Premiere, with the footage and the narration. Only downloadable when your own {{site}} access covers every piece of footage in it.

When the timeline changes after a card was proposed, the card expires; ask {{ai}} to propose it again.`,
    },
    problems: {
      title: "Common problems",
      body: `- **A job stuck at "waiting for a machine"**: no farm machine takes this kind of work right now (off or busy). After a while the job stops and says so in the chat; try again later or tell an admin.
- **Footage that will not prepare**: press **Retry the failed videos** in the Inputs tab. If it still fails, check the video is still on {{site}} and the project's owner may still view it.
- **The {{site}} project you want is not listed**: only projects the project's owner may view on {{site}} are listed.
- **A message says the quota ran out**: {{ai}} waits for the plan's quota and runs again at the time shown. Press Stop to give up.
- **A confirm card "expired"**: the timeline changed or 24 hours passed. Ask {{ai}} to propose it again.
- **The Premiere file says you may not view the footage**: your {{site}} access does not cover the footage in that file; sharing a project does not widen footage access. The preview and the final cut still play.
- **A greyed-out button**: hover it to see why, usually a missing role.`,
    },
  },
};
