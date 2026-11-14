class PageShowsNode < Nukadoko::Step
  pattern "the page shows the node {tree:string}"
  description "The page's accessibility tree against one node the line states"
  args { string :tree, "One line of the ARIA snapshot the page shows" }
  poll false
  claims [{ actual: "page", compare: "fits-aria-snapshot", expected: "tree" }]

  def observe(page:, args:) = { page: page }
end
