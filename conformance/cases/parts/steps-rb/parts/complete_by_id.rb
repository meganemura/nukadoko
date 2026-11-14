class CompleteById < Nukadoko::Step
  description "PATCH one todo to done: true by its id"
  args { string :id, "The id of the todo to complete" }
  returns do
    string :id, "The id of the todo"
    string :title, "Its title"
    boolean :done, "true after the PATCH"
  end
  mutates true

  def run(request:, args:) = request.patch("/todos/#{args.id}", data: { done: true }).json
end
