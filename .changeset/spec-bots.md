---
"@perch/api": minor
"@perch/bots": minor
"@perch/web": minor
"@perch/db": minor
---

A bot can live in a repository. Put `bots/<handle>/bot.yaml` next to a `SYSTEM.md` and a `skills/`
folder in any project, and Perch reads it: the bot appears in the workspace, answers where it is
installed, and keeps its persona and skills in version control where they can be reviewed like
anything else. Pushing from the Git panel reloads them; the panel's Reload bots button does the
same after a pull, and says which directory Perch could not read.
