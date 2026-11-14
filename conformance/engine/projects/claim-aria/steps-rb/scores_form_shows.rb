class ScoresFormShows < Nukadoko::Step
  pattern "the scores form shows"
  description "The scores form's accessibility tree against the tree the docstring states"
  args { string :tree, "Part of the ARIA snapshot the form shows" }
  poll timeout_ms: 2000
  claims [{ actual: "form", compare: "fits-aria-snapshot", expected: "tree" }]

  def observe(page:, args:) = { form: page.get_by_role("form", name: "Scores") }
end
