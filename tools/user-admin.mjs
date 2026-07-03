#!/usr/bin/env node
/**
 * tools/user-admin.mjs — manage stand-alone users (npm run users).
 *
 * Stand-alone identity for docs/PRODUCTIZATION_PLAN.md Stage 1: users
 * live scrypt-hashed in a plain file (OBSERVOGRAM_USERS_FILE, default
 * <workspace>/users.json). The file EXISTING is what switches the
 * server into local-users mode — add the first user, restart, sign in.
 *
 *   npm run users -- add alice [--name "Alice"] [--email a@x.io]
 *   npm run users -- passwd alice
 *   npm run users -- remove alice
 *   npm run users -- list
 *
 * Passwords are prompted with echo off; non-interactive automation can
 * pipe one instead:  echo "s3cret" | npm run users -- add alice --password-stdin
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { hashPassword, readUsers, writeUsers, usersFilePath } from '../server/auth.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const username = args[1];

function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

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

async function main() {
  const file = usersFilePath();
  if (cmd === 'list') {
    const { users } = readUsers(file);
    const names = Object.keys(users).sort();
    if (!names.length) {
      console.log(`no users in ${file}${existsSync(file) ? '' : ' (file does not exist — stand-alone auth is OFF)'}`);
      return;
    }
    for (const u of names) {
      console.log(`${u}\t${users[u].name || ''}\t${users[u].email || ''}\tcreated ${users[u].createdAt || '?'}`);
    }
    return;
  }
  if (!['add', 'passwd', 'remove'].includes(cmd) || !username) {
    console.error('usage: npm run users -- <add|passwd|remove|list> [username] [--name N] [--email E] [--password-stdin]');
    process.exit(2);
  }
  if (!/^[a-zA-Z0-9._@-]{2,64}$/.test(username)) {
    throw new Error('username must be 2–64 chars of [a-zA-Z0-9._@-]');
  }
  const data = readUsers(file);
  if (cmd === 'remove') {
    if (!data.users[username]) throw new Error(`no such user: ${username}`);
    delete data.users[username];
    writeUsers(data, file);
    console.log(`removed ${username} (${file})`);
    return;
  }
  if (cmd === 'passwd' && !data.users[username]) throw new Error(`no such user: ${username}`);
  if (cmd === 'add' && data.users[username]) throw new Error(`user exists: ${username} (use passwd)`);
  const password = await readPassword();
  data.users[username] = {
    ...(data.users[username] || {}),
    ...(cmd === 'add' ? { createdAt: new Date().toISOString() } : {}),
    ...(typeof flag('name') === 'string' ? { name: flag('name') } : {}),
    ...(typeof flag('email') === 'string' ? { email: flag('email') } : {}),
    password: hashPassword(password),
  };
  writeUsers(data, file);
  console.log(`${cmd === 'add' ? 'added' : 'updated password for'} ${username} (${file})`);
  if (cmd === 'add' && Object.keys(data.users).length === 1) {
    console.log('stand-alone auth is now ON — restart the server; sign in at /auth/login');
  }
}

main().catch(e => { console.error(`user-admin: ${e.message}`); process.exit(1); });
