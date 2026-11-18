class AkiOpens < Nukadoko::Step
  description "Aki opens a page of the shop in a browser context of aki's own"
  pattern "aki opens the shop page at {path:string}"
  args { string :path, "The page's path" }
  mutates false

  def run(page_as:, args:)
    page = page_as.("aki")
    page.goto(args.path)
    page.wait_for_function("document.title === 'done'")
    nil
  end
end
