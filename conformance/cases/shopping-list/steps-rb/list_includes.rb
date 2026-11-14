class ListIncludes < Nukadoko::Step
  pattern "the list on the page includes {name:string}"
  args { string :name }
  poll false
  claims [{ actual: "items", compare: "has-item", expected: "name" }]

  def observe(page:, args:)
    { items: page.locator("#items li").all_text_contents }
  end
end
