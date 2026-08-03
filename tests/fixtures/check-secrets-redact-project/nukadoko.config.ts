import { defineConfig } from "./nukadoko-shim.js";

// secrets.redact-specific config-coherence warnings (secrets-redact-and-
// warning task spec, part A): `secrets-redact-key-unknown` for a name no
// configured envFile defines, `secrets-redact-key-too-short` for a value
// under MIN_REDACTABLE_LENGTH. Neither is an error: build-secret-set.ts
// already tolerates both (a redact entry that never matches anything, and
// a value too short to ever actually be redacted), so `nuka check`'s job
// here is only to surface that leniency — the same shape as
// `secrets.public`'s own existing `secrets-public-key-unknown` warning.
export default defineConfig({
  envFiles: [".env.app"],
  secrets: { redact: ["SHORT_REDACT_KEY", "UNKNOWN_REDACT_KEY"] },
});
