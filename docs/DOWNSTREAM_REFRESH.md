# Refreshing a downstream copy

This is the runbook for a downstream that keeps **the whole repository** as a
folder of its own repository and runs it as its product, with its own files
beside it. It takes that copy from one upstream version to the next.

## Words used here

| Word | Means |
| --- | --- |
| **upstream** | this repository, `MoebiusX/Observogram` |
| **downstream** | the repository that keeps a copy of upstream |
| **the copy** | the folder in the downstream that holds upstream's files (`vendor/observogram-app/` below) |
| **the plugin layer** | the downstream's own files that the copy reads through its seams ([DOWNSTREAM.md](DOWNSTREAM.md) §9), kept outside the copy |
| **a local patch** | a downstream change to a file inside the copy |
| **you** | whoever maintains the downstream |

This runbook never says "ours" or "theirs" for a side. Git does, and the
meaning flips from one command to the next. *Which side is which* below says
what each word means for each command.

## Which document to follow

| You keep | Follow |
| --- | --- |
| The whole repository, run as your product | this runbook |
| Some `tools/lib` modules | [DOWNSTREAM.md](DOWNSTREAM.md) §3 to §6 |
| Engine and studio files inside a studio of your own | [VENDORING.md](VENDORING.md), *Staying current* |
| The Overview board inside an app of your own | [VENDORING.md](VENDORING.md), *The Overview board*. Import its files from the copy, so they refresh with it |

## The aim: a copy you replace, never merge

When nothing inside the copy is patched, a refresh deletes the folder, writes
the new version in its place and proves that it matches upstream byte for
byte. Nothing merges, so nothing conflicts.

Everything the downstream needs of its own belongs in the plugin layer,
through a seam ([DOWNSTREAM.md](DOWNSTREAM.md) §9). A change no seam can make
yet is a local patch. Keep it in one commit of its own (step 4), and send it
upstream (*Sending a change upstream*), because every refresh pays for it.

## Once, before the first refresh

1. **Keep nothing of the downstream's inside the copy.** Step 3 deletes the
   folder. The workspace, `.env` files and the plugin layer live outside it,
   and `node_modules` is rebuilt by step 5. A workspace inside the copy moves
   out, with `OBSERVOGRAM_WORKSPACE` pointing at its new place.
2. **Leave the copy out of checks that run when you commit:** scanners, linters
   and formatters. Its files are upstream's, step 3 proves it, and a rewritten
   file breaks that proof. If a check cannot leave a path out, send upstream
   the check's own findings (file, line, rule name), not a pattern that
   approximates the rule.
3. **Keep a clone of upstream beside the downstream:**

   ```bash
   git clone https://github.com/MoebiusX/Observogram.git ../observogram-upstream
   ```

4. **Record the version the copy holds** in `vendor/UPSTREAM`, outside the
   copy: on the first line the tag it came from (or the commit, for a copy
   taken from `develop`), on the second the full commit id. Step 3 writes it
   from then on.
5. **On Windows, let git write long paths:**

   ```bash
   git config core.longpaths true
   ```

   At 0.6.2 the copy's longest path is 149 characters under the downstream's
   root (`vendor/observogram-app/` and a 126-character golden file name).
   Without this setting, git refuses any path past 260 characters, and step
   3's `git add` stops and stages nothing once the checkout's own path is
   longer than 109 characters. The setting belongs to the repository and
   needs no administrator.

## Each refresh

The commands run from the downstream's root, in a POSIX shell (Git Bash on
Windows).

### 1. Pick the target and read what changes

```bash
git -C ../observogram-upstream fetch --tags origin
git -C ../observogram-upstream checkout -q --detach origin/develop   # the newest digest and export tools
TARGET=v0.6.2                 # a release tag, or a develop commit when a fix you need is not released yet
FROM=$(sed -n 2p vendor/UPSTREAM)
node ../observogram-upstream/tools/downstream-digest.mjs --since "$FROM" --to "$TARGET" > ../digest-$TARGET.txt
git -C ../observogram-upstream show "$TARGET:docs/CHANGELOG.md" > ../CHANGELOG-$TARGET.md
```

**The digest** (`tools/downstream-digest.mjs`) reads upstream's clone, the
one it sits in, and prints for the range from the commit the copy holds to
the target:

- the number of commits;
- the `Downstream:` bullet of every CHANGELOG entry added in the range,
  grouped by kind, the hardest to undo first (`one-way`, `config`, `api`,
  `behaviour`, `none`), and, under *unclassified*, the headings of the entries
  written before the bullet existed;
- the export diff of `VENDOR-MANIFEST.json`: modules new, no longer listed,
  and exports added or removed;
- the settings that appear or disappear in `server/`, `tools/` and `studio/`
  (test files and fixtures left out), compared by the part after
  `OBSERVOGRAM_` as step 5 compares them;
- the golden files that moved under `tools/fixtures/golden/`, which say
  where upstream's own output changed on purpose.

`--json` prints the same as one object. Run it in upstream's clone, never in
the copy: a copy has no `.git`, and the digest refuses to read the
downstream's history in its place.

