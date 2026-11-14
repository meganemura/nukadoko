// Same shared-cause failure as a-imports-shared.ts, from a second file: the
// pair is what proves `nuka check`'s human formatter groups two failures
// carrying the identical message instead of repeating it.
import "./shared-broken.js";
