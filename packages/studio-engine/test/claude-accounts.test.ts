/**
 * Claude accounts (plan 2026-10-30): tokens sealed with STUDIO_SECRET_KEY, teams given accounts in order, `default`
 * for a team with none, the plan's limit remembered on the account, and the farm pool of a team.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireClaudeSlot, claimAccountCheck, createProject, nodesOfPool, projectFarmPool, referenceFetchNodes, claudeAccountsForTeam, claudeAccountToken, claudeUsageByAccount, createClaudeAccount, deleteClaudeAccount,
  finishAccountCheck, getClaudeAccount, listClaudeAccounts, looksLikeAuthError, noteAccountRateLimited, noteAccountWorked, openSecret,
  pickClaudeAccount, requestClaudeAccountCheck, sealSecret, secretKey, setTeamClaudeAccounts, setTeamFarmPool, teamClaudeAccountIds, teamFarmPool,
  updateClaudeAccount, type StudioDb,
} from "../src/index.js";
import { world } from "./helpers.js";

const T0 = "2026-10-30T10:00:00.000Z";
const KEY = secretKey("a-long-enough-secret-key")!;

let open: StudioDb | null = null;
afterEach(async () => { await open?.close(); open = null; });
async function fresh() {
  const db = (open = (await world()).db);
  for (const id of ["team-a", "team-b"]) await db.run("INSERT INTO teams (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, id.toUpperCase(), T0, T0]);
  return db;
}

describe("secret box", () => {
  it("opens what it sealed, only with the same key", () => {
    const sealed = sealSecret(KEY, "sk-ant-oat01-abc");
    expect(sealed).not.toContain("abc");
    expect(openSecret(KEY, sealed)).toBe("sk-ant-oat01-abc");
    expect(() => openSecret(secretKey("another-long-secret-key")!, sealed)).toThrow();
    expect(secretKey(undefined)).toBeNull();
    expect(() => secretKey("short")).toThrow(/16/);
  });
});

describe("Claude accounts", () => {
  it("keeps the token sealed, shows only its last 4, and the default account is there from the migration", async () => {
    const db = await fresh();
    const a = await createClaudeAccount(db, KEY, { name: "Chi nhánh HCM", token: " tok-hcm-1234 ", maxConcurrent: 3 }, "admin", T0);
    expect(a).toMatchObject({ name: "Chi nhánh HCM", token_hint: "1234", max_concurrent: 3, enabled: true });
    expect(a.token_enc).not.toContain("tok-hcm");
    expect(claudeAccountToken(a, KEY, {})).toBe("tok-hcm-1234");
    expect(claudeAccountToken(a, null, {})).toBeNull();
    const views = await listClaudeAccounts(db);
    expect(views.map((v) => [v.id === "default", v.name])).toEqual([[true, "Mặc định"], [false, "Chi nhánh HCM"]]);
    expect(JSON.stringify(views)).not.toContain("token_enc");
    expect(claudeAccountToken((await getClaudeAccount(db, "default"))!, KEY, { CLAUDE_CODE_OAUTH_TOKEN: "env-tok" })).toBe("env-tok");
    await expect(createClaudeAccount(db, null, { name: "x", token: "t" }, "admin", T0)).rejects.toThrow(/STUDIO_SECRET_KEY/);
    await expect(createClaudeAccount(db, KEY, { name: "x", token: "two words" }, "admin", T0)).rejects.toThrow(/setup-token/);
    await expect(updateClaudeAccount(db, KEY, "default", { token: "t" }, T0)).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    await expect(deleteClaudeAccount(db, "default")).rejects.toThrow();
  });

  it("a new token starts clean; a team runs on its enabled accounts in order, else on default", async () => {
    const db = await fresh();
    const a = await createClaudeAccount(db, KEY, { name: "A", token: "tok-a" }, "admin", T0);
    const b = await createClaudeAccount(db, KEY, { name: "B", token: "tok-b" }, "admin", T0);
    await noteAccountRateLimited(db, a.id, T0);
    const renewed = await updateClaudeAccount(db, KEY, a.id, { token: "tok-a2" }, T0);
    expect(renewed).toMatchObject({ rate_limited_until: null, rate_limit_hits: 0, token_hint: "k-a2" });

    expect((await claudeAccountsForTeam(db, "team-a")).map((r) => r.id)).toEqual(["default"]);
    await setTeamClaudeAccounts(db, "team-a", [b.id, a.id, b.id]);
    expect(await teamClaudeAccountIds(db, "team-a")).toEqual([b.id, a.id]);
    expect((await claudeAccountsForTeam(db, "team-a")).map((r) => r.id)).toEqual([b.id, a.id]);
    await updateClaudeAccount(db, KEY, b.id, { enabled: false }, T0);
    expect((await claudeAccountsForTeam(db, "team-a")).map((r) => r.id)).toEqual([a.id]);
    expect((await listClaudeAccounts(db)).find((v) => v.id === a.id)?.teams).toEqual([{ id: "team-a", name: "TEAM-A" }]);
    await deleteClaudeAccount(db, a.id);
    // B is off and A is gone: back to default
    expect((await claudeAccountsForTeam(db, "team-a")).map((r) => r.id)).toEqual(["default"]);
    await expect(setTeamClaudeAccounts(db, "team-a", ["nope"])).rejects.toThrow(/not found/);
  });

  it("the plan's limit waits longer each time in a row; a turn that works clears it", async () => {
    const db = await fresh();
    const a = await createClaudeAccount(db, KEY, { name: "A", token: "tok-a" }, "admin", T0);
    expect(await noteAccountRateLimited(db, a.id, T0)).toBe("2026-10-30T10:05:00.000Z");
    expect(await noteAccountRateLimited(db, a.id, T0)).toBe("2026-10-30T10:10:00.000Z");
    await noteAccountWorked(db, a.id, T0);
    expect(await getClaudeAccount(db, a.id)).toMatchObject({ rate_limited_until: null, rate_limit_hits: 0, last_used_at: T0 });
  });

  it("picks the thread's last account while it has room, else the first in order; waits when none can", async () => {
    const db = await fresh();
    const a = await createClaudeAccount(db, KEY, { name: "A", token: "tok-a" }, "admin", T0);
    const b = await createClaudeAccount(db, KEY, { name: "B", token: "tok-b" }, "admin", T0);
    const rows = async () => [(await getClaudeAccount(db, a.id))!, (await getClaudeAccount(db, b.id))!];
    const all = () => true;
    expect(pickClaudeAccount(await rows(), { now: T0, room: all })).toEqual({ account: expect.objectContaining({ id: a.id }) });
    expect(pickClaudeAccount(await rows(), { now: T0, sticky: b.id, room: all })).toEqual({ account: expect.objectContaining({ id: b.id }) });
    expect(pickClaudeAccount(await rows(), { now: T0, sticky: b.id, room: (r) => r.id !== b.id })).toEqual({ account: expect.objectContaining({ id: a.id }) });
    expect(pickClaudeAccount(await rows(), { now: T0, room: () => false })).toEqual({ wait: true, until: null });
    await noteAccountRateLimited(db, a.id, T0);
    expect(pickClaudeAccount(await rows(), { now: T0, room: all })).toEqual({ account: expect.objectContaining({ id: b.id }) });
    await noteAccountRateLimited(db, b.id, "2026-10-30T09:58:00.000Z");
    expect(pickClaudeAccount(await rows(), { now: T0, room: all })).toEqual({ wait: true, until: "2026-10-30T10:03:00.000Z" });
  });

  it("an account's own cap counts its slots across workers, under Studio's cap", async () => {
    const db = await fresh();
    const one = { id: "acc-1", cap: 1 };
    expect(await acquireClaudeSlot(db, "agent", "t1", 5, T0, 120, one)).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "t2", 5, T0, 120, one)).toBe(false);
    expect(await acquireClaudeSlot(db, "agent", "t3", 5, T0, 120, { id: "acc-2", cap: null })).toBe(true);
    expect(await acquireClaudeSlot(db, "agent", "t1", 5, T0, 120, one)).toBe(true); // it holds it already
    expect(Object.fromEntries(await claudeUsageByAccount(db))).toEqual({ "acc-1": 1, "acc-2": 1 });
  });

  it("a check asked on the web is taken by one worker and says how it went", async () => {
    const db = await fresh();
    const a = await createClaudeAccount(db, KEY, { name: "A", token: "tok-a" }, "admin", T0);
    await requestClaudeAccountCheck(db, a.id, T0);
    expect((await claimAccountCheck(db, "2026-10-30T10:00:01.000Z"))?.id).toBe(a.id);
    expect(await claimAccountCheck(db, "2026-10-30T10:00:02.000Z")).toBeUndefined();
    await finishAccountCheck(db, a.id, "failed", "Invalid bearer token", "2026-10-30T10:00:03.000Z");
    expect(await getClaudeAccount(db, a.id)).toMatchObject({ check_status: "failed", check_error: "Invalid bearer token", last_error: "Invalid bearer token" });
    expect(looksLikeAuthError("API Error: 401 {\"type\":\"authentication_error\"}")).toBe(true);
    expect(looksLikeAuthError("exit 1")).toBe(false);
  });

  it("a team's farm pool, and the machines its jobs (and its reference downloads) can run on", async () => {
    const db = await fresh();
    const nodes = [
      { name: "shared", online: true, kinds: ["studio.reference_fetch"] },
      { name: "hcm-1", online: true, kinds: ["studio.reference_fetch"], pool: "hcm" },
      { name: "hcm-off", online: false, kinds: ["studio.reference_fetch"], pool: "hcm" },
    ];
    expect(nodesOfPool(nodes, "hcm").map((n) => n.name)).toEqual(["hcm-1", "hcm-off"]);
    expect(nodesOfPool(nodes, null).map((n) => n.name)).toEqual(["shared"]);
    expect(referenceFetchNodes(nodes, "hcm").map((n) => n.name)).toEqual(["hcm-1"]);
    expect(referenceFetchNodes(nodes, null).map((n) => n.name)).toEqual(["shared"]);
    expect(referenceFetchNodes(nodes).map((n) => n.name)).toEqual(["shared", "hcm-1"]);
    expect(await teamFarmPool(db, "team-a")).toBeNull();
    await setTeamFarmPool(db, "team-a", " hcm-1 ", T0);
    expect(await teamFarmPool(db, "team-a")).toBe("hcm-1");
    const project = await createProject(db, "team-a", { name: "P", description: "", language: "vi", aspect: "16:9" }, "u", T0);
    expect(await projectFarmPool(db, project.id)).toBe("hcm-1");
    await expect(setTeamFarmPool(db, "team-a", "Bad Pool", T0)).rejects.toThrow(/pool/);
    await setTeamFarmPool(db, "team-a", "", T0);
    expect(await teamFarmPool(db, "team-a")).toBeNull();
  });
});
