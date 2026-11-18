# frozen_string_literal: true
# rbs_inline: enabled

require "socket"
require "shellwords"
require "net/http"
require "securerandom"
require "timeout"
require "tmpdir"
require "fileutils"

# How the program under test starts, once per environment: an environment
# is a world of its own, with its own port, directory, and process, so one
# environment's state never reaches another's scenarios. A world goes
# through the TypeScript engine's phases in its order: build (once per
# tree per run), prepare, serve or url, then setup. Each phase has a limit,
# and a phase past it, or one that fails, stops the world and names itself.
module Nukadoko
  module Engine
    Environment = Data.define(
      :name, #: String
      :conditions, #: Hash[String, untyped]
      :env, #: Hash[untyped, untyped]
      :env_files, #: Array[String]
    )

    # One environment's program, its layer over the top level applied and
    # each limit filled. `reach` is how the world reaches its program:
    # `{ kind: "serve", serve: }`, `{ kind: "url", url:, timeout_ms: }`, or
    # `{ kind: "none" }`.
    Recipe = Data.define(
      :build, #: Array[Hash[Symbol, untyped]]
      :prepare, #: Array[Hash[Symbol, untyped]]
      :reach, #: Hash[Symbol, untyped]
      :env, #: Hash[String, String]
      :setup, #: Hash[Symbol, untyped]?
      :conditions, #: Hash[String, untyped]
      :lists, #: Array[Hash[Symbol, untyped]]
    )

    class Program
      # How long a build or prepare command may run, and a setup or a url
      # function take, unless the program says otherwise: a phase with no
      # limit left a run waiting on a command that never ended.
      DEFAULT_COMMAND_TIMEOUT_MS = 600_000
      DEFAULT_SETUP_TIMEOUT_MS = 60_000
      DEFAULT_URL_TIMEOUT_MS = 60_000
      # How long a `lists` command may run: a list is read while the world
      # waits to run its first scenario.
      DEFAULT_LIST_TIMEOUT_MS = 60_000
      # The most a list command may print; past it the list is not read.
      LIST_OUTPUT_CAP_BYTES = 16 * 1024 * 1024
      # What a placeholder names, as the TypeScript engine names them.
      PLACEHOLDER = /\{(port|url|dir|root|world|token|events|condition\.[A-Za-z0-9_.-]+)\}/

      #: (Hash[Symbol, untyped]) -> void
      def initialize(options)
        @options = options
        # Each tree's build runs once however many worlds it serves.
        @builds = {} #: Hash[String, [String, String?]]
      end

      # The worlds a run starts: each --env in the order given; without one,
      # defaultEnvironments in its order, else every environment that
      # declares conditions, else the top level under the name default.
      # default is always a name, whether or not the file defines it.
      #: (?Array[String]) -> Array[Environment]
      def environments(selected = [])
        declared = self.declared
        (selected.any? ? selected : default_names).map do |name|
          unless name == "default" || declared.key?(name)
            add = "add environments.#{name} to the program in nukadoko.config.rb"
            fix = if declared.empty? then "Leave out --env or pass --env default (the program in nukadoko.config.rb defines no other environment), or #{add}."
                  else "Pass --env with a name it accepts (#{["default", *declared.keys].uniq.sort.join(", ")}), or #{add}."
                  end
            raise Refusal.new("unknown-environment", %(Unknown environment "#{name}": not defined in the environments of the program in nukadoko.config.rb), fix: fix)
          end

          environment(name)
        end
      end

      # Whether the config gave a program, so each step names its world.
      #: () -> bool
      def file? = !@options.empty?

      #: () -> Hash[String, untyped]
      def declared = (@options[:environments] || {}).transform_keys(&:to_s)

      #: (String) -> Environment
      def environment(name)
        e = declared[name] || {}
        Environment.new(name, (e[:conditions] || {}).transform_keys(&:to_s), e[:env] || {}, Program.env_files(e))
      end

      # A read-only environment refuses every step that declares it mutates.
      #: (String) -> String?
      def policy(name) = declared.dig(name, :policy)&.to_s

      # The environment's version function, whose answer each record names
      # as target_version.
      #: (String) -> untyped
      def version(name) = declared.dig(name, :version)

      # The environment's fields over the top level's. A field the
      # environment writes replaces the top level's, except env, whose keys
      # merge with the environment's winning; serve and url are one choice.
      #: (Environment) -> Recipe
      def recipe(environment)
        e = declared[environment.name] || {}
        pick = ->(key) { e.key?(key) ? e[key] : @options[key] }
        Recipe.new(
          build: Array(pick.(:build)).map { Program.timed(_1, DEFAULT_COMMAND_TIMEOUT_MS) },
          prepare: Array(pick.(:prepare)).map { Program.timed(_1, DEFAULT_COMMAND_TIMEOUT_MS) },
          reach: Program.reach_of(e) || Program.reach_of(@options) || { kind: "none" },
          env: (@options[:env] || {}).merge(environment.env).to_h { |k, v| [k.to_s, v.to_s] },
          setup: Program.setup_of(pick.(:setup)),
          conditions: environment.conditions,
          # An environment's lists replace the top level's whole.
          lists: Events::LIST_KINDS.filter_map { |kind| (entry = (pick.(:lists) || {})[kind.to_sym]) && { kind: kind, **Program.timed(entry, DEFAULT_LIST_TIMEOUT_MS) } }
        )
      end

      #: (untyped, Integer) -> Hash[Symbol, untyped]
      def self.timed(entry, timeout_ms)
        return { command: words(entry), timeout_ms: timeout_ms } unless entry.is_a?(Hash)

        { command: words(entry[:command]), timeout_ms: entry[:timeout_ms] || timeout_ms }
      end

      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]?
      def self.reach_of(fields)
        return { kind: "serve", serve: fields[:serve] } if fields[:serve]

        url = fields[:url]
        return nil if url.nil?
        return { kind: "url", url: url[:resolve], timeout_ms: url[:timeout_ms] || DEFAULT_URL_TIMEOUT_MS } if url.is_a?(Hash)

        { kind: "url", url: url, timeout_ms: DEFAULT_URL_TIMEOUT_MS }
      end

      #: (untyped) -> Hash[Symbol, untyped]?
      def self.setup_of(setup)
        return nil if setup.nil?
        return { run: setup[:run], timeout_ms: setup[:timeout_ms] || DEFAULT_SETUP_TIMEOUT_MS } if setup.is_a?(Hash)

        { run: setup, timeout_ms: DEFAULT_SETUP_TIMEOUT_MS }
      end

      # The config's envFiles, then the environment's own: later files win.
      #: (Hash[Symbol, untyped]) -> Array[String]
      def self.env_files(environment) = [*Nukadoko.config_options[:envFiles], *environment[:envFiles]].map(&:to_s)

      #: () -> Array[String]
      def default_names
        return @options[:defaultEnvironments].map(&:to_s) if @options[:defaultEnvironments]

        conditioned = declared.select { |_, e| e[:conditions] }.keys
        conditioned.any? ? conditioned : ["default"]
      end

      # Why a run without --env starts the environments it starts.
      #: () -> String
      def chosen_by
        if @options[:defaultEnvironments] then "defaultEnvironments in nukadoko.config.rb"
        elsif default_names == ["default"] then "no environment declares conditions"
        else "the environments that declare conditions"
        end
      end

      # Each placeholder a world's program names that has no value there,
      # as `<where> names {<name>}, which has no value here: <why>`: build
      # runs before any world exists, a world with neither serve nor url has
      # no port or URL, and a condition must be one the environment declares.
      # `{events}` is the file nukadoko makes only for a world it serves.
      #: (Recipe) -> Array[String]
      def self.placeholder_gaps(recipe) = placeholder_gap_list(recipe).map { "#{_1[:where]} names {#{_1[:name]}}, which has no value here: #{_1[:why]}" }

      # The same gaps, each as the field, the placeholder, and why.
      #: (Recipe) -> Array[Hash[Symbol, String]]
      def self.placeholder_gap_list(recipe)
        kind = recipe.reach[:kind]
        fields = [
          *recipe.build.each_with_index.map { |entry, i| ["build[#{i}]", entry[:command], "build"] },
          *recipe.prepare.each_with_index.map { |entry, i| ["prepare[#{i}]", entry[:command], kind] },
          *(kind == "serve" ? [["serve.command", words(recipe.reach[:serve][:command]), kind]] : []),
          # A lists command runs only in a world nukadoko serves.
          *(kind == "serve" ? recipe.lists.map { ["lists.#{_1[:kind]}", _1[:command], kind] } : []),
          *recipe.env.map { |key, value| ["env.#{key}", [value], kind] }
        ] #: Array[[String, Array[String], String]]
        fields.flat_map do |where, texts, reach|
          texts.flat_map { _1.scan(PLACEHOLDER).flatten }.uniq.filter_map do |name|
            why = absence(name, reach, recipe.conditions)
            { where: where, name: name, why: why } if why
          end
        end
      end

      URL_EVENTS_WHY = "nukadoko does not start this world's program, so it reads no file the program writes"

      # The edit that closes `gap` in world `world` of `file`: it names only
      # what the world lacks. Outside a build, only a world with neither
      # serve nor url lacks a value, so the edit offers either one; a world
      # that has one of them is never told to add the other, which the file
      # refuses beside it. A condition is declared on the world's
      # environment, and a world that is no entry of `environments` is sent
      # to one that declares it.
      #: (Hash[Symbol, String], String, String, Hash[untyped, untyped]) -> String
      def self.placeholder_gap_fix(gap, world, file, environments)
        where = gap[:where]
        name = gap[:name]
        condition = name.delete_prefix("condition.")
        named = environments.transform_keys(&:to_s)
        if name.start_with?("condition.") && !where.start_with?("build")
          unless named.key?(world)
            declaring = named.select { |_, environment| (environment[:conditions] || environment["conditions"] || {}).transform_keys(&:to_s).key?(condition) }.keys
            outside = "The default world declares no conditions, and only an environment can"
            return "#{outside}; none in #{file} declares #{condition}. Declare it under conditions of an environment, or remove {#{name}} from #{where}." if declaring.empty?

            return "#{outside}: #{declaring.join(", ")} #{declaring.size == 1 ? "declares" : "declare"} #{condition}. Name one with --env, or remove {#{name}} from #{where}."
          end
          return "Declare #{condition} under conditions of world #{world} in #{file}, or remove {#{name}} from #{where}."
        end
        return "Write only {root} in #{where} of #{file}, or move the command to prepare, which runs once per world." if where.start_with?("build")
        if name == "events"
          # A url world is told to serve in place of its url, never beside it.
          edit = gap[:why] == URL_EVENTS_WHY ? "serve world #{world} in place of its url" : "give world #{world} serve"
          return "Remove {events} from #{where} of #{file}, or #{edit}: nukadoko makes the events file only for a program it starts."
        end
        "Remove {#{name}} from #{where} of #{file}, or give world #{world} serve or url."
      end

      #: (String, String, Hash[String, untyped]) -> String?
      def self.absence(name, reach, conditions)
        return name == "root" ? nil : "build runs once per tree, before any world exists" if reach == "build"
        if name.start_with?("condition.")
          condition = name.delete_prefix("condition.")
          return conditions.key?(condition) ? nil : %(its environment declares no condition "#{condition}" under conditions)
        end
        return "this world has neither serve nor url" if %w[port url events].include?(name) && reach == "none"
        return URL_EVENTS_WHY if name == "events" && reach == "url"

        nil
      end

      # Whether a field of the world's commands or env names `{name}`.
      #: (Recipe, String) -> bool
      def self.names_placeholder?(recipe, name)
        texts = [*recipe.prepare.flat_map { _1[:command] }, *(recipe.reach[:kind] == "serve" ? words(recipe.reach[:serve][:command]) : []), *recipe.env.values]
        texts.any? { _1.to_s.include?("{#{name}}") }
      end

      # The file a served world's program appends its execution events to,
      # made before its first command runs. The program writes it directly,
      # so it holds whatever the program wrote, secrets included, until
      # nukadoko reads and redacts it: it lives in a directory of its own
      # in the system's temporary directory, made with mode 0700, and the
      # file with mode 0600, never in the run directory, which CI uploads.
      # Only the redacted copies reach the run directory. The file exists
      # before the program starts, so every reader opens the same file, and
      # a reader can tell when the program replaced it.
      #: () -> String
      def self.open_events
        dir = Dir.mktmpdir("nukadoko-events-")
        File.chmod(0o700, dir)
        path = File.join(dir, "events.jsonl")
        File.open(path, File::WRONLY | File::CREAT | File::EXCL, 0o600, &:close)
        EVENTS_DIRS << dir
        path
      end

      # The events directories still to remove, however nukadoko ends.
      EVENTS_DIRS = [] #: Array[String]
      at_exit { EVENTS_DIRS.each { FileUtils.rm_rf(_1) } }

      # Started, or StartFailed with the world as far as it got, and the
      # message the run reports as program-start-failed. A base world that
      # has no URL of its own raises Unavailable.
      # `lists` reads the program's routes and flags lists in head's worlds,
      # as `nuka run` does; `tables` reads its tables list in a world of any
      # tree, which `nuka do` leaves out when its step reads no events.
      #: (Environment, String, String, ?tree: String, ?lists: bool, ?tables: bool) -> World
      def start(environment, dir, project, tree: "head", lists: false, tables: true)
        recipe = self.recipe(environment)
        reach = recipe.reach
        token = SecureRandom.hex(16)
        prefix = Trace.new_prefix
        log_path = File.join(dir, "program.log")
        world = World.new(base_url: nil, pid: nil, log: nil, env: {}, trace_prefix: prefix, log_path: nil, commands: [], timings: {}, token: token,
                          events_path: nil, places: {}, listed: {}, tables: Events::NO_MARKED_TABLES)
        begin
          gap = Program.placeholder_gaps(recipe).first
          raise StartError, gap if gap
          if tree == "base" && reach[:kind] == "url" && !reach[:url].respond_to?(:call)
            raise Unavailable, "its url is a fixed URL, where head's code runs, and only a url function can say where the base's code runs"
          end

          log = nil #: File?
          open_log = lambda do
            file = log || File.open(log_path, "w").tap { _1.sync = true }
            log = file
            world = world.with(log: file, log_path: log_path)
            file
          end
          run_command = lambda do |phase, argv, timeout_ms, env|
            world.commands << { phase: phase, argv: argv }
            Program.run_to_end(phase, argv, timeout_ms, env, project, open_log.())
          end

          built = build(recipe, project, environment.name, open_log, run_command)
          world.timings[:build_ms] = built if built
          place = SetupWorld.new(name: environment.name, root: project, dir: dir, tree: tree, url: nil, port: nil, env: {})
          port = nil #: Integer?
          url = nil #: String?
          case reach[:kind]
          when "serve"
            serve = reach[:serve]
            port = serve[:port] == "auto" ? Program.free_port : Program.unanswered(serve[:port].to_i)
            url = "http://localhost:#{port}"
          when "url"
            url = reach_url(reach, place, tree)
            port = Program.url_port(url)
          end
          # Before prepare, which may name it too.
          events = Program.open_events if reach[:kind] == "serve" && Program.names_placeholder?(recipe, "events")
          world = world.with(events_path: events) if events
          values = { "root" => project, "dir" => dir, "world" => environment.name, "token" => token, "port" => port&.to_s, "url" => url, "events" => events }.compact
          fill = ->(text) { Program.filled(text.to_s, values, recipe.conditions) }
          env = recipe.env.transform_values { fill.(_1) }.freeze
          # A step that could find the events file could append a line the
          # program never wrote, and a claim would read it as the program's.
          step_env = env.reject { |key, _| recipe.env[key].to_s.include?("{events}") }.freeze
          world = world.with(base_url: url, env: step_env)

          unless recipe.prepare.empty?
            started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            recipe.prepare.each { run_command.("prepare", _1[:command].map { |word| fill.(word) }, _1[:timeout_ms], env) }
            world.timings[:prepare_ms] = Request.since(started)
          end

          if reach[:kind] == "serve"
            serve = reach[:serve]
            # A command is an argv array, or a string split on whitespace, as
            # in the TypeScript engine; neither goes through a shell, so what
            # runs does not depend on the host's shell. A program that needs
            # one writes ["sh", "-c", "..."].
            argv = Program.words(serve[:command]).map { fill.(_1) }
            world.commands << { phase: "serve", argv: argv }
            out = open_log.()
            out.puts "$ #{Program.display(argv)}"
            started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            begin
              pid = Process.spawn(env, [argv.first, argv.first], *argv.drop(1), out: out, err: out, pgroup: true, chdir: project)
            rescue SystemCallError => e
              raise StartError, "serve command #{Program.display(argv)} could not start: #{e.message}"
            end
            world = world.with(pid: pid)
            world.wait_ready(serve[:ready], serve[:timeout_ms], argv)
            world.timings[:serve_ms] = Request.since(started)
          end

          if (setup = recipe.setup)
            started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            open_log.().puts "# setup"
            within("setup", setup[:timeout_ms]) do
              setup[:run].call(SetupWorld.new(name: environment.name, root: project, dir: dir, tree: tree, url: url, port: port, env: env.dup))
            rescue StartError, Timeout::Error
              raise
            rescue StandardError => e
              raise StartError, "setup threw: #{e.message}"
            end
            world.timings[:setup_ms] = Request.since(started)
          end

          # A list command that fails, passes its limit, or prints what is
          # not a list fails no world: the record names why its list was not
          # read, and nothing of it counts.
          wanted = recipe.lists.select { _1[:kind] == "tables" ? tables : lists && tree == "head" }
          if events && wanted.any?
            started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
            places = {} #: Hash[String, Array[Hash[Symbol, untyped]]]
            listed = {} #: Hash[String, Hash[Symbol, untyped]]
            wanted.each do |list|
              list_argv = list[:command].map { fill.(_1) }
              world.commands << { phase: "lists", argv: list_argv }
              read = Program.read_list(list[:kind], list_argv, list[:timeout_ms], env, project, open_log.())
              if read[:problem]
                listed[list[:kind]] = { entries: nil, error: read[:problem] }
              else
                listed[list[:kind]] = { entries: read[:entries].size, error: nil }
                places[list[:kind]] = read[:entries]
              end
            end
            world.timings[:lists_ms] = Request.since(started)
            # A tables list the world did not read leaves every table's
            # holding unknown, never state.
            marked = if places["tables"] then Events::Lists.tables_of(places["tables"])
                     elsif listed["tables"] then { unread: true }
                     else Events::NO_MARKED_TABLES
                     end
            world = world.with(places: places, listed: listed, tables: marked)
          end
          world
        rescue Unavailable
          world.stop
          world.remove_events
          raise
        rescue StartError => e
          world.stop
          # A world that did not start keeps no events: no step read any.
          world.remove_events
          tail = world.log_path ? File.readlines(log_path).last(20).join.chomp : ""
          message = "the program did not start for world #{environment.name}: #{e.message}#{". The end of #{log_path.delete_prefix("#{project}/")}:\n#{tail}" unless tail.empty?}"
          raise StartFailed.new(message, world, e.message)
        end
      end

      # What setup receives once its program answers, as the TypeScript
      # engine's ProgramWorld names it.
      SetupWorld = Data.define(
        :name, #: String
        :root, #: String
        :dir, #: String
        :tree, #: String
        :url, #: String?
        :port, #: Integer?
        :env, #: Hash[String, String]
      )

      # Why a world did not start, in the TypeScript engine's words.
      class StartError < StandardError; end

      # A base world with no URL to reach: it runs no cell, and nothing failed.
      class Unavailable < StandardError; end

      # A world that did not start: the message program-start-failed
      # carries, and the world as far as it got, which run.json names with
      # its cause.
      class StartFailed < StandardError
        attr_reader :world #: World
        attr_reader :cause_text #: String

        #: (String, World, String) -> void
        def initialize(message, world, cause_text)
          super(message)
          @world = world
          @cause_text = cause_text
        end
      end

      # argv as a shell would read it back, for a message and the log.
      #: (Array[String]) -> String
      def self.display(argv) = argv.map { Selection.shell_word(_1) }.join(" ")

      # A command's words: an Array as written, a String split on whitespace.
      #: (String | Array[String]) -> Array[String]
      def self.words(command) = command.is_a?(Array) ? command.map(&:to_s) : command.to_s.split

      # Each placeholder with its value; one with none is left as written,
      # which placeholder_gaps has already refused.
      #: (String, Hash[String, String], Hash[String, untyped]) -> String
      def self.filled(text, values, conditions)
        text.gsub(PLACEHOLDER) do
          name = Regexp.last_match(1).to_s
          name.start_with?("condition.") ? conditions.fetch(name.delete_prefix("condition."), "").to_s : values.fetch(name, "{#{name}}")
        end
      end

      # Runs one list command to its end and reads what it printed: the
      # list's entries (`{ entries: }`), or why it was not read
      # (`{ problem: }`). A failure is the list's and never the world's.
      #: (String, Array[String], Integer, Hash[String, String], String, File) -> Hash[Symbol, untyped]
      def self.read_list(kind, argv, timeout_ms, env, root, log)
        phase = "lists.#{kind}"
        reader, writer = IO.pipe
        bytes = 0
        chunks = [] #: Array[String]
        drain = Thread.new do
          loop do
            chunk = reader.readpartial(65_536)
            bytes += chunk.bytesize
            chunks << chunk if bytes <= LIST_OUTPUT_CAP_BYTES
          end
        rescue EOFError, IOError
          nil
        end
        begin
          run_to_end(phase, argv, timeout_ms, env, root, log, out: writer)
        rescue StartError => e
          return { problem: e.message }
        ensure
          writer.close
          drain.join
          reader.close
        end
        return { problem: "#{phase} command #{display(argv)} printed more than 16 MiB" } if bytes > LIST_OUTPUT_CAP_BYTES

        read = Events::Lists.parse(kind, chunks.join.force_encoding(Encoding::UTF_8).scrub)
        read[:problem] ? { problem: "#{phase} command #{display(argv)} printed a line that is not one entry of the list: #{read[:problem]}" } : read
      end

      # Runs one build, prepare, or list command to its end in the tree's
      # root, its stderr in the world's log and its stdout in `out` (the
      # log unless a list reads it), its process group stopped at its limit.
      #: (String, Array[String], Integer, Hash[String, String], String, File, ?out: IO) -> void
      def self.run_to_end(phase, argv, timeout_ms, env, root, log, out: log)
        shown = display(argv)
        log.puts "$ #{shown}"
        begin
          pid = Process.spawn(env, [argv.first, argv.first], *argv.drop(1), out: out, err: log, pgroup: true, chdir: root)
        rescue SystemCallError => e
          raise StartError, "#{phase} command #{shown} could not start: #{e.message}"
        end
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + (timeout_ms / 1000.0)
        loop do
          _, status = Process.waitpid2(pid, Process::WNOHANG)
          if status
            return if status.success?

            exit = status.signaled? ? "on SIG#{Signal.signame(status.termsig.to_i)}" : "with code #{status.exitstatus}"
            raise StartError, "#{phase} command #{shown} exited #{exit}"
          end
          if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
            begin
              Process.kill("TERM", -pid)
              Process.wait(pid)
            rescue Errno::ESRCH, Errno::ECHILD, Errno::EPERM
              nil
            end
            raise StartError, "#{phase} command #{shown} did not finish within #{timeout_ms} ms (timeout_ms)"
          end
          sleep 0.05
        end
      end

      # The port a request to `url` goes to: the one it writes, or its scheme's.
      #: (String) -> Integer
      def self.url_port(url) = URI(url).port || (url.start_with?("https:") ? 443 : 80)

      # Why `url` cannot be a world's URL: only http: and https: reach the
      # world, and a user or a password in it would print in every record.
      # The reason never quotes the URL, for that password.
      #: (String) -> String?
      def self.url_problem(url)
        http = 'must be an http: or https: URL, such as "http://localhost:3000"'
        parsed = URI.parse(url)
        return http unless %w[http https].include?(parsed.scheme) && parsed.host && !parsed.host.empty?
        return nil unless parsed.userinfo

        "must not hold a user or a password: every record names the world's URL; a step sends credentials itself, from an env file"
      rescue URI::InvalidURIError
        http
      end

      #: () -> Integer
      def self.free_port
        server = TCPServer.new("127.0.0.1", 0)
        server.addr[1].tap { server.close }
      end

      # A port the program names is checked before it starts: one something
      # already answers on would send every request to a server nukadoko
      # did not start.
      #: (Integer) -> Integer
      def self.unanswered(port)
        begin
          TCPSocket.new("localhost", port).close
        rescue SystemCallError
          return port
        end
        raise StartError, %(something already answers on port #{port}, so every request would reach a server nukadoko did not start; stop it, or write port: "auto")
      end

      private

      # The tree's build, once per run: a world whose build already ran for
      # another world waits on nothing and notes it in its log.
      #: (Recipe, String, String, ^() -> File, ^(String, Array[String], Integer, Hash[String, String]) -> void) -> Integer?
      def build(recipe, project, name, open_log, run_command)
        return if recipe.build.empty?

        commands = recipe.build.map { |entry| [entry[:command].map { Program.filled(_1, { "root" => project }, {}) }, entry[:timeout_ms]] }
        key = JSON.generate([project, commands.map(&:first)])
        if (earlier = @builds[key])
          open_log.().puts "# build: the same commands already ran for world #{earlier[0]}"
          raise StartError, "the build failed in world #{earlier[0]}" if earlier[1]

          return
        end
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        begin
          commands.each { |argv, timeout_ms| run_command.("build", argv, timeout_ms, ENV.to_h) }
        rescue StartError
          @builds[key] = [name, "failed"]
          raise
        end
        @builds[key] = [name, nil]
        Request.since(started)
      end

      # A url function's answer, under its limit, checked by the rule a
      # written url is checked by when the file is read.
      #: (Hash[Symbol, untyped], SetupWorld, String) -> String
      def reach_url(reach, place, tree)
        url = reach[:url]
        return url.to_s unless url.respond_to?(:call)

        answer = within("the url function", reach[:timeout_ms]) { url.call(place) }
        if answer.nil? || answer.to_s.empty?
          raise Unavailable, "its url function gave no URL for the base" if tree == "base"

          raise StartError, "the url function gave no URL"
        end
        problem = Program.url_problem(answer.to_s)
        raise StartError, "the url function's answer #{problem}" if problem

        answer.to_s
      end

      # Runs a setup or a url function under its limit. Ruby's Timeout stops
      # it where it is, which the TypeScript engine cannot do.
      #: [T] (String, Integer) { (Numeric) -> T } -> T
      def within(what, timeout_ms, &)
        Timeout.timeout(timeout_ms / 1000.0, &)
      rescue Timeout::Error
        raise StartError, "#{what} did not finish within #{timeout_ms} ms (timeout_ms)"
      end
    end

    # A started program: where it answers, its env, the prefix of every
    # trace id its steps carry, and its log. `timings` gains stop_ms at its
    # stop. `token` is the world's {token}, which every record redacts.
    World = Data.define(
      :base_url, #: String?
      :pid, #: Integer?
      :log, #: File?
      :env, #: Hash[String, String]
      :trace_prefix, #: String
      :log_path, #: String?
      :commands, #: Array[Hash[Symbol, untyped]]
      :timings, #: Hash[Symbol, Integer]
      :token, #: String
      :events_path, #: String?
      :places, #: Hash[String, Array[Hash[Symbol, untyped]]]
      :listed, #: Hash[String, Hash[Symbol, untyped]]
      :tables, #: Hash[Symbol, untyped]
    )

    class World
      # Ready once `path` answers 2xx, as in the TypeScript engine: a 404 or
      # a 503 from a server still starting is not a program that can take
      # requests. A program that exits first, or never answers 2xx within
      # `timeout_ms`, stops the world.
      # A redirect is an answer, not ready: following one would let a ready
      # path that sends the check elsewhere answer for the program.
      #: (String, Integer, Array[String]) -> void
      def wait_ready(path, timeout_ms, argv)
        uri = URI.join(base_url.to_s, path)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + (timeout_ms / 1000.0)
        last = nil #: String?
        shown = Program.display(argv)
        loop do
          if pid && (status = Process.waitpid2(pid, Process::WNOHANG)&.last)
            exit = status.signaled? ? "on #{Signal.signame(status.termsig.to_i).then { "SIG#{_1}" }}" : "with code #{status.exitstatus}"
            raise Program::StartError, "serve command #{shown} exited #{exit} before #{uri} answered"
          end
          remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
          if remaining <= 0
            raise Program::StartError, "serve command #{shown} did not answer #{uri} with a 2xx status within #{timeout_ms} ms (timeout_ms)#{"; #{last}" if last}"
          end
          begin
            response = Net::HTTP.start(uri.host.to_s, uri.port, open_timeout: [remaining, 2].min, read_timeout: [remaining, 2].min) { _1.get("#{uri.path}#{"?#{uri.query}" if uri.query}") }
            return if response.code.start_with?("2")

            location = response["location"]
            last = if response.code.start_with?("3") && location
                     "the last answer was #{response.code}, a redirect to #{location}, which the ready check does not follow"
                   else "the last answer was #{response.code}"
                   end
          rescue SystemCallError, IOError, Net::OpenTimeout, Net::ReadTimeout
            nil
          end
          sleep 0.1
        end
      end

      #: () -> void
      def stop
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        begin
          Process.kill("TERM", -pid) if pid
          Process.wait(pid) if pid
        rescue Errno::ESRCH, Errno::ECHILD, Errno::EPERM
          nil
        end
        log&.close
        timings[:stop_ms] = Request.since(started) if pid
      end

      # Removes the events file and its directory, once its lines are read.
      #: () -> void
      def remove_events
        return unless events_path

        dir = File.dirname(events_path.to_s)
        Program::EVENTS_DIRS.delete(dir)
        FileUtils.rm_rf(dir)
      end
    end
  end
end
