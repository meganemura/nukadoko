# frozen_string_literal: true

# Runs every conformance case under the Ruby engine and compares the result
# with the expected.json the TypeScript engine wrote. It keeps the same part
# of the result run-ts.mjs keeps, and compares it as JSON values.
require "json"
require "tmpdir"
require "fileutils"
require "open3"

HERE = __dir__
ROOT = File.dirname(HERE)
NUKA = File.join(ROOT, "ruby", "exe", "nuka")
GEMFILE = File.join(ROOT, "ruby", "Gemfile")

def nuka(dir, *args)
  env = { "BUNDLE_GEMFILE" => GEMFILE, "PLAYWRIGHT_CLI" => File.join(ROOT, "node_modules", ".bin", "playwright") }
  out, _status = Open3.capture2(env, "bundle", "exec", "ruby", NUKA, *args, "--json", chdir: dir, err: File::NULL)
  JSON.parse(out, symbolize_names: true)
end

def project(case_dir, dir)
  FileUtils.cp_r(File.join(case_dir, "features"), dir)
  FileUtils.cp_r(File.join(case_dir, "steps-rb"), File.join(dir, "features", "steps"))
  files = File.join(case_dir, "files")
  FileUtils.cp_r("#{files}/.", dir) if File.directory?(files)
  config = ENV["NUKADOKO_CHROMIUM"] ? "Nukadoko.config(browser: { executablePath: #{ENV["NUKADOKO_CHROMIUM"].inspect} })\n" : ""
  # A case that declares fixtures brings its own config, after the browser line.
  own = File.join(case_dir, "config.rb")
  config += File.read(own) if File.exist?(own)
  File.write(File.join(dir, "nukadoko.config.rb"), config) unless config.empty?
  program_file = File.join(case_dir, "program.json")
  return unless File.exist?(program_file)

  program = JSON.parse(File.read(program_file).gsub("{root}", ROOT), symbolize_names: true)
  File.write(File.join(dir, "nukadoko.program.rb"), "Nukadoko.program(**#{program.inspect})\n")
end

def finding(f)
  in_steps = f[:file]&.start_with?("features/steps/")
  step = f[:step] || (File.basename(f[:file], ".*").tr("_", "-") if in_steps)
  file = f[:file] unless in_steps
  { severity: f[:severity], code: f[:code], **(file ? { file: file, line: f[:line] } : {}), **(step ? { step: step } : {}) }
end

def sort_findings(list) = list.sort_by { [_1[:file].to_s, _1[:line].to_i, _1[:code], _1[:step].to_s] }

def outcome(case_dir)
  Dir.mktmpdir("nukadoko-conformance-") do |dir|
    project(case_dir, dir)
    check = nuka(dir, "check")
    result = { check: sort_findings(check[:findings].map { finding(_1) }) }
    if check[:verdict] == "passed"
      run = nuka(dir, "run", "--no-check")
      result[:scenarios] = run[:scenarios].map do |s|
        { feature: s[:feature], line: s[:line], environment: s[:environment], status: s[:status],
          role: s[:role],
          steps: s[:steps].map { { line: _1[:line], step: _1[:step], status: _1[:status] } } }
      end
      result[:verdict] = run[:verdict]
      result[:table] = run[:table][:rows].map do |row|
        { feature: row[:feature], line: row[:line], verdict: row[:verdict],
          cells: row[:cells].map { |c| { environment: c[:environment], role: c[:role], outcome: c[:outcome], **(c[:line] ? { line: c[:line] } : {}), runs: c[:runs] } } }
      end
    end
    result
  end
end

only = ARGV.reject { _1.start_with?("--") }
failed = 0
Dir.children(File.join(HERE, "cases")).sort.each do |name|
  next if only.any? && !only.include?(name)

  actual = outcome(File.join(HERE, "cases", name))
  if JSON.parse(File.read(File.join(HERE, "cases", name, "expected.json")), symbolize_names: true) == actual
    puts "ok      #{name}"
  else
    failed += 1
    puts "differs #{name}\n#{JSON.pretty_generate(actual)}"
  end
end
exit(failed.zero? ? 0 : 1)
