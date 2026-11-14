import { defineConfig } from "nukadoko";

// NUKADOKO_CHROMIUM names a Chromium when Playwright's own is not installed.
const executablePath = process.env.NUKADOKO_CHROMIUM;

export default defineConfig(executablePath === undefined ? {} : { browser: { executablePath } });
