# Live repository tests

`npm run test:live:repos` (`tools/test-live-repos.mjs`) reads real GitHub and
Azure DevOps repositories through the studio's own readers, the way a
signed-in person's **Run** does. `.github/workflows/live-repos.yml` runs it
every Monday, on demand, and on every pull request that changes a reader, the
Run route that words their answers, or the suite's harness.

**Why it exists.** On 2026-11-07 every stubbed test passed while a Run of a
private Azure DevOps repository answered *502 fetch failed*. Azure DevOps
refuses a read with a redirect to its sign-in page unless the request asks
for its 401 (`X-TFS-FedAuthRedirect: Suppress`). The stubs sent the 401
unasked, so nothing caught it (fixed in 0.8.12). A stub says what its author
believes a host does; this suite asks the host.

It needs two test repositories and two read-only tokens, which a person has to
create (below). Until they exist, the private-repository checks skip and say
which value is missing; the rest run.

## What it checks

The studio runs in the test process **with sign-in on** (a local test user
with a password made for that run), a fake MCP as the live side, and the real
hosts behind it. Every request the readers send is recorded by host and by
*which* token it carried (a label, never the value). Every message the suite
writes is masked, and so is every sentence from the server or a host before it
is compared: each token, and an Azure DevOps token's Basic form, which gives
the token back.

| Check | Needs | Proves |
|---|---|---|
| The fixture | nothing (offline) | A folder Run of `tools/fixtures/live-repo` reads three files, one of each kind, into a valid pack: what each host must return. |
| GitHub, public | the network | A public repository (`MoebiusX/Observogram`) reads with no token; nothing carries an `Authorization` header; the files come from raw.githubusercontent.com, with at most two API calls. |
| GitHub, private: refusals | `OBSERVOGRAM_LIVE_GITHUB_REPO` | No token is answered *404 … Not Found* with the way to give one; a made-up token is answered *401 … Bad credentials* as refused. |
| GitHub, private: the read | the repository and `OBSERVOGRAM_LIVE_GITHUB_TOKEN` | The Run scans the fixture, the same scan as the folder; the files match the fixture byte for byte; the token went to api.github.com only; the next Run without it has none. |
| Azure DevOps: refusals | `OBSERVOGRAM_LIVE_ADO_REPO` | No token is *this repository is not public*; a made-up token is *not authorised to read this repository*; every call asks for the 401 and follows no redirect. |
| Azure DevOps: the read | the repository and `OBSERVOGRAM_LIVE_ADO_TOKEN` | As GitHub's: the fixture, byte for byte, the token to the repository's host only. |
| Unreachable | DNS | A host whose name does not resolve (`ado.observogram.invalid`) is answered 502 with the reason, and asks for no token. |
| No leak | nothing | No token or password is in a log line, an answer, a request's URL, another header or a body, or anything the live side was sent; each real token went only to its repository's host. |

The refusal checks assert the exact sentence the service row shows, so a
host that changes its answer fails the week it does. A value that is set but
cannot be what it names (a GitHub URL instead of `owner/name`, an Azure DevOps
URL off dev.azure.com) fails its host's checks with what it must be, rather
than skipping.

## What to create

Only a person can create these: accounts, organizations and tokens are
created by their owner, and nobody should paste a token into a chat or a
file. Use throwaway repositories that hold only the fixture.

### 1. A private GitHub repository and a read-only token

1. Create a **private** repository, for example `MoebiusX/observogram-live-test`.
   Creating it with a README is fine: the scan does not read one.
2. Push the fixture to its root, from a checkout of this repository (Git Bash
   on Windows runs these as they are):

   ```bash
   git clone https://github.com/MoebiusX/observogram-live-test.git live-test
   cp -r tools/fixtures/live-repo/. live-test/
   cd live-test && git add -A && git commit -m "The live-repository fixture" && git push
   ```

