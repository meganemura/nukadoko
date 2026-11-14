class HeadingSays < Nukadoko::Step
  description "The page's heading"
  pattern "the heading says {text:string}"
  args do
    string :text, "The heading"
  end
  claims [{ actual: "heading", compare: "equal", expected: "text" }]

  def observe(page:, args:) = { heading: page.locator("h1").inner_text }
end
