// server/store/cli.mjs — the shared preamble of the CLIs that write the
// store (`npm run users`, `npm run orgs`, `packc store`; docs/STORE_PLAN.md
// §4 "The CLIs").
//
// A CLI never imports the legacy files: it would use this shell's
// environment, not the server's. So on a workspace that still holds a
// users.json / orgs.json the server has not imported yet, it refuses — and
// refuses before creating a database file when there is none. On a fresh
// workspace it initialises the store from this shell and says so after its
// first write (noteShellInit). `:memory:` is refused: a CLI needs the
// server's database file.
//
// Exit codes for the CLIs: 0 done · 1 refused or failed (one line on
// stderr) · 2 usage. They set process.exitCode instead of calling
// process.exit() mid-output (db.mjs's exit hook closes the store).

import { existsSync } from 'node:fs';
import { baseWorkspacePath } from '../../tools/lib/brand-env.mjs';
import { closeStore, openStore, resolveDbPath } from './db.mjs';
import { getMeta } from './meta.mjs';
import { envUsersFilePath, orgsFilePath } from './legacy-files.mjs';

// A refusal: the message is the whole line (it starts with the CLI's name).
export class CliRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliRefusal';
    this.code = 'ERR_OBSERVOGRAM_CLI_REFUSED';
  }
}

const notImported = (name, base) => `${name}: ${base} holds users.json/orgs.json that are not imported yet — start the server once `
  + 'with its environment; its first start imports them (the CLIs never import: they would use this shell\'s env)';

export async function openStoreForCli({ name, out = process.stdout }) {
  const path = resolveDbPath();
  if (path === ':memory:') throw new CliRefusal(`${name}: OBSERVOGRAM_DB is :memory: — a CLI needs the server's database file`);
  const base = baseWorkspacePath();
  const legacy = existsSync(envUsersFilePath(base)) || existsSync(orgsFilePath(base));
  if (legacy && !existsSync(path)) throw new CliRefusal(notImported(name, base));
  const db = await openStore({ path });
  out.write(`store: ${path}\n`);
  if (legacy && !getMeta(db, 'import_done')) {
    closeStore(path);
    throw new CliRefusal(notImported(name, base));
  }
  return { db, path, base };
}

// After a successful write on a store the server has not started yet.
export function noteShellInit(db, out = process.stdout) {
  if (getMeta(db, 'import_done')) return false;
  out.write("store initialised from this shell's environment\n");
  return true;
}
