// studio/host.mjs
//
// The studio-wide host seam. View modules used to import the app-level
// orchestration entrypoints straight from app.mjs — a back-import onto the
// orchestration layer that made every view inseparable from this studio's
// shell. Instead, app.mjs fills this object once at boot (initHost, before
// boot()), and views import { host } from here: a zero-import module, so a
// downstream studio can vendor a view and hand it its own four hooks
// (docs/VENDORING.md, docs/UI_CONVENTIONS.md).
//
// The contract (names promised stable):
//   loadPackB()        — fetch Pack B for the active comparison
//   openDeployModal()  — open the deploy modal ({ packId, presetIdentities })
//   renderMainView()   — repaint the active view
//   renderTabs()       — repaint the top nav
// and one optional hook:
//   setGradeCriteria(serviceId, { off, reason, setAside }) — keep a set of
//                        grade criteria for a service: `off` the keys it is not
//                        graded on from now on, `reason` for those newly left
//                        out, and — when given — `setAside`, the whole list of
//                        differences with live its grade leaves out
//                        (studio/set-asides.mjs; PATCH /api/services/:id
//                        { gradeOff, setAside }); resolve
//                        true once saved and repainted. Diagnose's switches are
//                        a what-if without it: it offers Keep only when it is
//                        set. (It replaces 0.8.23's setGradeCriterion, which
//                        saved one criterion at a time.)
//
// Like state.mjs, `host` is never reassigned — initHost merges into it, so
// the imported binding stays live across modules. The defaults no-op so a
// headless import (tests, tooling) never crashes.

export const host = {
  loadPackB: () => Promise.resolve(),
  openDeployModal: () => {},
  renderMainView: () => {},
  renderTabs: () => {},
  setGradeCriteria: null,
};

export function initHost(fns) { Object.assign(host, fns); }
