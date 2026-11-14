class StartJob < Nukadoko::Step
  pattern "a job named {name:string} is started and ends {ends:string}"
  description "Start a job via POST /jobs that ends in the given status"
  args do
    string :name, "The job's name"
    string :ends, 'The status the job ends in: "done" or "failed"'
  end
  returns { string :id, "The id the server assigned" }
  mutates true

  def run(request:, args:)
    { id: request.post("/jobs", data: { name: args.name, ends: args.ends }).json["id"] }
  end
end
