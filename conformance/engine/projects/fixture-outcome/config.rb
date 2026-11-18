require "fileutils"
require "tmpdir"

Nukadoko.fixture(:tenant) do |use|
  tenant = Dir.mktmpdir("tenant")
  outcome = use.(tenant)          # "passed" | "failed"
  File.write("outcomes.txt", "#{outcome}\n", mode: "a")
  FileUtils.rm_rf(tenant) if outcome == "passed"
  raise "kept the tenant\nfor a look" if outcome == "failed"
end
