class JobEnds < Nukadoko::Step
  pattern "the job ends {status:string}"
  description "The job an earlier step started reaches this status in GET /jobs/:id"
  args do
    string :status, "The status the job is expected to reach"
    field :id, StartJob.returns[:id]
  end
  from id: [StartJob, :id]
  poll timeout_ms: 3000, settled: [{ actual: "status", compare: "not-equal", expected: { literal: "running" } }]
  claims [{ actual: "status", compare: "equal", expected: "status" }]

  def observe(request:, args:)
    { status: request.get("/jobs/#{args.id}").json["status"] }
  end
end
