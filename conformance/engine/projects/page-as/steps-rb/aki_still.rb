class AkiStill < Nukadoko::Step
  description "Aki's page still shows aki"
  pattern "aki's page is still aki's"
  # Keeps nothing.
  mutates false

  def run(pageAs:)
    raise "lost" unless pageAs.("aki").text_content("p") == "aki"
    nil
  end
end
