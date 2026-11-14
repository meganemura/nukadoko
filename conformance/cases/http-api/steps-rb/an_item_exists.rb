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

  def run(baseURL:, args:)
    res = Net::HTTP.post(URI("#{baseURL}/items"), JSON.generate(name: args.name))
    raise %(creating "#{args.name}": status #{res.code.to_i}, not 201) unless res.code.to_i == 201

    item = JSON.parse(res.body)
    { id: item["id"], body: item }
  end
end
