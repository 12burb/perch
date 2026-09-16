# @perch/inspector

## 0.1.0

### Minor Changes

- a451282: The inspector. Press **Inspect** (or ⌘⇧C) in the Preview tab and click something in the page: Perch
  tells you what it is, shows the Elements tree, and — with the `@perch/inspector` dev plugin in the
  project — says which file and line it was written at. **Use as context** turns that into a chip on
  the session composer, so "make this primary" edits the file you pointed at.
  
  The console and failed-requests strip collects what the page logged and every request that came back
  not-ok, each with **Send to agent**. **Screenshot** asks the runner's own headless browser for a
  picture, which is either attached to the next turn or posted straight into a channel.
  
  The client is injected by the preview proxy only for a member's own preview pane, signed with a
  nonce per response, and never for a share link.
