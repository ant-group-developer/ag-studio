#!/usr/bin/env node
// Read-only Playwright lookup: opens a channel's YouTube Studio upload list to answer "is this video/title
// there, and what's its visibility?". It NEVER clicks anything and NEVER types a password or any other
// credential — headless persistent-context browsing only, purely to read the page.
//
// `playwright` is not a dependency of this adapter package; the legacy channel repo (the one passed via
// --profile's parent directory) already has it installed, so it's resolved from there via createRequire.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(reason) {
  console.log(JSON.stringify({ found: false, reason }));
  process.exit(2);
}

async function main() {
  const profile = arg("--profile");
  const channel = arg("--channel");
  const video = arg("--video");
  const title = arg("--title");
  const since = arg("--since");
  if (!profile || !channel) return fail("missing required --profile/--channel");
  if (!video && !title) return fail("missing --video or --title");

  const repoDir = dirname(profile); // profile is "<repo>/.upload-profile"
  let chromium;
  try {
    const require = createRequire(join(repoDir, "package.json"));
    ({ chromium } = require("playwright"));
  } catch {
    return fail(`playwright not installed in ${repoDir}`);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`https://studio.youtube.com/channel/${channel}/videos/upload`, { waitUntil: "networkidle" });
    await page.waitForSelector("ytcp-video-row, [role='row']", { timeout: 15000 });

    const rows = await page.$$eval("ytcp-video-row, [role='row']", (els) =>
      els.map((el) => ({ href: el.querySelector("a")?.getAttribute("href") ?? "", text: (el.textContent ?? "").trim() })),
    );

    const sinceMs = since ? Date.parse(since) : undefined;
    const match = rows.find((r) => {
      if (video) return r.href.includes(video);
      if (title) {
        if (!r.text.includes(title)) return false;
        if (sinceMs === undefined) return true;
        const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(r.text);
        return dateMatch ? Date.parse(dateMatch[1]) >= sinceMs : true;
      }
      return false;
    });
    if (!match) return fail("no matching video row in Studio's upload list");

    const visMatch = /Public|Private|Unlisted|Scheduled/i.exec(match.text);
    const visibility = (visMatch?.[0] ?? "private").toLowerCase();
    const idMatch = /[?&]v=([\w-]{6,})/.exec(match.href);
    console.log(JSON.stringify({ found: true, video_id: idMatch?.[1] ?? video ?? "", visibility, title: match.text }));
    process.exit(0);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();
