# frozen_string_literal: true

require "nukadoko"
require "fileutils"
require "open3"
require "rbconfig"
require "tmpdir"

# The walkthroughs in README.md ("Beside your unit tests") and docs/guide.md
# ("An HTTP API", "Calling the program with fetch") show each step as a
# `ruby` block followed by its `ts` twin. The TypeScript engine's tests run
# the `ts` blocks; this test runs the `ruby` ones the same way: the scaffold
# commands as written, each step block compared with what the scaffold
# wrote, and the feature run to green.
class DocsWalkthroughTest < Minitest::Test
  ROOT = File.expand_path("../..", __dir__)
  NUKA = File.expand_path("../exe/nuka", __dir__)

  Block = Data.define(:lang, :body) do
    # The path a file block names on its first line, as a comment.
    #: () -> String?
    def path = body.lines.first.to_s[%r{\A(?://|#) (\S+)\n\z}, 1]

    # The block as the file holds it, without that first line.
    #: () -> String
    def file = body.lines.drop(1).join
  end

  def setup
    skip "the documents are in the repository, not in the gem" unless File.exist?(File.join(ROOT, "README.md"))
  end

  # The fenced blocks of one `## ` section, a `## ` line inside a fence aside.
  def blocks(document, heading)
    lines = File.read(File.join(ROOT, document)).lines
    start = lines.index("## #{heading}\n") or flunk %(#{document} has no "## #{heading}")
    found = []
    fence = nil
    lines[(start + 1)..].each do |line|
      if fence && line == "```\n"
        found << Block.new(fence[:lang], fence[:body].join)
        fence = nil
      elsif fence
        fence[:body] << line
      elsif line.start_with?("```")
        fence = { lang: line[3..].strip, body: [] }
      elsif line.start_with?("## ")
        break
      end
    end
    found
  end

  def nuka(dir, *args)
    out, status = Open3.capture2e(RbConfig.ruby, NUKA, *args, chdir: dir)
    assert status.success?, "nuka #{args.join(" ")} failed:\n#{out}"
    out
  end

  # A `sh` line, split the way a shell splits it: a double-quoted run is one word.
  def words(line) = line.scan(/"([^"]*)"|(\S+)/).map { |quoted, bare| quoted || bare }

  def write(dir, block)
    target = File.join(dir, block.path)
    FileUtils.mkdir_p(File.dirname(target))
    File.write(target, block.body)
  end

  def test_the_readme_walkthrough_runs_green
    shown = blocks("README.md", "Beside your unit tests")
    Dir.mktmpdir do |dir|
      FileUtils.mkdir_p(File.join(dir, "src"))
      File.write(File.join(dir, "src", "cli.rb"), %(puts "Hello, \#{ARGV[0]}!"\n))
      unedited = []
      ran = []
      shown.each do |block|
        case block.lang
        when "ruby"
          unedited << block.path if File.read(File.join(dir, block.path)) == "# frozen_string_literal: true\n\n#{block.file}"
          write(dir, block)
        when "gherkin" then write(dir, block)
        when "sh"
          block.body.lines.map(&:strip).reject(&:empty?).each do |line|
            argv = words(line)
            assert_equal "nuka", argv.first
            ran << line
            nuka(dir, *argv.drop(1))
          end
        end
      end
      assert_equal "nuka run", ran.last
      assert_equal ["features/steps/run_greet.rb", "features/steps/output_says.rb"], unedited
    end
  end

  SERVER = <<~RUBY
    require "json"
    require "socket"
    require "uri"
    server = TCPServer.new("127.0.0.1", Integer(ENV.fetch("PORT")))
    loop do
      client = server.accept
      path = client.gets.to_s.split[1].to_s
      nil until ["\\r\\n", nil].include?(client.gets)
      name = URI.decode_www_form_component(path.delete_prefix("/greet/"))
      body = ENV["JSON"] ? JSON.generate(message: "Hello, \#{name}!") : "Hello, \#{name}!"
      client.write "HTTP/1.1 200 OK\\r\\ncontent-length: \#{body.bytesize}\\r\\nconnection: close\\r\\n\\r\\n\#{body}"
      client.close
    end
  RUBY

  def http_project(dir, json:)
    shown = blocks("docs/guide.md", "An HTTP API")
    program = shown.find { _1.lang == "ruby" }
    feature = shown.find { _1.lang == "gherkin" }
    assert_equal ["ruby", "nukadoko.config.rb"], [program.lang, program.path]
    nuka(dir, "init")
    write(dir, json ? program.with(body: program.body.sub("env: { PORT:", %(env: { JSON: "1", PORT:))) : program)
    write(dir, feature)
    FileUtils.mkdir_p(File.join(dir, "src"))
    File.write(File.join(dir, "src", "server.rb"), SERVER)
  end

  def test_the_http_api_section_runs_green
    commands = blocks("docs/guide.md", "An HTTP API").find { _1.lang == "sh" }
    Dir.mktmpdir do |dir|
      http_project(dir, json: false)
      commands.body.lines.map(&:strip).reject(&:empty?).each { nuka(dir, *words(_1).drop(1)) }
      assert_match(/1 scenario: 1 passed/, nuka(dir, "run"))
    end
  end

  def test_the_fetch_section_runs_green
    shown = blocks("docs/guide.md", "Calling the program with fetch")
    step = shown.find { _1.lang == "ruby" }
    feature = shown.find { _1.lang == "gherkin" }
    assert_equal "features/steps/get_greeting.rb", step.path
    Dir.mktmpdir do |dir|
      http_project(dir, json: true)
      write(dir, step)
      write(dir, feature)
      nuka(dir, *words(%(nuka scaffold message-is --pattern "the message is {text:string}" --then --from get-greeting.message)).drop(1))
      assert_match(/1 scenario: 1 passed/, nuka(dir, "run"))
    end
  end
end
