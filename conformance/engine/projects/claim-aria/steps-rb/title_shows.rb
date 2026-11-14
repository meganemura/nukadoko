class TitleShows < Nukadoko::Step
  pattern "the title shows"
  description "The page's title against a tree, which it is not"
  args { string :tree, "Part of the ARIA snapshot the page shows" }
  poll false
  claims [{ actual: "title", compare: "fits-aria-snapshot", expected: "tree" }]

  def observe(page:, args:) = { title: page.title }
end
