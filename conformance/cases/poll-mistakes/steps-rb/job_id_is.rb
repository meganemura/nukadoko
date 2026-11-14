class JobIdIs < Nukadoko::Step
  pattern "the job id is {wanted:string}"
  description "Polls a value an earlier step returned, which never changes"
  args do
    string :wanted, "The id expected"
    field :id, StartJob.returns[:id]
  end
  from id: [StartJob, :id]
  poll timeout_ms: 1000
  claims [{ actual: "id", compare: "equal", expected: "wanted" }]
end
