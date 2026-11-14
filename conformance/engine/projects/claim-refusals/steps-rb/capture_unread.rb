class CaptureUnread < Nukadoko::Step
  description "A refused claim"
  pattern "the price is {price:int}"
  args do
    integer :price, "The price"
    string :made, "The thing"
  end
  from made: [MakeThing, :thing]
  claims [{ actual: "made", compare: "equal", expected: { literal: "price" } }]
end
