---
"@perch/api": patch
---

A bot handle is only taken if somebody in the same workspace has it. `@dawn` means whoever is
called that here, so a person called Dawn in another workspace no longer stops a workspace from
having a bot called `@dawn` — which had been failing the Nest install for anyone whose instance
had grown past one workspace.
