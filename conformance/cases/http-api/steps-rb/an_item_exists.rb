class AnItemExists < Nukadoko::Step
  description "Create an item through the API so a later step can read it"
  pattern "an item named {name:string} exists"
  args { string :name, "The item's name" }
  returns do
    number :id, "The id the API assigned"
    object :body, "The item as the API answered it" do
      number :id
      string :name
    end
  end

  def run(request:, args:)
    res = request.post("/items", body: JSON.generate(name: args.name))
    raise %(creating "#{args.name}": status #{res.status}, not 201) unless res.status == 201

    item = res.json
    { id: item["id"], body: item }
  end
end
