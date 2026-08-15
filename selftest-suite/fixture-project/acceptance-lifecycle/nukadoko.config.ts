import { defineConfig } from "nukadoko";

// Template for selftest-suite/features/steps/acceptance-lifecycle.ts's own
// Given steps -- never run in place. Each scenario copies this whole
// directory into a fresh, disposable directory nested under selftest-suite/
// itself (that file's own header explains why: `nuka accept` needs a real
// git repository with a clean tree, and this directory sitting inside the
// larger nukadoko repo's own working tree makes its git state that repo's,
// not a repo of its own), then places acceptance.feature either inside or
// outside `featuresDir` depending on which scenario is running. Default
// `featuresDir` ("features") on purpose: the three scenarios this template
// serves are exactly about that default boundary.
export default defineConfig({});
