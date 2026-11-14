class PageShows < Nukadoko::Step
  pattern "the page shows"
  description "The page's accessibility tree against the tree the docstring states"
  args { string :tree, "Part of the ARIA snapshot the page shows" }
  poll false
  claims [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }]

  def observe(page:, args:) = { page: page }
end
