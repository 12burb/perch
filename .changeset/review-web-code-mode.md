---
"@perch/web": patch
"@perch/ui": patch
"@perch/api": patch
---

Code mode keeps what you told it. A long session opens whole (the transcript replay reads page
after page until it has caught up), and a permission that arrives while a replay is on its way is
no longer missed. Replayed permissions show as answered instead of offering Allow / Deny again;
only the one the session is waiting on can be answered. Typing during a save is kept; a turn the
api refuses keeps its text and its context chips; a ⌘K prompt action waits until the session is
free and then runs, whether the pane was open or not; a run action is typed into an open terminal
at once; Reconnect reattaches to the same shell. Switching branches reloads the file tree and the
open files; opening a file from the tree keeps the session panel open; "Ask the agent to address
it" opens the session it started and says so; switching sessions starts the pane clean.

Signing out releases this device's push notifications and, like signing in and signing up, loads
the page afresh, so nothing of one person's session is shown to the next one in the same tab.
Revoking a share link and removing a relation no longer report "request failed with 204", and an
error page from a proxy reads as "request failed with <status>". The file tree says why a listing
or a search failed. The Database panel draws tables and rows a hundred at a time. A workspace
whose slug starts with "settings" shows its own modes, and a workspace can no longer take a slug
that is one of the app's own paths (`settings`, `welcome`, `sign-in`, `api`, ...).
