# The step file and its pattern

## The shape of a step file

How a step file is written in your engine is in `typescript/step-files.md`
or `ruby/step-files.md`, with the same headings in both; read the one for
the config file the project has. What follows holds in both.

One step per file. The file name is the step's name: the `nuka do <name>`
you call it by, and the name every finding and step record uses for it.
Feature files and step files both live under the configured `featuresDir`,
`features` unless the project says otherwise, with feature files ending
in `.feature`. A file a scenario runs as a process (a fake server, a
fixture script) belongs outside `featuresDir`: discovery loads every file
under it on every `nuka check`, top-level code included.

`returns` can be left out, and the step then returns nothing, which fits
a Given that only sets something up. A Then has no `run` at all: it
declares `claims`, and an `observe` when no earlier step returned the
value (`checking-steps.md`). A Given or When that observes something (a
page, a response, a file) returns what it observed, and declares
`returns` for it: without one, a returned key fails the step as
`result_invalid`, naming the key.

nukadoko reads which fixtures a step needs from the parameters of `run`
and `observe`, without calling them ("The fixtures a step names" on your
engine's page). `page`, `context`, and `page_as` are Playwright's own
objects, so reach for Playwright's documentation for what to call on them
rather than guessing.

## Return more than what a later step cites

Basing `returns` on citation alone drops the values this step's own
correctness depended on but nothing downstream reads (a computed date, a
chosen id, a resolved name), and those are exactly what a step record gets
read for once something has failed. Return them even if the scenario never
reads them back; the alternative is reconstructing what was actually sent
from another system's error message. This is also what a downstream
failure's own step record can show you: a failed step's `used` entries
carry each upstream step's full `result`, so whatever this step declined to
return is exactly what stays missing from that step record too.

## Several people in one scenario

When the app tells people apart by a cookie, give each person a browser
context of their own (`pageAs`, "Several people in one scenario" on your
engine's page). Later calls for a name return the same page; other
options there throw. A name is 1 to 64 lowercase letters, digits, and
hyphens, starting with a letter or digit, or it throws: take it from the
feature line, lowercased. Records tag it with `as`.

## `page.goto` and baseURL

A leading slash in `page.goto("/path")` replaces baseURL's own path, the
standard URL resolution rule, not something nukadoko adds. Measured
against Playwright 1.61.1 with `baseURL:
"https://demo.playwright.dev/todomvc/"`: `goto("/")` lands on
`https://demo.playwright.dev/`, the host's own root, not the app under
`/todomvc/`. `goto("./")` and the absolute `goto("/todomvc/")` both land
on `https://demo.playwright.dev/todomvc/#/` instead. A step whose app
lives under a path writes one of those two forms for its first
navigation, never a bare leading slash.

## Writing the pattern

Every parameter is `{key:type}`, and the key names the `args` field it
fills: `"a customer {email:string} is onboarded"` fills `args.email`. An
unnamed `{string}` is refused outright, so there is no shorter form to
reach for.

`{key:string}` only matches text wrapped in double quotes; an unquoted
value does not match at all, and `nuka check` reports the whole line as
`undefined-step`. When exactly one pattern fits the line once quoted, the
finding also names the step, the `{...:string}` parameter, and the line
rewritten with quotes. `"a customer {email:string} is onboarded"` binds `a customer "ada@example.com" is
onboarded`, quotes included in the line but stripped from the captured
value; `a customer ada@example.com is onboarded` binds nothing. `{word}`
differs on both counts: it matches one unquoted, space-free token with no
quotes needed, and if a value is quoted anyway, the quotes stay part of
the captured text instead of being stripped.

A pattern is a Cucumber Expression, so three characters are syntax: `/`
separates alternative words, `(` and `)` mark optional text, and `{`
opens a capture. A literal one is escaped with a backslash, `I POST this
body to \/items`, which a JSON string in the step file writes as
`"I POST this body to \\/items"`. Unescaped, `nuka scaffold` refuses the
pattern and `nuka check` reports `pattern-syntax-error`, both naming the
column (`typescript/examples/http-api.md`).

Do not carry a list of type names around. Get one wrong and `nuka check`
prints the parameter types **this** project has registered, custom ones
from the config included, which is the only list that is true
here rather than true of nukadoko in general.

Add to that list instead of working around it when a pattern keeps
needing the same shape spelled out by hand: `parameterTypes` in the
config ("Parameter types" on your engine's page). The `args` schema is
still what validates the value. The one thing a project cannot do is
redefine a built-in name (`int`, `string`, and the rest): that would
quietly change what every pattern already using it means.

The pattern and the schema are checked against each other, both ways: a
key the pattern captures that `args` has no field for is an error, and so
is a required `args` field that nothing captures and no `from` fills.
Neither side can drift away from the other quietly, so adding an `args`
field and forgetting the capture costs you one `nuka check`, never a
browser session.

`capture-type-mismatch` is the type half of that comparison: the type
of a built-in capture against the field's primitive type. `{int}`,
`{float}`, `{double}`, `{byte}`, `{short}`, and `{long}` give a number;
`{word}`, `{string}`, the anonymous `{key:}`, and `{bigdecimal}` give a
string; `{biginteger}` gives a bigint. A number capture against a string
or boolean field is the finding, and so is any other pair that differs. A
field that accepts more than one type, and a custom parameter type, are
never reported.

Capturing the same key twice in one pattern is refused too. One args
field holds one value, and keeping the last capture would drop the
earlier one. `nuka check` reports it and `nuka run` refuses the binding
before the step body runs, and both name the key.
