#!/usr/bin/env node
// Mutation check: 11 deliberate bugs, each must turn the tests red.
// Zero dependencies, Node >= 20. Copies the repo into a temp dir per mutation,
// patches one anchor, runs `node --test` there, and exits 1 if any mutation is green.
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DST = join(tmpdir(), "mut-minimax-design");

const MUTS = [
  ["hilo.mjs", "chat drops the token header",
    "    token,\n    version_code: versionCode,", "    version_code: versionCode,"],
  ["hilo.mjs", "the app's cached config is ignored",
    "    return parseModels(JSON.parse(decryptToken(readFileSync(p.key), raw.lkgProviderConfig)))", "    return []"],
  ["hilo.mjs", "every provider is served, not the enabled order",
    "for (const name of order) {", "for (const name of Object.keys(providers)) {"],
  ["hilo.mjs", "a duplicate model id keeps the later provider",
    "if (!id || seen.has(id)) continue", "if (!id) continue"],
  ["hilo.mjs", "an expired credit source still counts",
    "return !(at > 0 && at <= now)", "return true"],
  ["hilo.mjs", "runsOut picks the largest, not the soonest",
    "if (at > now && (!runsOutAt || at < runsOutAt)) {", "if (at > now && credit > runsOut) {"],
  ["hilo.mjs", "a price is invented where the vendor named none",
    '    release_date: "",\n    variants: {},\n  }', '    release_date: "",\n    variants: {},\n    free: true,\n    rate: 0,\n  }'],
  ["hilo.mjs", "a 5xx is read as the account being gone",
    '  if (status === 401) return "expired"', '  if (status >= 400) return "expired"'],
  ["hilo.mjs", "the JWT's own id wins over the file's record",
    'userId: String(raw?.user?.userID ?? user.id ?? ""),', 'userId: String(user.id ?? ""),'],
  ["hilo.mjs", "device_id is sent blank when unknown",
    "...(deviceId ? { device_id: deviceId } : {}),", "device_id: deviceId,"],
  ["hilo.mjs", "limits are invented when the vendor gives none",
    "context: num(lim.context) ?? 0", "context: num(lim.context) ?? 1000000"],
];

let bad = 0;
for (let i = 0; i < MUTS.length; i++) {
  const [file, label, old, neu] = MUTS[i];
  const d = join(DST, "m" + i);
  rmSync(d, { recursive: true, force: true });
  cpSync(SRC, d, { recursive: true, filter: (s) => !s.includes(join(".git")) });
  const p = join(d, file);
  let code = readFileSync(p, "utf8");
  const at = code.indexOf(old);
  if (at < 0) { console.log(`SKIP (anchor missing)  ${label}`); bad++; continue; }
  writeFileSync(p, code.slice(0, at) + neu + code.slice(at + old.length));
  const r = spawnSync(process.execPath, ["--test"], { cwd: d, encoding: "utf8" });
  const passed = /pass (\d+)/.exec(r.stdout)?.[1] ?? "?";
  if (r.status === 0) { console.log(`GREEN! (tests still pass)  ${label}`); bad++; }
  else console.log(`RED (pass=${passed})  ${label}`);
  rmSync(d, { recursive: true, force: true });
}
rmSync(DST, { recursive: true, force: true });
console.log(bad === 0 ? "all mutations red" : `${bad} mutation(s) not red`);
process.exit(bad === 0 ? 0 : 1);
