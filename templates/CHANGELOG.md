# @perch/templates

## 0.1.0

### Minor Changes

- 7ccdff3: Starter stacks, one-click projects, and a Perch that starts with something in it.
  
  `templates/` now holds four starter stacks — a Bun API, a Next.js app, a FastAPI service and a
  static site — served at `GET /api/templates` and pickable from Code mode's New project form.
  Choosing one makes a project that arrives with the stack's files and its own `.perch/project.json`
  already read, so Perch knows the run commands and the preview's port before you touch anything.
  
  The Preview tab can now start it: **Start** runs the project's own `preview.command` on its runner,
  waits for the port, and shows the tail of the dev server's output if it does not come up. **Stop**
  takes it down, along with everything it started.
  
  A fresh instance no longer opens on a set of empty states: `PERCH_DEMO_WORKSPACE` (on by default)
  seeds the first workspace with three channels, two bots and a project from a starter stack just
  after the setup wizard, and `perch demo` does the whole thing in one command on a laptop.
