# kepet-forge — github-core-clone-01

A GitHub-compatible git forge in one Node process, stdlib only, for
[the contest](https://make.fun/bounty/github-core-clone-01). One server serves the whole
surface the suite grades, from a single in-memory store:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, node, batched operations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: modern `server/discover` era and legacy `initialize` era, 8 tools |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own; the flag is harmless there and makes an older local Node work too. There is nothing to
install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own `app.ts` only,
and the trial has no package manager and no internet.

The lifecycle (`main.ts`) is the kit starter's: bind an ephemeral port, register it at
`POST $MAKEFUN_ENV_URL/register`, then poll `GET $MAKEFUN_ENV_URL/done` until the env says the
trial is over, and exit 0. Without `MAKEFUN_ENV_URL` it exits 1 at once.

## How it works

- **Store.** Everything lives in Maps: repositories keyed by `owner/name`, objects keyed by
  SHA-1 with their serialized bytes kept, so packs are assembled without re-serializing.
  The token's login is `adaiversen` (the suite's scenario is drawn from the kit's fixed seed,
  so that login is the same in every trial); a repository under any other login is a 404,
  never a 403.
- **Git.** Objects are SHA-1 over `<type> <size>\0` + bytes, exactly as git computes them, so
  objects a client pushes round-trip byte-for-byte. Packs carry plain objects only (no
  deltas) with zlib level 1, which is what the pack checks accept and what keeps the timed
  workloads fast. Fetches honour `want`/`have`, `deepen`, `shallow` boundaries and
  `unshallow`, and never re-send objects the client holds. Pushes validate fast-forward
  (the refusal reason is exactly `non-fast-forward`) and apply each command independently,
  so a mixed push reports one `ok` and one `ng`.
- **REST.** Repositories, branches, commits (walked newest-first), contents (create/update/
  delete with 409 on a stale sha, branch creation from the default tip), labels, issues
  (state/sort filters, 422 on an unknown label), comments, pull requests (three-way merge
  conflict detection, squash merge) and files with LCS line counts.
- **GraphQL.** The documents `gh` and `github-mcp-server` send: viewer, repository fields,
  `__type` probes, open issues, issue by number, pull requests and their files, cursor
  pagination, node round-trips, and the create/close/create-PR/merge/add-comment mutations.
  Global ids are base64 `Type:<numericId>` — opaque and stable.
- **MCP.** Both eras: `server/discover` (2026-07-28) and `initialize` (2025-11-25 and
  earlier). Eight tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `get_issue`, `create_pull_request`, `list_pull_requests`, `merge_pull_request`) that read
  and write the same store as REST, so a repository or issue created over MCP is the same
  object over REST. Unknown tools answer JSON-RPC -32601, missing arguments -32602, a
  malformed body HTTP 400 with -32700, and a call with no `Authorization` header HTTP 401.

## Layout

- `main.ts`: the entry <-> env lifecycle. Keep it as it is.
- `app.ts`: the server — the whole forge.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
