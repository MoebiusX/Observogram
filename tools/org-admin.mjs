#!/usr/bin/env node
/**
 * tools/org-admin.mjs — manage orgs in the store (npm run orgs).
 *
 * Orgs and memberships live in the store (observogram.db;
 * docs/STORE_PLAN.md slice 2). Tenancy is always on: a flat workspace is
 * the default org, at the base. The rules live once in
 * server/identity-admin.mjs; this is the thin shell entry point.
 *
 *   npm run orgs -- create <id> [--name N] [--admin <login|sub>] [--adopt]
 *   npm run orgs -- remove <id>
 *   npm run orgs -- add-member <id> <login|sub> [--role viewer|operator|admin]
 *   npm run orgs -- remove-member <id> <login|sub>
 *   npm run orgs -- list
 *
 * A created org's root is orgs/<id>/, fixed at creation. Creating an org
 * needs identity (a local user or OIDC) and an owner. Removing an org is
 * soft: its row and its files stay. Roles are recorded for Stage 3
 * (authorization); Stage 2 enforces membership only.
 *
 * Exit codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { join } from 'node:path';
import { brandEnv } from './lib/brand-env.mjs';
import { CliRefusal, noteShellInit, openStoreForCli } from '../server/store/cli.mjs';
import {
  addMemberByLogin, createOrgFromAdmin, removeMemberByLogin, removeOrgSoft,
} from '../server/identity-admin.mjs';
import { CLI } from '../server/store/identity.mjs';
import { getMeta } from '../server/store/meta.mjs';
import { listOrgs } from '../server/store/orgs.mjs';
import { listMembers } from '../server/store/memberships.mjs';
import { getUser } from '../server/store/users.mjs';

const NAME = 'org-admin';
const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--name', '--admin', '--role'].includes(args[i - 1])));
const [cmd, orgId, member] = positional;

function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}
const text = (name) => (typeof flag(name) === 'string' ? flag(name) : null);

function usage() {
  console.error('usage: npm run orgs -- <create|remove|add-member|remove-member|list> <orgId> [login|sub] '
    + '[--name N] [--admin <login|sub>] [--adopt] [--role viewer|operator|admin]');
  process.exitCode = 2;
}

const shellIssuerRaw = () => brandEnv('OIDC_ISSUER') || null;

async function main() {
  if (cmd !== 'list' && (!['create', 'remove', 'add-member', 'remove-member'].includes(cmd) || !orgId)) return usage();
  if ((cmd === 'add-member' || cmd === 'remove-member') && !member) return usage();
  const { db, base } = await openStoreForCli({ name: NAME });

  if (cmd === 'list') {
    const defaultOrg = getMeta(db, 'default_org');
    for (const o of listOrgs(db, { includeRemoved: true })) {
      const members = listMembers(db, o.id).map((m) => `${getUser(db, m.userId)?.login}(${m.role})`).join(' ');
      console.log([o.id, o.name, o.root, o.id === defaultOrg ? 'default' : '-', o.removedAt ? `removed ${o.removedAt}` : 'live', members].join('\t'));
    }
    return;
  }

  if (cmd === 'create') {
    const admin = text('admin');
    const org = createOrgFromAdmin(db, CLI, {
      id: orgId, name: text('name'), adopt: flag('adopt') === true, admin, base, shellIssuerRaw: shellIssuerRaw(),
    });
    console.log(`created org ${org.id} — its root is ${join(base, org.root)}`);
    if (admin) console.log(`${admin} is an admin of ${org.id}`);
    noteShellInit(db);
    return;
  }

  if (cmd === 'remove') {
    const org = removeOrgSoft(db, CLI, orgId);
    console.log(`removed org ${org.id} — its files under ${join(base, org.root)} stay`);
    noteShellInit(db);
    return;
  }

  if (cmd === 'add-member') {
    const role = typeof flag('role') === 'string' ? flag('role') : undefined;
    const r = addMemberByLogin(db, CLI, { orgId, arg: member, role, shellIssuerRaw: shellIssuerRaw() });
    if (r.changed) console.log(`changed ${r.user.login} in ${orgId}: ${r.changed.from} → ${r.changed.to}`);
    else console.log(`${r.user.login} is a member of ${orgId} as ${r.membership.role}`);
    noteShellInit(db);
    return;
  }

  // remove-member
  removeMemberByLogin(db, CLI, { orgId, arg: member, shellIssuerRaw: shellIssuerRaw() });
  console.log(`removed ${member} from ${orgId}`);
  noteShellInit(db);
}

main().catch((e) => {
  console.error(e instanceof CliRefusal ? e.message : `${NAME}: ${e.message}`);
  process.exitCode = 1;
});
