class DueDayIs < Nukadoko::Step
  description "The due day is the day the line gives"
  pattern "期限は{day:dueDay}である"
  args do
    string :day, "The day the line gives"
  end
  claims [{ actual: "due", compare: "equal", expected: "day" }]

  def observe(args:) = { due: "明日" }
end
