# AGENTS.md

This is a StartOS service-package repository — it builds a `.s9pk` for StartOS.

Develop it inside a StartOS packaging workspace created by `start-cli s9pk init-workspace`,
which provides the packaging guide and agent context one level up. If you're reading this in a
bare clone with no workspace, the full guide is at <https://docs.start9.com/packaging>.

**Start every task at the recipe index** — `../start-technologies/projects/start-sdk/docs/src/recipes.md`
(or <https://docs.start9.com/packaging/recipes.html>). It maps an intent ("prompt the user to create
admin credentials", "expose a web UI") to the constructs, the reference pages, and a named production
package to copy. Find the recipe before you read this package's neighbours: a package you reach by
grepping may be non-conformant, and the recipe outranks it.

Work this package's `TODO.md` from top to bottom. Keep `README.md` (technical reference for an AI support or administering agent) and `instructions.md` (end-user docs) in sync with your changes.

## This repo

- **Ids and ports of the node come from `go-quai-startos`, never a local copy.** `startos/utils.ts` imports them, so a rename there fails this build instead of the runtime.
- **Land a node-package change first, then refresh this lockfile.** `package.json` tracks `go-quai-startos#next` and `npm ci` installs whatever commit the lock names; `npm update` does not move a git dependency (see the guide's `maintaining-a-package.md`).
- **The zone RPC is optional.** Never make the dashboard fail when it is absent: the node only shares it when the user turns it on.
- **Never change a setting on the node package directly.** Ask with a task on its Settings action, which the user approves there.
- **Join password options with `_`, never `,`.** go-quai accepts either, but Canaan/Avalon firmware rejects a comma in the password field.
- **Keep the page free of external requests** — no CDNs, no web fonts, no charting libraries.
- **Don't bundle Quai's Yapari or Monorama fonts, or the Quai logo.** Quai's media kit treats them as brand resources.
- **`dashboard/index.html` is the packaged page.** Regenerate the web preview with `scripts/make-dashboard-preview.sh`; don't hand-edit a second copy.
- **Never let two saves of `stats.json` run at once.** Shutdown triggers a save from both the collector loop and `main`; a shared temp file truncated the history once.
- **Never mark a workshare missed or orphaned on an incomplete payout scan.** A failed block lookup is not evidence of a missing payment.
