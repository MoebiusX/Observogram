// studio/control-room-api.mjs — Overview's control room, the reads: one request, and the driver that repeats it.
//
// loadControlRoom(serviceId, env, { fresh, signal, fetchFn })
//   POST /api/services/:id/control-room { env, fresh? } — the server reads the
//   environment's live endpoint (server/routes/control-room.mjs). The browser
//   never talks to a metrics store.
//
// createControlRoomDriver({ load, onChange, timers, visibility, intervalMs })
//   Keeps one panel's reads going while it is open: one read at a time, the
//   next armed only after the last settles (a minute, longer after a
//   failure: control-room-model.mjs controlRoomDue), none while the page is
//   hidden, none after a refusal a later read would only repeat. Closing or
//   opening another service environment aborts the read in flight; an answer
//   that arrives for an old one is dropped. `visibility` is the host's
//   ({ hidden: () => bool, subscribe: (fn) => unsubscribe }), so this file
//   touches no DOM and runs under node:test with fake timers.
//
// Imports services-api.mjs (requestJson) and the panel's model.

import { requestJson } from './services-api.mjs';
import {
  CONTROL_ROOM_CLOSED, CONTROL_ROOM_INTERVAL_MS, controlRoomAnswered, controlRoomDue, controlRoomFailed, controlRoomOpened, controlRoomReading,
} from './control-room-model.mjs';

export function loadControlRoom(serviceId, env, { fresh = false, signal = null, fetchFn = requestJson } = {}) {
  return fetchFn(`/api/services/${encodeURIComponent(serviceId)}/control-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(env ? { env } : {}), ...(fresh ? { fresh: true } : {}) }),
    ...(signal ? { signal } : {}),
  });
}

export function createControlRoomDriver({
  load = loadControlRoom, onChange = () => {}, timers = globalThis,
  visibility = { hidden: () => false, subscribe: () => () => {} }, intervalMs = CONTROL_ROOM_INTERVAL_MS, now = () => Date.now(),
} = {}) {
  let state = CONTROL_ROOM_CLOSED;
  let timer = null;
  let controller = null;
  let generation = 0;
  let unsubscribe = null;
  const set = (next) => { state = next; onChange(state); };
  const clear = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };
  const arm = () => {
    clear();
    const wait = controlRoomDue(state, { now: now(), hidden: visibility.hidden(), intervalMs });
    if (wait === null) return;
    timer = timers.setTimeout(() => { timer = null; read(false); }, wait);
  };
  async function read(fresh) {
    if (!state.open || state.reading) return;
    clear();
    const gen = generation;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    set(controlRoomReading(state));
    try {
      const body = await load(state.serviceId, state.env, { fresh, signal: controller?.signal || null });
      if (gen !== generation) return;
      set(controlRoomAnswered(state, body, { now: now() }));
    } catch (e) {
      if (gen !== generation) return;
      set(controlRoomFailed(state, e, { now: now() }));
    } finally {
      if (gen === generation) { controller = null; arm(); }
    }
  }
  const stop = () => {
    generation += 1;
    clear();
    try { controller?.abort(); } catch { /* already settled */ }
    controller = null;
  };
  return {
    state: () => state,
    open(serviceId, env) {
      const next = controlRoomOpened(state, { serviceId, env, now: now() });
      if (next === state) return;
      stop();
      if (!unsubscribe) unsubscribe = visibility.subscribe(() => { if (!visibility.hidden()) arm(); else clear(); });
      set(next);
      read(false);
    },
    close() {
      stop();
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (state.open) set(CONTROL_ROOM_CLOSED);
    },
    refresh() { if (state.open && !state.reading) read(true); },
  };
}
