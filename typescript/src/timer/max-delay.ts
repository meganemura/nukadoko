// Responsibility: the longest delay a Node.js timer keeps, for every limit
// nukadoko arms from a value a project writes: a step's or a fixture's
// timeout, a poll's budget, a `runCommand` timeout, a compat step's or
// hook's `{ timeout }`, and each `timeout_ms` of nukadoko.program.ts. A
// leaf, since compat, config, the step contract, the context, and the
// program all refuse a larger value, and compat sits below the rest.
//
// `setTimeout` stores its delay as a signed 32-bit integer. A larger delay
// prints a TimeoutOverflowWarning and fires after 1 ms, so a limit of
// 2^31 ms or more failed its phase or its step at once, with a message
// that named the limit it never waited for. Each place refuses such a value
// where the project writes it, by this number.

/** 2^31 - 1 milliseconds, about 24.8 days. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The end of a refusal: why a larger value cannot be a limit. */
export const MAX_TIMER_DELAY_REASON = `at most ${MAX_TIMER_DELAY_MS} ms, the longest delay a Node.js timer keeps (a longer one fires after 1 ms)`;
