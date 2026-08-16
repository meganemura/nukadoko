# Keeping records honest over time

`nuka tend` finds a record whose claims stopped holding: a stale record is
the only finding that exits non-zero, so a periodic job can act on it; read
what it prints for which of the record's own claims stopped holding and how
to fix it. Every other finding it reports, `signoff-condition-mismatch` and
`post-navigation-read` among them, is a note a project is allowed to carry
rather than something blocking.

Once a feature has moved into `featuresDir` (see "What not to do" in
`SKILL.md`), `nuka tend` stops reporting a stale sign-off or a drifted
condition for it: the running suite carries the guarantee now, not a
record frozen at one commit, and reporting either finding anyway would
turn every ordinary edit to a feature already running unattended into an
alarm nobody keeps reading. The one exception is a record `tend` cannot
even parse (`signoff-record-unreadable`): its own claimed feature path may
not have parsed either, so there is no placement to judge it by, and a
file that looks like a record but cannot be read stays worth reporting
regardless of where the feature lives.
