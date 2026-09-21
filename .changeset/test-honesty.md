---
"@perch/scripts": patch
---

The e2e server waits for the api as long as Playwright would, and fails plainly if it never comes
up; the Phase 3 spec waits for its three hand-offs to start before it waits for them to finish, and
no longer re-installs the Nest over the API when the button did not; the Phase 2 spec and the
worktrees test wait for their project to be ready before writing into it; and CI runs preflight's
browser acceptance where the browser is, with a test that fails if the browser is missing.
