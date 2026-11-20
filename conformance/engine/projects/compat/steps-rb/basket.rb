Before do
  @tagged = false
end

Before("@tagged") do
  @tagged = true
end

After do
  @closed = true
end

Given("an empty basket") do
  @basket = []
end

When("I add {int} apples") do |count|
  count.times { @basket << "apple" }
end

When("I add these fruits:") do |table|
  table.hashes.each { |row| row["count"].to_i.times { @basket << row["name"] } }
end

Then(/^the basket holds (\d+) fruits$/) do |count|
  raise "expected #{count} fruits, the basket holds #{@basket.size}" unless @basket.size == count.to_i
end

Then("the hook saw the tag") do
  raise "the hook did not see the tag" unless @tagged
end

When("I weigh the basket") do
  pending
end