3. Create a **fine-grained personal access token** as the account that owns
   the repository: GitHub → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → *Generate new token*.
   - **Resource owner:** that account (an organization, when the repository
     is in one; it may have to approve the token).
   - **Repository access:** *Only select repositories* → the test repository.
   - **Permissions:** Repository → **Contents: Read-only** (GitHub adds
     *Metadata: Read-only*). Nothing else.
   - **Expiration:** 90 days. The weekly run fails with *your GitHub token
     was refused* when it lapses; make a new one then.

   A separate account is not needed: such a token can read nothing private
   except that repository. A machine account works only if the test
   repository is in an organization: make the machine account a member with
   the Read role, and choose the organization as the token's resource owner.
   A personal account's repository (MoebiusX is one) gives a collaborator
   write access, and a fine-grained token cannot reach a repository its
   account is only a collaborator on.

### 2. An Azure DevOps organization, a private repository and a read-only token

1. Create an organization at <https://aex.dev.azure.com> (*New organization*).
   Microsoft now asks for an active Azure subscription to create one; the free
   tier, which covers this suite, costs nothing. An organization you already
   have works too, but a personal access token reads every repository in its
   organization that you can read, so a separate one keeps the token to the
   test repository.
2. Create a project, for example `live-test`. New projects are private:
   Azure DevOps no longer creates public ones.
3. In the project's **Repos**, use the default repository or create one (for
   example `checkout`), and push the fixture to its root with your own
   sign-in (the read-only token below cannot push):

   ```bash
   git clone https://dev.azure.com/<org>/live-test/_git/checkout live-test-ado
   cp -r tools/fixtures/live-repo/. live-test-ado/
   cd live-test-ado && git add -A && git commit -m "The live-repository fixture" && git push
   ```

4. Create a **personal access token**: User settings → Personal access
   tokens → *New Token*.
   - **Organization:** the test organization only.
   - **Scopes:** *Custom defined* → **Code: Read**. Nothing else.
   - **Expiration:** 30 to 90 days.

### 3. Optional: the sign-in paths

The suite reads with tokens; it cannot click through a host's sign-in page.
To check *Sign in to GitHub* and *Sign in to Azure DevOps* by hand, register
the apps the README's *Signing in to GitHub or Azure DevOps* section lists:

- **GitHub:** a GitHub App with Repository *Contents* and *Metadata*,
  read-only, installed on the test repository only, with the callback URL
  `<studio>/auth/repo/github/callback`.
- **Azure DevOps:** a Microsoft Entra ID app registration with the delegated
  permission `499b84ac-1321-427f-aa17-267ca6975798/vso.code` (Azure DevOps,
  *Code (read)*), a client secret, and the Web redirect URI
  `<studio>/auth/repo/ado/callback`. The test organization must be connected
  to that Entra ID tenant (Organization settings → Microsoft Entra). If it is
  not, Azure DevOps refuses the sign-in: the row says *not authorised to read
  this repository*, and, when Azure DevOps names the tenant the organization
  signs in through, it names that tenant and yours. An organization connected
  to no tenant names none.

Give the studio their values: `OBSERVOGRAM_GITHUB_CLIENT_ID` and
`OBSERVOGRAM_GITHUB_CLIENT_SECRET`, and `OBSERVOGRAM_ADO_CLIENT_ID` and
`OBSERVOGRAM_ADO_CLIENT_SECRET` (and `OBSERVOGRAM_PUBLIC_URL` when `<studio>`
is not the address the browser uses). Without them no **Sign in to …** is
offered. Then sign in to the studio, add a service on each test repository,
press **Sign in to …** on its row and **Run**.

## Where each value goes

In this repository on GitHub: Settings → Secrets and variables → Actions.

| Name | Kind | Value |
|---|---|---|
| `OBSERVOGRAM_LIVE_GITHUB_REPO` | Variable | `owner/name` of the private GitHub repository, for example `MoebiusX/observogram-live-test` (no URL, no branch) |
| `OBSERVOGRAM_LIVE_GITHUB_TOKEN` | Secret | the fine-grained token |
| `OBSERVOGRAM_LIVE_ADO_REPO` | Variable | the repository's URL as its clone dialog shows it, without a user name: `https://dev.azure.com/<org>/<project>/_git/<repo>` |
| `OBSERVOGRAM_LIVE_ADO_TOKEN` | Secret | the personal access token |

