[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/anangdexta02/github-core-clone-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/anangdexta02/github-core-clone-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Forge — a GitHub-compatible git forge

A single-process git forge for the make.fun bounty
"github-core-clone-01". It serves, from one in-memory store:

- git smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`)
  with protocol v2 and v0, shallow fetches and report-status pushes —
  the packfile and pkt-line protocols implemented by hand on
  `node:zlib` and `node:crypto`;
- GitHub REST v3: repositories, branches, commits, contents, labels,
  issues, comments, pull requests and squash merges;
- GitHub GraphQL v4: the queries and mutations `gh` and
  `github-mcp-server` send, with opaque stable global ids;
- MCP over streamable HTTP: `server/discover`, `tools/list`,
  `tools/call` for the six repository tools.

Node 22, standard library only, no dependencies, no git binary.
`main.ts` is the harness lifecycle (bind an ephemeral port, register
with the env, wait for done); the forge itself lives in `app.ts` and
the modules beside it.

## Layout

- `store.ts` — the object store, trees/commits, repositories, issues
- `pack.ts` — pkt-lines and packfiles (read/write, delta resolution)
- `githttp.ts` — advertisements, ls-refs, fetch, receive-pack
- `rest.ts` — REST v3 resources
- `graphql.ts` — a small GraphQL parser/executor and the v4 schema
- `mcp.ts` — the MCP endpoint and its tools
- `http.ts` — shared JSON plumbing and the bearer-token rule

MIT licensed (see LICENSE).
