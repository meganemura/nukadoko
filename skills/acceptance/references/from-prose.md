# From prose to requirements

Nothing in this stage runs a `nuka` command; a ticket, a request, or a
conversation isn't vocabulary yet, so there is nothing here for the CLI to
check. What this stage produces is text: a set of requirement statements,
each either complete or carrying a named question for the person who can
answer it.

Read the prose against the five EARS patterns as a checklist for what a
requirement needs to say to be actionable, not as a template to generate
polished-sounding wording from. A pattern's slots come from the prose
itself; a slot the prose doesn't state is a question, never a guess:

- **Ubiquitous**: "The `<system>` shall `<response>`." Always true, no
  trigger and no condition.
- **Event-driven**: "When `<trigger>`, the `<system>` shall `<response>`."
- **State-driven**: "While `<state>`, the `<system>` shall `<response>`."
- **Unwanted behaviour**: "If `<trigger or condition>`, then the
  `<system>` shall `<response>`."
- **Optional feature**: "Where `<feature is present>`, the `<system>`
  shall `<response>`."

For each requirement-shaped statement in the prose:

1. Decide which pattern fits, or notice the sentence is actually several
   requirements compounded into one and split it first: a sentence with
   "and" joining two different responses, or an implicit "unless," is
   usually more than one requirement wearing one sentence.
2. Fill each slot only with words the prose actually supports.
3. Anything a slot needs that the prose doesn't state stays open: write it
   as a question addressed to whoever can answer it, and leave the slot
   unfilled rather than choosing a plausible value to move forward.
4. Keep each requirement's own open questions attached to that
   requirement, never pooled into one list, so a reader can see which
   sentence is still unanswered rather than which set is.

For example, a ticket that says "the export should fail gracefully if the
file is too large" reads as an unwanted-behaviour candidate: "If `<file too
large>`, then the system shall `<fail gracefully>`." Both slots are
actually open. "Too large" names no threshold: what size, or what resource
limit, triggers it? "Fail gracefully" names no response: does the user see
a message, is the upload retried, is partial output cleaned up? Neither
gets a value invented to fill the pattern; both become questions back to
whoever wrote the ticket.

Once a requirement's slots are all filled from stated fact, and every open
slot has been resolved into an answered question, it is ready for
`references/writing-the-feature.md` ("From requirements to scenarios"). A
model drafting this classification is fine; the discipline lives in
refusing to fill a slot the source didn't support, not in refusing to
draft at all.
