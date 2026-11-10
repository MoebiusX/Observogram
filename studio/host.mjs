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
//   setGradeCriterion(serviceId, key, { graded, reason }) — switch a grade
//                        criterion on or off for a service (PATCH
//                        /api/services/:id { gradeOff }), resolve true once
//                        saved and repainted. Diagnose offers its switches
//                        only when it is set; without it, it still says what
//                        is off.
//
// Like state.mjs, `host` is never reassigned — initHost merges into it, so
// the imported binding stays live across modules. The defaults no-op so a
// headless import (tests, tooling) never crashes.

export const host = {
  loadPackB: () => Promise.resolve(),
  openDeployModal: () => {},
  renderMainView: () => {},
  renderTabs: () => {},
  setGradeCriterion: null,
};

export function initHost(fns) { Object.assign(host, fns); }
