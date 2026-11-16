# NUKADOKO_CHROMIUM names a Chromium when Playwright's own is not installed.
Nukadoko.config(browser: { executablePath: ENV["NUKADOKO_CHROMIUM"] }) if ENV["NUKADOKO_CHROMIUM"]
