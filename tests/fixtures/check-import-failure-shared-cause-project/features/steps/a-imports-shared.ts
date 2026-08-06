// Side-effect import only, on purpose: shared-broken.js throws during its
// own evaluation, so this file's own import call fails before anything
// else here would run.
import "./shared-broken.js";
