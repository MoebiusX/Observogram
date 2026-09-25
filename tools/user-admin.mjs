#!/usr/bin/env node
/**
 * tools/user-admin.mjs — manage users in the store (npm run users).
 *
 * Users live in the store (observogram.db; docs/STORE_PLAN.md slice 2),
 * scrypt-hashed. The rules live once in server/identity-admin.mjs (shared
 * with slice 3's identity API); this is the thin shell entry point.
 *
 *   npm run users -- add <username> [--name N] [--email E] [--role viewer|operator|admin] [--org <id>] [--password-stdin]
 *   npm run users -- passwd <username> [--password-stdin]
 *   npm run users -- remove <username>
 *   npm run users -- enable <username>
 *   npm run users -- list
 *   npm run users -- owner <login|sub|issuer#sub>
 *
 * The first local user becomes the owner and admin of the default org (not
 * when this shell sets OBSERVOGRAM_OIDC_ISSUER: it is created without owner), and
 * arms stand-alone sign-in on a running server (no restart needed); once
 * armed it stays armed. `remove` disables (users are never deleted: the
 * audit references them); `enable` undoes it, except for a row still holding
 * the seeded default password (`passwd` it first). Passwords are prompted with echo off;
 * automation can pipe one instead:
 *   echo "s3cret" | npm run users -- add alice --password-stdin
 *
 * Exit codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { createInterface } from 'node:readline';
import { brandEnv } from './lib/brand-env.mjs';
import { CliRefusal, noteShellInit, openStoreForCli } from '../server/store/cli.mjs';
import {
  AdminRefusal, addLocalUser, checkAddLocalUser, disableUser, enableUser, grantOwnerByLogin, setLocalPassword,
} from '../server/identity-admin.mjs';
import { ensureDefaultOrg, isControlChar, CLI } from '../server/store/identity.mjs';
import { getMeta } from '../server/store/meta.mjs';
import { getUserByLogin, listUsersWithMemberships } from '../server/store/users.mjs';

const NAME = 'user-admin';
const args = process.argv.slice(2);
const cmd = args[0];
const username = args[1] && !args[1].startsWith('--') ? args[1] : undefined;

function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}
const text = (name) => (typeof flag(name) === 'string' ? flag(name) : null);

function promptHidden(question) {
  return new Promise((resolveP, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const origWrite = rl._writeToOutput.bind(rl);
    process.stdout.write(question);
    rl._writeToOutput = () => {};   // echo off
    rl.question('', (answer) => {
      rl._writeToOutput = origWrite;
      process.stdout.write('\n');
      rl.close();
      resolveP(answer);
    });
    rl.on('error', reject);
  });
}

// Runs outside any transaction: the store is only written once it returns.
async function readPassword() {
  if (flag('password-stdin')) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const pw = raw.split('\n')[0].replace(/\r$/, '');
    if (!pw) throw new Error('empty password on stdin');
    return pw;
  }
  const pw = await promptHidden('password: ');
  const again = await promptHidden('repeat:   ');
  if (pw !== again) throw new Error('passwords do not match');
  if (pw.length < 8) throw new Error('password must be at least 8 characters');
  return pw;
}

function usage() {
  console.error('usage: npm run users -- <add|passwd|remove|enable|list|owner> [username] '
    + '[--name N] [--email E] [--role viewer|operator|admin] [--org <id>] [--password-stdin]');
  process.exitCode = 2;
}

// One row per user: a control character in a stored value (a --name typed
// here, a row from an older store) prints escaped, never as a tab or line.
const printable = (v) => Array.from(String(v), (ch) => (isControlChar(ch) ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : ch)).join('');

const shellIssuerRaw = () => brandEnv('OIDC_ISSUER') || null;

async function main() {
  if (cmd !== 'list' && (!['add', 'passwd', 'remove', 'enable', 'owner'].includes(cmd) || !username)) return usage();
  const { db } = await openStoreForCli({ name: NAME });

  if (cmd === 'list') {
    for (const u of listUsersWithMemberships(db)) {
      const orgs = u.memberships.map((m) => `${m.orgId}:${m.role}`).join(',');
      const fields = [u.login, u.kind, u.name || '', u.email || '', u.isOwner ? 'owner' : '-', u.disabled ? 'disabled' : 'enabled', orgs];
      console.log(fields.map(printable).join('\t'));
    }
    return;
  }

  if (cmd === 'add') {
    const role = typeof flag('role') === 'string' ? flag('role') : undefined;
    const orgId = text('org');
    // Every refusal before the prompt: a refusal never costs a typed password.
    checkAddLocalUser(db, { login: username, role, orgId });
    ensureDefaultOrg(db, CLI);
    const password = await readPassword();
    const r = addLocalUser(db, CLI, { login: username, name: text('name'), email: text('email'), password, role, orgId, shellIssuerRaw: shellIssuerRaw() });
    console.log(`added ${r.user.login}`);
    if (r.owner) {
      const org = r.joined[0]?.orgId;
      console.log(`${r.user.login} is the first local user: owner, and admin of org ${org}${role !== undefined ? ' (--role ignored)' : ''}`);
    }
    if (r.ownerWithheld) console.log(`${r.user.login} is created without owner: ${r.ownerWithheld}`);
    // Under OIDC anonymous reads already answer 401 and local users cannot
    // sign in: arming changes nothing a user of this posture would see.
    const recorded = getMeta(db, 'oidc_issuer');
    if (r.armed && !shellIssuerRaw() && !recorded) {
      console.log('stand-alone sign-in is armed; sign in at /auth/login (no restart needed)');
      // The server already ran without identity: its anonymous reads were open.
      if (getMeta(db, 'import_done')) console.log('note: anonymous reads now answer 401 (identity is armed and stays armed)');
    }
    if (shellIssuerRaw()) console.log('note: local users cannot sign in while OIDC is configured');
    else if (recorded) console.log(`note: this store records OIDC issuer ${recorded}: local users sign in only while the server runs without OBSERVOGRAM_OIDC_ISSUER`);
    noteShellInit(db);
    return;
  }

  if (cmd === 'passwd') {
    const row = getUserByLogin(db, username);
    if (!row || row.kind !== 'local') throw new AdminRefusal(`no local user ${username}`);
    const password = await readPassword();
    const user = setLocalPassword(db, CLI, username, password);
    console.log(`updated password for ${user.login}${user.disabled ? ` (disabled: npm run users -- enable ${user.login} lets them sign in)` : ''}`);
    noteShellInit(db);
    return;
  }

  if (cmd === 'remove') {
    const user = disableUser(db, CLI, username, { shellIssuerRaw: shellIssuerRaw() });
    console.log(`disabled ${user.login} (users are never deleted: the audit references them)`);
    noteShellInit(db);
    return;
  }

  if (cmd === 'enable') {
    const user = enableUser(db, CLI, username);
    console.log(`enabled ${user.login}`);
    noteShellInit(db);
    return;
  }

  // owner
  const user = grantOwnerByLogin(db, CLI, username, { shellIssuerRaw: shellIssuerRaw() });
  console.log(`${user.login} is an owner and admin of org ${getMeta(db, 'default_org')}`);
  noteShellInit(db);
}

main().catch((e) => {
  console.error(e instanceof CliRefusal ? e.message : `${NAME}: ${e.message}`);
  process.exitCode = 1;
});
