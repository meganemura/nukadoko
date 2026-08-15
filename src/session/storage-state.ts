import type { BrowserContext } from "playwright";

// Responsibility: the one shared name for Playwright's storageState shape
// (cookies + localStorage), used wherever it is collected from a browser or
// request context (src/context/*), restored into a new one, or persisted to
// / read back from cache/sessions/default/<name>.json (src/session/*). Derived
// from BrowserContext's own method return type rather than hand-copied:
// Playwright doesn't export this shape as a named type, and deriving it
// means a future Playwright upgrade that changes the shape is caught by the
// type checker instead of silently drifting. BrowserContext.storageState()
// and APIRequestContext.storageState() return the same shape (verified
// against playwright-core's own .d.ts), so either could anchor this alias.

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
