This fixture project exists for `nuka experimental webmcp-tools` and for
`nuka steps`, not for a scenario that actually runs: there is no `.feature`
file here. `steps/` does hold one real step (own-step.ts), so
`nuka steps --json` has actual vocabulary to check, rather than an empty
list that would pass the "does not contain the WebMCP tool name" assertion
for free.
