class AJobIsQueued < Nukadoko::Step
  description "Queue a job through the API"
  pattern "a job is queued"
  returns { number :status, "The status the API answered" }
  mutates true

  def run(request:)
    { status: request.post("/jobs").status }
  end
end
