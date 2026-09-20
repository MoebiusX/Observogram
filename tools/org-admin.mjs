#!/usr/bin/env node
/**
 * tools/org-admin.mjs — manage orgs.json (npm run orgs).
 *
 * Stage 2 tenancy for docs/PRODUCTIZATION_PLAN.md: org membership lives
 * file-first in <workspace>/orgs.json. The file EXISTING is what arms
 * tenancy — create the first org, restart, and every /api request runs
 * in an org workspace (<workspace>/orgs/<orgId>/).
 *
 *   npm run orgs -- create acme [--name "Acme Corp"]
 *   npm run orgs -- remove acme
 *   npm run orgs -- add-member acme alice [--role admin]
 *   npm run orgs -- remove-member acme alice
 *   npm run orgs -- list
 *
 * Roles are recorded for Stage 3 (authorization); Stage 2 enforces
 * membership only. Tenancy requires identity (OIDC or users.json) —
 * the server refuses to start with orgs.json and no identity.
 */

import { existsSync } from 'node:fs';
import { readOrgs, writeOrgs, orgsFilePath, validOrgId } from '../server/tenancy.mjs';

const args = process.argv.slice(2);
const [cmd, orgId, member] = args;

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

function main() {
  const file = orgsFilePath();
  const orgs = readOrgs(file);

  if (cmd === 'list') {
    const ids = Object.keys(orgs).sort();
    if (!ids.length) {
      console.log(`no orgs in ${file}${existsSync(file) ? '' : ' (file does not exist — tenancy is OFF)'}`);
      return;
    }
    for (const id of ids) {
      const o = orgs[id];
      const members = Object.entries(o.members || {}).map(([s, r]) => `${s}(${r})`).join(' ') || '(no members)';
      console.log(`${id}\t${o.name || ''}\t${members}`);
    }
    return;
  }

  if (!['create', 'remove', 'add-member', 'remove-member'].includes(cmd) || !orgId) {
    console.error('usage: npm run orgs -- <create|remove|add-member|remove-member|list> <orgId> [member] [--name N] [--role R]');
    process.exit(2);
  }
  if (!validOrgId(orgId)) throw new Error(`org id must match ^[a-z][a-z0-9_-]*[a-z0-9]$ (2-64 chars): ${orgId}`);

  if (cmd === 'create') {
    if (orgs[orgId]) throw new Error(`org exists: ${orgId}`);
    orgs[orgId] = { name: flag('name', orgId), members: {} };
    writeOrgs(orgs, file);
    console.log(`created org ${orgId} (${file})`);
    if (Object.keys(orgs).length === 1) {
      console.log('tenancy is now ON — restart the server. Note: tenancy requires identity (users.json or OIDC).');
    }
    return;
  }
  if (cmd === 'remove') {
    if (!orgs[orgId]) throw new Error(`no such org: ${orgId}`);
    delete orgs[orgId];
    writeOrgs(orgs, file);
    console.log(`removed org ${orgId} — its workspace directory (orgs/${orgId}/) is left on disk; delete it manually if intended`);
    return;
  }
  if (!member) throw new Error(`${cmd} needs a member (the user's sub — username for stand-alone, IdP sub for OIDC)`);
  if (!orgs[orgId]) throw new Error(`no such org: ${orgId}`);
  orgs[orgId].members = orgs[orgId].members || {};
  if (cmd === 'add-member') {
    orgs[orgId].members[member] = flag('role', 'member');
    writeOrgs(orgs, file);
    console.log(`added ${member} to ${orgId} as ${orgs[orgId].members[member]}`);
  } else {
    if (!Object.hasOwn(orgs[orgId].members, member)) throw new Error(`${member} is not a member of ${orgId}`);
    delete orgs[orgId].members[member];
    writeOrgs(orgs, file);
    console.log(`removed ${member} from ${orgId}`);
  }
}

try { main(); } catch (e) { console.error(`org-admin: ${e.message}`); process.exit(1); }
