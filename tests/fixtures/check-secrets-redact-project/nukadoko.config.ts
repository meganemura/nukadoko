import { defineConfig } from "./nukadoko-shim.js";

// secrets.redact-specific config-coherence findings (secrets-redact-and-
// warning task spec, part A): `secrets-redact-key-unknown` for a name no
// configured envFile defines, `secrets-redact-key-too-short` for a value
// under MIN_REDACTABLE_LENGTH. Neither is an error: build-secret-set.ts
// already tolerates both (a redact entry that never matches anything, and
// a value too short to ever actually be redacted). `nuka check` still
// surfaces the too-short case (plaintext would reach a log the moment the
// run starts); the unknown-key case moved to `nuka tend`
// (m8d-move-to-tend task spec) — see tests/check-secrets.test.ts and
// tests/tend-moved-findings.test.ts, which both read this fixture.
export default defineConfig({
  envFiles: [".env.app"],
  secrets: { redact: ["SHORT_REDACT_KEY", "UNKNOWN_REDACT_KEY"] },
});
