class CompleteTodo < Nukadoko::Step
  pattern "the todo titled {title:string} is completed"
  description "Find a todo by title and PATCH it to done: true"
  args { string :title, "The title of the todo to complete; must already exist" }
  returns do
    string :id, "The id of the todo that was completed"
    string :title, "Its title, as the server returned it"
    boolean :done, "true after the PATCH"
  end
  mutates true

  def run(request:, args:)
    match = request.get("/todos").json.find { _1["title"] == args.title }
    raise %(no todo titled "#{args.title}" to complete) unless match

    request.patch("/todos/#{match["id"]}", data: { done: true }).json
  end
end
