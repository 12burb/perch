---
"@perch/api": minor
"@perch/web": minor
"@perch/runner": minor
"@perch/cli": patch
"@perch/db": minor
"@perch/events": minor
"@perch/policy": patch
"@perch/api-client": minor
---

Projects: create one empty, upload files into one, or clone a repository (public, with an access
token, or with the workspace's SSH deploy key) from Code mode or the API; the directory is set up on
a runner, `.perch/project.json` is validated and applied, `devcontainer.json` is read and its
`postCreateCommand` runs, and the row's status updates live.
