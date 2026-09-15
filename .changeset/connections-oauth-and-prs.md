---
"@perch/api": minor
---

Connections, part two: the OAuth lane and opening a pull request. Register your own app with a
provider, send someone through the authorization, and the callback turns the code into a connection
— PKCE throughout, with the state single-use so a replayed callback finds nothing. And a project
cloned through a connection can open a pull request on it: Perch mints the token, the runner pushes
the branch with it, and the provider is asked to open the PR, all on a credential that is never
stored and never shown.
