class PageHolds < Nukadoko::Step
  pattern "the page holds"
  args { string :html, "The page's HTML" }
  returns {}
  mutates false

  def run(page:, args:)
    page.set_content(args.html)
    {}
  end
end
