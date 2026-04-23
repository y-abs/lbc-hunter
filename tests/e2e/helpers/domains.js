// E2E domain configuration.
// Keep tests versioned in git and switch domains via env vars when needed.
// Example (local): E2E_WEB_ORIGIN=https://www.leboncoin.fr E2E_API_ORIGIN=https://api.leboncoin.fr npm run test:e2e

export const E2E_WEB_ORIGIN = process.env.E2E_WEB_ORIGIN || "https://www.leboncoin.fr";
export const E2E_API_ORIGIN = process.env.E2E_API_ORIGIN || "https://api.leboncoin.fr";
export const E2E_WEB_ORIGINS = [E2E_WEB_ORIGIN];
export const E2E_API_ORIGINS = [E2E_API_ORIGIN];

export const E2E_WEB_ROUTE_GLOBS = E2E_WEB_ORIGINS.map((origin) => `${origin}/**`);
export const E2E_API_ROUTE_GLOBS = E2E_API_ORIGINS.map((origin) => `${origin}/**`);

export const E2E_API_SEARCH_MATCH = "/finder/search";
