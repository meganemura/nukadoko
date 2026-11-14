class AddOnPage < Nukadoko::Step
  pattern "{name:string} is added on the page"
  args { string :name }
  mutates true

  def run(page:, args:)
    page.get_by_label("Name").fill(args.name)
    page.get_by_role("button", name: "Add").click
    page.locator("#items li", hasText: args.name).wait_for
    {}
  end
end
