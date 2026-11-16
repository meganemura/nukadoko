class WaitAndKeep < Nukadoko::Step
  description "Wait for the earlier total, then keep it as evidence"
  pattern "the total is waited for and kept"
  returns { integer :total, "The total kept" }
  # Writes only into its own evidence directory.
  mutates false

  def run(section:, poll:, evidence:, result_of:)
    section.("waiting")
    attempts = 0
    total = poll.(description: "the total", interval: 10) do
      attempts += 1
      result_of.(MakeATotal)&.total if attempts >= 2
    end
    evidence.attach("total.txt", total.to_s)
    File.write(evidence.path("note.txt"), "kept")
    section.("kept")
    { total: total }
  end
end
