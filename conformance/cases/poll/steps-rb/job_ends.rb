class JobEnds < Nukadoko::Step
  pattern "the job ends {wanted:string}"
  description "The job an earlier step started reaches this status in GET /jobs/:id"
  args do
    string :wanted, "The status the job is expected to reach"
    field :id, StartJob.returns[:id]
  end
  from id: [StartJob, :id]
  poll timeout_ms: 3000, settled: [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }]
  claims [{ actual: "status", compare: "equal", expected: "wanted" }]

  def observe(request:, args:)
    { status: request.get("/jobs/#{args.id}").json["status"] }
  end
end
