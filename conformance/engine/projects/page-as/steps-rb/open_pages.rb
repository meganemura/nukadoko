class OpenPages < Nukadoko::Step
  description "Open a page for aki and one for ben"
  pattern "aki and ben each open a page"
  # Keeps nothing.
  mutates false

  def run(page_as:, context:)
    aki = page_as.("aki")
    ben = page_as.("ben", { javaScriptEnabled: false })
    raise "same context" if aki.context == ben.context || aki.context == context
    raise "not the same page" unless page_as.("aki").equal?(aki)
    begin
      page_as.("ben", { javaScriptEnabled: true })
      raise "no conflict"
    rescue Nukadoko::ContextOptionsConflictError
      nil
    end
    begin
      page_as.("Aki")
      raise "no name error"
    rescue Nukadoko::InvalidContextNameError
      nil
    end
    aki.set_content("<p>aki</p>")
    nil
  end
end
