class OpenList < Nukadoko::Step
  pattern "the shopping list is open"
  mutates false

  def run(page:, args:)
    page.goto("/")
    {}
  end
end
