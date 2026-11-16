class AddATask < Nukadoko::Step
  description "Add a task of a priority"
  pattern "優先度{priority:priority}のタスクを足す"
  args do
    enum :priority, %w[high low], "The priority the line gives"
  end
  returns do
    enum :priority, %w[high low], "The priority of the task"
  end
  # Keeps nothing.
  mutates false

  def run(args:) = { priority: args.priority }
end
