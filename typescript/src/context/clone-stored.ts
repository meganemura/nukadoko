// Responsibility: copy a validated result before a caller can hold it.
//
// `ctx.resultOf` returns the chain entry's result, and `ctx.call` returns
// the object it just stored on the call record. That object is what a later
// read and the step record keep. Sorting an array or writing a field on it
// would change both. docs/spec.md "Context API" says nothing can write to
// a `resultOf` value.
//
// A structured clone shares none of those nested objects, and it keeps
// dates and cycles. `undefined` is a legal result and the structured clone
// algorithm rejects it as a root, so it is returned as it is: there is
// nothing to alias. Any other value the algorithm rejects fails here,
// because returning the stored object is how a caller writes the record.

export function cloneForCaller<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}
