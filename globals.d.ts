// Ambient declarations bridging the IIFE-built globals to their JS source modules.
// Lets the TS language server resolve `RwgpsPhotospheres.foo` (etc.) at call sites
// back to the function definitions in lib/*.js — without changing runtime code.

declare global {
  const RwgpsPhotospheres: typeof import('./lib/photospheres.js').RwgpsPhotospheres;
  const RwgpsGeo: typeof import('./lib/geo.js').RwgpsGeo;
  const RwgpsUsage: typeof import('./lib/usage.js');
  const RwgpsApiBudget: typeof import('./content/api-budget.js');
}

export {};
