# Answers a reviewer's five merge-risk questions from one run.json of
# `nuka run --base`, with what the run measured and nothing it guessed.
# references/merge-risk.md says how to read each answer and what stays
# unanswered.
#
#   jq -r --argjson sensitive '["payments", "/admin/:id"]' \
#     -f merge-risk.jq .nukadoko/runs/<run_id>/run.json
#
# `sensitive` is optional: the tables and routes this project treats as
# sensitive. nukadoko never guesses them from a name.

def sensitive: $ARGS.named.sensitive // [];
def base_paths: [.paths[]? | select(.between.kind == "base")];
# Every difference between the base and head, whatever explains it: a new
# criterion explains its own difference, which says nothing about its risk.
def changed: [base_paths[] | .criteria[] | . as $c | .steps[] | .changed[]
  | . + {criterion: "\($c.feature):\($c.line)", explained_by: $c.explained_by}];
def new_at_head: select((.b.at_least // 0) > 0);
def plain: del(.a, .b, .criterion, .explained_by, .intent);
def listed(prefix; none): if length > 0 then prefix + join(", ") else none end;

if (base_paths | length) == 0 then
  "This run has no paths against a base. Run `nuka run --base <ref>` and read its run.json."
else
  "## Verification",
  (.table.rows[] | "- \(.feature):\(.line) \(.name): \(.verdict)"),
  (.limits[]? | select(.kind == "no-claim") | "- \(.feature):\(.line) judges no claim on a Then, so its verdict proves no outcome"),
  "",
  "## Alignment",
  (.intent.rows[]? | "- INTENT.md row \(.row) (\(.target) | \(.observation) | \(.before) -> \(.after)): \(.result)"),
  (changed | map(select(.explained_by == null and .kind != "request"))
    | group_by(.criterion)[]
    | "- declared nowhere, at \(.[0].criterion): " + (map(plain | tostring) | unique | join(", "))),
  "",
  "## Impact",
  (changed | map(select(.kind == "db") | new_at_head | "\(.table) \(.op)") | unique
    | listed("- tables touched differently at head: "; "- no table touched differently at head")),
  (changed | map(select(.kind == "request") | new_at_head | "\(.method) \(.route)") | unique
    | listed("- routes answered differently at head: "; "- no route answered differently at head")),
  (changed | map(select((.table // .route) as $name | $name != null and (sensitive | index($name)) != null)
      | "\(.table // "\(.method) \(.route)") \(.op // .status) at \(.criterion)") | unique
    | listed("- sensitive: "; if (sensitive | length) == 0 then "- sensitive: no list given" else "- sensitive: none of the listed tables or routes" end)),
  "",
  "## Rollback cost",
  (changed | map(select(.kind == "db" and (.op == "delete" or .op == "update")) | new_at_head
      | "\(.table) \(.op) at \(.criterion)") | unique
    | listed("- deletes and updates new at head: "; "- no delete or update new at head")),
  "- not measured: schema changes, backfills, and effects outside the program's execution events",
  "",
  "## Error detection",
  (.findings[]? | select(.code == "unexpected-failure") | "- unexpected failure at \(.file):\(.line)"),
  (changed | map(select(.kind == "error" and .handled == false) | new_at_head | "\(.class) at \(.criterion)") | unique
    | listed("- unhandled errors new at head: "; empty)),
  (changed | map(select(.kind == "error" and .handled == true) | new_at_head | "\(.class) at \(.criterion)") | unique
    | listed("- errors caught and passed over, new at head (whether each reached monitoring is not measured): "; empty))
end
