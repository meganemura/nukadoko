class TheCopiedNoteSays < Nukadoko::Step
  description "The note the copy holds is the text the line states"
  pattern "the copied note says {text:string}"
  args do
    string :text, "The note the line expects"
    field :note, CopyTheSample.returns[:note]
  end
  from note: [CopyTheSample, :note]
  claims [{ actual: "note", compare: "equal", expected: "text" }]
end