The repository names are variables, not secrets, so the log can name them.
GitHub gives the secrets to scheduled and manual runs and to pull requests
from branches of this repository. It never gives them to a fork's pull request,
and gives Dependabot's only Dependabot secrets. The workflow runs for neither:
the weekly run covers an action bump. Each run's summary says which values
were set, never what they are.

Then run the workflow once: Actions → *live-repos* → *Run workflow*. Every
check should pass and none should skip.

## Running it on your own machine

The same four variables, in your own shell (never in a file in this
repository):

```bash
export OBSERVOGRAM_LIVE_GITHUB_REPO=MoebiusX/observogram-live-test
export OBSERVOGRAM_LIVE_ADO_REPO=https://dev.azure.com/<org>/live-test/_git/checkout
read -rs OBSERVOGRAM_LIVE_GITHUB_TOKEN && export OBSERVOGRAM_LIVE_GITHUB_TOKEN
read -rs OBSERVOGRAM_LIVE_ADO_TOKEN && export OBSERVOGRAM_LIVE_ADO_TOKEN
npm run test:live:repos
```

PowerShell (Windows PowerShell 5.1 and PowerShell 7 alike), for a token
without echoing it:

```powershell
$env:OBSERVOGRAM_LIVE_GITHUB_REPO = 'MoebiusX/observogram-live-test'
$s = Read-Host -AsSecureString; $env:OBSERVOGRAM_LIVE_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
npm run test:live:repos
```

`OBSERVOGRAM_LIVE_GITHUB_PUBLIC_REPO` changes the public repository the
suite reads (`off` skips that check). The suite reads these variables first
and removes them from its environment before the studio starts. It also
removes `GITHUB_TOKEN` and `AZURE_DEVOPS_TOKEN`, which a studio with sign-in
ignores anyway.

## When it fails

| It says | Usually |
|---|---|
| *your GitHub token was refused* / *not authorised to read this repository* on the read | The token expired or lost its access: make a new one and replace the secret. |
| *a private repository reads as not there without a token — is it private?* (GitHub) / *a private repository is refused without a token — is it private?* (Azure DevOps) | The test repository was made public. |
| *… must be owner/name …* / *… must be a repository on Azure DevOps Services …* | The variable holds something else: set it as the table above says. |
| `missing` / `extra` / `differ` paths | The test repository no longer holds the fixture at its root, or the fixture changed here: push `tools/fixtures/live-repo` again. |
| *GitHub's quota without a token is spent here* (a skip) | The public read (two API calls, the repository and its tree; its files come from raw.githubusercontent.com, outside the quota) and the two Runs without a token share the runner's 60-calls-an-hour quota. The skip is decided from GitHub's own sentence (*API rate limit exceeded*, as a 403 or a 429), not from the status the Run route answers, which turns a 429 into a 502. |
| *files read: 0 of N — skipped: <path>: it could not be downloaded (GitHub 429 on <path>); …* | raw.githubusercontent.com refused every download of the public read, sent 8 at a time. It fails rather than skips, naming the first three files, so the weekly run shows what raw answered; run it again later. |
| *files read: 0 of N — skipped: <path>: it could not be downloaded (the read's 120 s for its files ran out); …* | The host answered too slowly for 200 files at 8 at a time within 120 s (`HOST_READ_FILES_BUDGET_MS` in `server/github-crawl.mjs`, about 5 s a file): every file not started by then, and every one still in flight, is skipped with that sentence (a file that had already waited its own 60 s says *did not answer within 60 s* instead), and the check fails only when none was read. Run it again; if it repeats, say so in an issue — the budget is a constant, not a setting. |
| An exact sentence differs on a refusal | The host changed how it answers. That is what this suite is for: fix the reader and its stubs to the new answer, measured, and say so in the CHANGELOG. |