**Every CHANGELOG entry from 0.8.28 on ends with one bullet** that says what
it means for a copy:

```markdown
- **Downstream:** <kinds> — <one sentence>.
```

| Kind | Means |
| --- | --- |
| `none` | nothing for a downstream to do |
| `config` | a setting added, renamed or removed |
| `api` | a listed module's exports, a route or a response shape |
| `behaviour` | what a comparison, grade or screen shows |
| `one-way` | an upgrade with no way back, such as a store schema move |

An entry can name several kinds, separated by commas (`config, api`), and
`none` stands alone. Upstream's build fails on an entry without the bullet
(`tools/test-changelog-downstream.mjs`). The entries of releases before 0.8.28
carry none, and the digest lists them as *unclassified*: read those in the
CHANGELOG.

From the digest and those entries, note:

- **One-way upgrades** (`one-way`). A store schema move is one. 0.6.2 moves
  the store to schema v3, and 0.6.0 then refuses the database.
- **Settings** renamed, removed or added (`config`, and the digest's
  settings). Step 5 checks the ones you set.
- **Exports and routes** your plugin layer calls (`api`, and the digest's
  export diff).
- **Declared changes for the browser suites** (`behaviour`): what your own
  browser tests will see differently, on purpose.
- **The Node floor:** `engines` in the target's `package.json` (22.23.4 for 0.6.2).

### 2. Back up the store

```bash
OBSERVOGRAM_WORKSPACE=<the server's workspace> \
  node vendor/observogram-app/tools/cli.mjs store backup ../backups/observogram-before-$TARGET.db
```

Give it the server's own `OBSERVOGRAM_WORKSPACE` (or `OBSERVOGRAM_DB`). This
runs the copy you are leaving, and it is safe while the server runs. Across a
one-way upgrade, the backup is the only way back (README, *Back Up And Restore
The Store*).

### 3. Replace the copy and prove it

Stop the server first: this step replaces the code it runs.

```bash
git -C ../observogram-upstream checkout -q --detach origin/develop   # the newest export tool
rm -rf vendor/observogram-app
node ../observogram-upstream/tools/vendor-export.mjs --ref "$TARGET" --out vendor/observogram-app
node ../observogram-upstream/tools/vendor-export.mjs --check vendor/observogram-app
git add -A -f vendor/observogram-app
```

- **The export** writes the target's files, byte for byte from the commit. It
  leaves out what upstream's `.gitattributes` marks `export-ignore`: its own
  CI, agent settings and agent instructions (`.github/`, `.claude/`,
  `AGENTS.md`), which would read as rules to an agent working in the
  downstream. `git archive` and GitHub's source tarballs carry the same
  files. Beside them it writes `VENDOR-TREE.json`: the commit, its version
  and every file's sha256.
- **`--check`** proves the copy against that list and prints
  `all <n> files match`. Any other line names a file and how it differs:
  `changed`, `local patch` (changed, and marked), `line endings`,
  `missing` or `extra`. It needs neither git nor the clone, so once the copy
  holds the tool, `node vendor/observogram-app/tools/vendor-export.mjs --check
  vendor/observogram-app` proves it again at any time.
- **`git add -f`** stages the files the downstream's `.gitignore` would keep
  out. That is safe here, because the folder holds nothing but the export.
- **Without a clone**, for example where the downstream cannot reach GitHub,
  someone who has one runs the export and carries the folder across. `--check`
  proves it on arrival.

Then record the version and commit the copy on its own:

```bash
printf '%s\n%s\n' "$TARGET" "$(git -C ../observogram-upstream rev-parse "$TARGET^{commit}")" > vendor/UPSTREAM
git add vendor/UPSTREAM
git commit -m "chore(vendor): observogram-app to $TARGET"
```

This commit holds upstream's files and nothing else, so it can be proven again
at any time.

### 4. Put back the local patches

Skip this step when the previous refresh had none.

Every local patch lives in one commit made right after a copy commit, so the
upstream version it was written against is known. Re-apply it:

```bash
git cherry-pick -x <the previous refresh's local-patch commit>
```

`cherry-pick` merges three ways, with the previous copy commit as the base, so
only lines that both upstream and the patch changed conflict. In a conflict
here, `--ours` is the new upstream copy and `--theirs` is your local patch.
Decide by content, not by those words: keep upstream's version of each line,
then add back only the lines marked as a local deviation. If upstream now does
what the patch did, drop the patch (`git cherry-pick --skip`).

Mark every changed line `// LOCAL DEVIATION (<org> <TAG>): <why>`
([DOWNSTREAM.md](DOWNSTREAM.md) §4), so that step 5 names it as a known patch.
In the commit message, list the upstream tests the patch makes fail.

**The first refresh out of a merged copy** has no local-patch commit yet. After
step 3, re-apply by hand only the patches you keep (for the eleven-patch
hand-off, [VENDORING.md](VENDORING.md), *Bumping past the eleven-patch
hand-off*, says which), and commit them alone. That commit is the one to
cherry-pick next time.

### 5. Install and check

