/**
 * Host half: no-op.
 *
 * The forge panel is a browser-only contribution: `sidebar.panellist` and
 * `main` are client slots, and the data it reads (workspaces, sessions) arrives
 * through the standard props the slot owner already binds. Nothing here needs a
 * host handler, so there is no `harness.handle` counterpart to serve.
 */
export default {
  apply() {},
}
