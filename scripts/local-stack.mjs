#!/usr/bin/env node
// Bật / tắt / xem cả stack Studio chạy trực tiếp trên máy (không Docker). Xem docs/runbooks/studio-local.md.
//
//   node scripts/local-stack.mjs up [tên...|all]     bật (mặc định: các dịch vụ chính; "all" thêm ag-go worker, farm web, ag-go web)
//   node scripts/local-stack.mjs down [tên...|all]   tắt những gì script này đã bật
//   node scripts/local-stack.mjs status              dịch vụ nào đang lên
//
// `up` cũng trỏ `sign_url` của chủ job `studio` và `ag-go` trong DB farm (container postgres16) về địa chỉ LAN hiện tại
// của máy: đổi IP (DHCP) thì mọi job farm hỏng ở bước tải đầu tiên với `fetch failed`. `status` chỉ báo khi lệch.
//
// Dịch vụ đã lên (health trả 200, hoặc tiến trình do script bật còn sống) thì `up` bỏ qua, nên chạy lại an toàn.
// `down` chỉ tắt tiến trình do script bật (pid trong <AG_LOCAL_DIR>/dev-run/local-stack.json), không đụng tiến trình
// bạn tự bật ở terminal khác, và không đụng container Docker. Không in giá trị biến môi trường nào.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lanAddress, planServices, selectServices, signUrlFixes } from "./local-stack-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const services = planServices({ repoRoot, env: process.env });
const stateFile = resolve(dirname(services[0].log), "local-stack.json");
const isWindows = process.platform === "win32";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
function writeState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function healthy(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
async function waitHealthy(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy(url)) return true;
    await sleep(1000);
  }
  return false;
}
const isUp = async (s, state) => (s.health ? healthy(s.health) : alive(state[s.name]?.pid));

function stop(pid) {
  if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } }
}

// ag-farm's database (Docker): the job owners' sign_url follow this machine's LAN address.
const farmPg = process.env.AG_FARM_PG_CONTAINER ?? "postgres16";
const farmDb = process.env.AG_FARM_DB ?? "ag_farm";
function psql(sql) {
  const r = spawnSync("docker", ["exec", farmPg, "psql", "-U", "postgres", "-d", farmDb, "-At", "-F", "|", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || "docker exec failed").trim());
  return r.stdout;
}
/** `fix`: write the new sign_url; otherwise only say which are stale. */
function syncSignUrls(fix) {
  const ip = lanAddress(networkInterfaces());
  if (!ip) { console.log("! sign_url: không tìm thấy địa chỉ LAN của máy"); return; }
  let owners;
  try {
    owners = psql("SELECT id, sign_url FROM farm_owners WHERE id IN ('studio', 'ag-go')").trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { const [id, sign_url] = l.split("|"); return { id, sign_url }; });
  } catch (e) { console.log(`? sign_url: không đọc được DB farm (${e.message})`); return; }
  const fixes = signUrlFixes(owners, ip);
  if (!fixes.length) { console.log(`= sign_url: đã trỏ ${ip}`); return; }
  for (const f of fixes) {
    if (!fix) { console.log(`! sign_url ${f.id}: ${f.from} (máy đang là ${ip}; chạy "up" để sửa)`); continue; }
    psql(`UPDATE farm_owners SET sign_url = '${f.to}', updated_at = NOW() WHERE id = '${f.id}'`);
    console.log(`~ sign_url ${f.id}: ${f.from} → ${f.to}`);
  }
}

async function up(list) {
  const state = readState();
  for (const s of list) {
    if (await isUp(s, state)) { console.log(`= ${s.name}: đã chạy`); continue; }
    if (!existsSync(s.cwd)) { console.log(`! ${s.name}: không thấy thư mục ${s.cwd}`); return 1; }
    mkdirSync(dirname(s.log), { recursive: true });
    const out = openSync(s.log, "a");
    // shell trên Windows: yarn và corepack là file .cmd; đối số ở đây không có dấu nháy nên an toàn.
    const child = spawn(s.command, s.args, {
      cwd: s.cwd, env: { ...process.env, ...s.env }, detached: true, stdio: ["ignore", out, out], windowsHide: true, shell: isWindows,
    });
    child.unref();
    state[s.name] = { pid: child.pid, started_at: new Date().toISOString() };
    writeState(state);
    process.stdout.write(`+ ${s.name}: pid ${child.pid}, log ${s.log}`);
    if (s.health) {
      const ok = await waitHealthy(s.health, 180_000);
      console.log(ok ? " — sẵn sàng" : " — chưa lên sau 180 s, xem log");
      if (!ok) return 1;
    } else {
      await sleep(2000);
      const ok = alive(child.pid);
      console.log(ok ? " — đang chạy" : " — đã thoát, xem log");
      if (!ok) return 1;
    }
  }
  syncSignUrls(true);
  return 0;
}

async function down(list) {
  const state = readState();
  for (const s of [...list].reverse()) {
    const pid = state[s.name]?.pid;
    if (alive(pid)) { stop(pid); console.log(`- ${s.name}: đã tắt (pid ${pid})`); }
    else if (s.health && (await healthy(s.health))) console.log(`= ${s.name}: đang chạy nhưng không do script bật, bỏ qua`);
    delete state[s.name];
  }
  writeState(state);
  return 0;
}

async function status(list) {
  const state = readState();
  for (const s of list) {
    const pid = state[s.name]?.pid;
    const upNow = await isUp(s, state);
    // A worker has no port: if this script did not start it, there is nothing to measure.
    const unknown = !s.health && !alive(pid);
    const mark = unknown ? "?   " : upNow ? "lên " : "tắt ";
    const who = alive(pid) ? `pid ${pid}` : unknown ? "không đo được nếu bật ngoài script" : upNow ? "bật ngoài script" : "";
    console.log(`${mark} ${s.name.padEnd(14)} ${(s.health ?? "(không có cổng)").padEnd(36)} ${who}`);
  }
  syncSignUrls(false);
  return 0;
}

const [command = "status", ...names] = process.argv.slice(2);
try {
  const list = command === "status" && names.length === 0 ? services : selectServices(services, names);
  const run = { up, down, status }[command];
  if (!run) throw new Error(`lệnh không hợp lệ "${command}" (up | down | status)`);
  process.exitCode = await run(list);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
