# Changesets

Every task PR adds a changeset (`bun run changeset`) describing the user-visible change. Changesets produce
the changelog and version bumps at release time (`.github/workflows/release.yml`). Private workspaces are
versioned but never tagged or published.
