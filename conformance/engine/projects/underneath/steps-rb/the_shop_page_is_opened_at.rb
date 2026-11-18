class TheShopPageIsOpenedAt < Nukadoko::Step
  description "Open a page of the shop and wait until its scripts are done"
  pattern "the shop page is opened at {path:string}"
  args { string :path, "The page's path" }
  mutates false

  def run(page:, args:)
    page.goto(args.path)
    page.wait_for_function("document.title === 'done'")
    nil
  end
end
