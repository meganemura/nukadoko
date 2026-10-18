// Responsibility: quote one word so a command line nukadoko prints pastes
// into a POSIX shell as the same argument. Check, run, and the CLI all print
// such lines (a do line, a rerun line), so this sits in a leaf every layer
// may import, not in the runner that first needed it.

// Characters a POSIX shell reads as one plain word; anything else is single
// quoted, so a path with a space still pastes as one argument. A word may not
// start with "=": zsh, the default macOS shell, reads an unquoted =name as the
// path of the command name, and refuses the line when there is none.
const SHELL_SAFE = /^[A-Za-z0-9_./:@%+,-][A-Za-z0-9_./:=@%+,-]*$/;

export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
