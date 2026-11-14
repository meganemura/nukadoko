class SearchReads < Nukadoko::Step
  description "The world's SEARCH variable reads the given text"
  pattern "the search reads {value:string}"
  args { string :value, "The text SEARCH holds" }
  claims [{ actual: "search", compare: "equal", expected: "value" }]

  def observe(args:, env:) = { search: env.fetch("SEARCH", "") }
end
