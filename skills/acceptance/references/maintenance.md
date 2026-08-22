# Keeping records honest over time

`nuka tend` finds a record whose claims stopped holding: a stale record is
the only finding that exits non-zero, so a periodic job can act on it; read
what it prints for which of the record's own claims stopped holding and how
to fix it. Every other finding it reports, `signoff-condition-mismatch` and
`post-navigation-read` among them, is a note a project is allowed to carry
rather than something blocking.

`post-navigation-read` is the one worth knowing the shape of, because
there is a way to make it stop being true and only one. It lists a call a
step made shortly after its own navigation, and it never says the gap was
too short, since how long an application takes to render after a
navigation is not something this tool can know. A read that a `ctx.poll`
call was already retrying is not listed at all. Reaching for a direct
browser wait instead does not help: that wait is itself a call right after
the navigation, so the note comes back naming it, which reads as though
nothing silences it.

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

The findings above all start from a record that already exists and ask
whether its claim still holds. One more starts from the opposite end:
`feature-never-signed` names a feature under `featuresDir` or
`additionalFeatureDirs` that no acceptance record's own `feature:`
frontmatter has ever named. `nuka accept` has no way to force a red run
through; it refuses and names the next command to run, which means the
usual way sign-off actually fails is that nobody runs it at all, and that
shows up in a PR as a file that is not there. Nothing else here looks for
a file that is not there. It is a note, not an error, the same reason a
feature still being drafted is a normal thing to see: `nuka accept` is a
later, explicit step, so a feature with no sign-off yet may simply not
have reached it. Being inside `featuresDir` does not silence this one,
unlike the two staleness findings above: whether a record was ever made
is a different question from whether a frozen one is still accurate, and
the running suite answers only the second.
