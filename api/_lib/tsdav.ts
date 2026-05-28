// Thin wrapper that loads tsdav via createRequire.
//
// tsdav 2.2.2's package.json `import` condition points at dist/tsdav.esm.js,
// which uses ESM syntax but tsdav's package.json lacks "type": "module" and
// the file isn't .mjs — Node refuses to load it as ESM, falls back to CJS
// parse, throws SyntaxError on the `import` keyword. Our project is
// "type": "module" so Node picks the import condition by default.
// createRequire routes to the `require` condition (dist/tsdav.cjs.js,
// clean CommonJS) instead.
//
// Re-exporting as a regular ES module also makes vitest's vi.mock work
// against this file — mocking 'tsdav' directly doesn't catch a
// runtime-constructed require.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsdav = require('tsdav') as typeof import('tsdav');

export const createCalendarObject = tsdav.createCalendarObject;
export const createDAVClient = tsdav.createDAVClient;
export const fetchCalendarObjects = tsdav.fetchCalendarObjects;
export const getBasicAuthHeaders = tsdav.getBasicAuthHeaders;
export type { DAVCalendar } from 'tsdav';
