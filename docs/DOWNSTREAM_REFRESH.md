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
TARGET=v0.6.2                 # a release tag, or a develop commit when a fix you need is not released yet
FROM=$(sed -n 2p vendor/UPSTREAM)
git -C ../observogram-upstream log --oneline "$FROM..$TARGET" | wc -l
git -C ../observogram-upstream show "$TARGET:docs/CHANGELOG.md" > ../CHANGELOG-$TARGET.md
```

Read every section of that CHANGELOG above the version you are on, and note:

- **One-way upgrades.** A store schema move is one. 0.6.2 moves the store to
  schema v3, and 0.6.0 then refuses the database.
- **Settings** renamed, removed or added. Step 5 checks the ones you set.
- **Declared changes for the browser suites:** what your own browser tests
  will see differently, on purpose.
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
rm -rf vendor/observogram-app
mkdir vendor/observogram-app
git -C ../observogram-upstream -c core.autocrlf=false archive "$TARGET" | tar -x -C vendor/observogram-app
git add -A vendor/observogram-app
test "$(git write-tree --prefix=vendor/observogram-app/)" = "$(git -C ../observogram-upstream rev-parse "$TARGET^{tree}")" \
  && echo "the copy is upstream's $TARGET, byte for byte"
```

The check compares the copy, as staged, with upstream's own tree for the
target: one hash for every file, its path and its bytes. If it prints nothing,
the copy is not upstream's. List the files that differ:

```bash
diff <(git -C ../observogram-upstream ls-tree -r --name-only "$TARGET") \
     <(git ls-files vendor/observogram-app | sed 's#^vendor/observogram-app/##')
```

A file marked `<` is one the downstream's `.gitignore` keeps out. Stage them
with `git add -f vendor/observogram-app` and run the check again. That is safe
at this point, because the folder holds nothing but upstream's files yet. If
the list is empty, a file's bytes changed on the way in: repeat step 3 as
written.

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
- **`npm test`** runs upstream's own suite on your copy. With no local patch it
  passes, as it did upstream. With one, the only failures should be the tests
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
