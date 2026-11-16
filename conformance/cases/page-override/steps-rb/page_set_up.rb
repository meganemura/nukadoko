class PageSetUp < Nukadoko::Step
  pattern "the page was set up by the project"
  poll false
  claims [{ actual: "wrapped", compare: "equal", expected: { literal: "by the project" } }]

  def observe(page:)
    { wrapped: page.evaluate("() => window.wrapped ?? 'not wrapped'") }
  end
end