```bash
(cd vendor/observogram-app && npm ci)
node vendor/observogram-app/tools/gen-vendor-manifest.mjs --verify vendor/observogram-app
node vendor/observogram-app/tools/gen-vendor-manifest.mjs --smoke vendor/observogram-app
(cd vendor/observogram-app && npm test)
```

- **`--verify`** prints `ok` for every listed module. It prints
  `drift (local patch (marked LOCAL DEVIATION) …)` for a module you patched on
  purpose, and then exits 1. Any other drift means the copy is not what step 3
  proved.
- **Behind a registry mirror**, give npm the mirror for the install, with
  `npm_config_registry=<mirror> npm ci` or the user's own npm configuration
  (`npm config set registry <mirror>`). Never edit the copy's
  `package-lock.json`: npm 10 swaps the lockfile's `registry.npmjs.org` for the
  configured registry as it installs (`replace-registry-host`, `npmjs` by
  default), and the integrity hashes hold for the same packages. An `.npmrc`
  inside the copy is a local file that step 3 deletes, and npm does not read
  the downstream root's `.npmrc` for the copy, which has its own
  `package.json`.
- **`npm test`** runs upstream's own suite on your copy. With no local patch it
  passes, as it did upstream. Six tests skip inside a copy, each printing
  `# SKIP an export copy: <why>`: three read upstream's CI workflow, which the
  export leaves out, and the three of `tools/test-vendor-export.mjs` export a
  git checkout of the repository, which a copy is not. Upstream runs all six. With one, the only failures should be the tests
  its commit message lists. A patch to a module the manifest lists always
  fails one more, `tools/test-vendor-manifest.mjs`, because the file no longer
  matches its recorded hash.

Check that every setting you set still exists upstream:

```bash
grep -rhoE 'OBSERVOGRAM_[A-Z0-9_]+' plugins/ <your deployment files> \
  | sed -E 's/^OBSERVOGRAM_//; s/^ORG_[A-Z0-9]+_//' | sort -u > ../settings-set.txt
git -C ../observogram-upstream grep -hoE '[A-Z][A-Z0-9_]+' "$TARGET" -- server tools studio \
  | sed -E 's/^(OBSERVOGRAM|TOMOGRAPH)_//' | sort -u > ../settings-known.txt
comm -23 ../settings-set.txt ../settings-known.txt
```

The code reads most settings by the part after `OBSERVOGRAM_`, so the check
compares that part, and it compares a per-org name (`OBSERVOGRAM_ORG_<KEY>_…`)
by the part after the key. Each name it prints is one you set that the
target's code never mentions: renamed or removed, so look it up in the
CHANGELOG. A notify hook's own names (`…_NOTIFY_<HOOK>_URL`) print too, since
the hook's name is yours ([DOWNSTREAM.md](DOWNSTREAM.md) §17).

### 6. Run the downstream's own checks

Start the server through the plugin layer and open the studio once. Run your
own unit and browser suites. The declared changes you noted in step 1 say which
browser expectations moved on purpose. Anything else that moved is a question
for upstream.

### 7. Roll back

```bash
git revert --no-edit <local-patch commit> <copy commit>
```

Revert the newer commit first. If the new version has already opened the
store, restore the backup from step 2 (`packc store restore`, README,
*Upgrade And Roll Back*). After a one-way upgrade, nothing else gets the old
version running again.

## What upstream promises a copy

- **Every commit exports the same way.** The export is the commit's tree minus
  `export-ignore`, written from its blobs, so two exports of one commit are
  identical, and `git archive` gives the same files.
- **`export-ignore` names only the repository's own operation:** its CI, its
  agent settings and its agent instructions. Everything that runs, tests or
  documents the product ships.
- **No build step.** The exported files run as they are, after `npm ci`.
- **Releases are the bump points.** Each release section of the CHANGELOG
  says what changed for a copy, and from 0.8.28 on each entry says it in its
  `Downstream:` bullet. A `develop` commit works too: the digest reads its
  `## Unreleased` entries with the rest.

## Which side is which

Git calls the two sides of a conflict *ours* and *theirs*, and which side each
word names depends on the command, not on the repository:

| Command | `--ours` | `--theirs` |
| --- | --- | --- |
| `git cherry-pick` of a local patch (step 4) | the new upstream copy | the local patch |
| `git apply --3way`, `git am -3`, `git rebase` onto a new upstream | the new upstream copy | the local patch |
| `git merge` or `git subtree pull` of upstream into the downstream | the downstream, local patches included | upstream |

Before you type `git checkout --ours` or `--theirs`, find your command in this
table.

## Sending a change upstream

Every local patch costs every refresh, so the goal is none.

- **A value that belongs to one team, service or environment is
  configuration:** a variable, or a file in the plugin layer, never a patch to
  `tools/lib`. Ask upstream for the seam if there is none.
- **An engine change** goes as one patch per theme, cut from a named upstream
  commit, with a short note and a fixture that shows it
  ([VENDORING.md](VENDORING.md), *Sending more upstream*).
- **A finding from a check that runs when you commit** goes as that check's own
  output: the file, the line and the rule's name.

A patch upstream merges stops being a local patch at the next refresh: step 4
drops it.
