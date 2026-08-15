// Exists only to prove walkStepFiles skips any dot-directory, not just
// node_modules -- same "throw if
// ever imported" instrumentation as the node_modules fixture beside this
// one's parent directory.
throw new Error("features/.hidden/malicious.ts must never be imported");
