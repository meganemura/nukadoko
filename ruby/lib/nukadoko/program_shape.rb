# frozen_string_literal: true
# rbs_inline: enabled

# The shape of what the program lambda of nukadoko.config.rb returns, as
# the TypeScript engine's program schema reads it: every key is one this
# engine reads, every value is one it can use, and `serve` gets its
# defaults. A key the program does not know is refused, never skipped: a
# misspelt `ready` left the world ready on any answer from "/", which no
# record would show. A key the TypeScript engine reads and this one does
# not yet is refused too, naming it, so a program never describes a step
# that silently does not happen. Boundary: shape only; starting the
# program is Program's.
module Nukadoko
  module Engine
    module ProgramShape
      MAX_TIMEOUT_MS = 2_147_483_647
      DEFAULT_SERVE_TIMEOUT_MS = 60_000
      ENVIRONMENT_NAME = /\A[a-z0-9_-]+\z/
      CONDITION_NAME = /\A[A-Za-z0-9_.-]+\z/
      CONDITION_VALUE = /\A[^\s@]+\z/

      SERVE_KEYS = %i[command port ready timeout_ms].freeze
      # What the TypeScript engine reads that this one does not yet.
      NOT_YET = %i[lists].freeze
      PROGRAM_KEYS = %i[build prepare serve url env setup].freeze
      TOP_KEYS = [*PROGRAM_KEYS, :environments, :defaultEnvironments].freeze
      ENVIRONMENT_KEYS = [*PROGRAM_KEYS, :conditions, :policy, :envFiles, :version].freeze
      COMMAND_KEYS = %i[command timeout_ms].freeze

      # The program with `serve`'s defaults filled, or a Refusal naming
      # each problem, as `Invalid program at <file>: program.<path>: <why>`.
      #: (Hash[Symbol, untyped], String) -> Hash[Symbol, untyped]
      def self.read(program, file)
        issues = [] #: Array[String]
        read = fields(program, TOP_KEYS, [], issues)
        environments = program[:environments]
        if environments.is_a?(Hash)
          read[:environments] = environments.to_h do |name, environment|
            issues << "environments.#{name}: must be a name of lowercase letters, digits, \"_\", or \"-\"" unless name.to_s.match?(ENVIRONMENT_NAME)
            next [name, environment] unless environment.is_a?(Hash)

            [name, fields(environment, ENVIRONMENT_KEYS, ["environments", name.to_s], issues)]
          end
        elsif !environments.nil?
          issues << "environments: must be a Hash of environment names to environments"
        end
        default_environments(program, issues)
        return read if issues.empty?

        message = issues.map { _1.start_with?("unknown key") ? _1 : "program.#{_1}" }.join("; ")
        raise Refusal.new("config-invalid", "Invalid program at #{file}: #{message}", fix: "Correct the fields the message names in #{file}.")
      end

      # One level's fields: the keys it may hold, each value checked, and
      # `serve` with its defaults.
      #: (Hash[Symbol, untyped], Array[Symbol], Array[String], Array[String]) -> Hash[Symbol, untyped]
      def self.fields(level, keys, path, issues)
        at = ->(key) { [*path, key.to_s].join(".") }
        unknown = level.keys.map(&:to_sym) - keys - NOT_YET
        issues << "unknown key(s): #{unknown.map { described(_1, keys) }.join(", ")}" if unknown.any?
        (level.keys.map(&:to_sym) & NOT_YET).each do |key|
          issues << "#{at.(key)}: is read by the TypeScript engine and not yet by the Ruby engine, so the Ruby engine would not do what it describes"
        end
        read = level.dup
        read[:serve] = serve(level[:serve], at.(:serve), issues) if level.key?(:serve)
        %i[build prepare].each { commands(level[_1], at.(_1), issues) if level.key?(_1) }
        url(level[:url], at.(:url), issues) if level.key?(:url)
        setup(level[:setup], at.(:setup), issues) if level.key?(:setup)
        if level.key?(:serve) && level.key?(:url)
          issues << "#{at.(:url)}: serve and url are two ways to reach the program: serve starts it, url names one nukadoko does not start. Keep one."
        end
        issues << %(#{at.(:policy)}: must be "read-only") if level.key?(:policy) && level[:policy].to_s != "read-only"
        issues << "#{at.(:version)}: must be a lambda returning a String" if level.key?(:version) && !level[:version].respond_to?(:call)
        env(level[:env], at.(:env), issues) if level.key?(:env)
        conditions(level[:conditions], at.(:conditions), issues) if level.key?(:conditions)
        if level.key?(:envFiles) && !(level[:envFiles].is_a?(Array) && level[:envFiles].all?(String))
          issues << "#{at.(:envFiles)}: must be an Array of file names"
        end
        read
      end

      # A key it does not know, with the known key it matches when only its
      # case differs: that is a fact about the shape, not a guess.
      #: (Symbol, Array[Symbol]) -> String
      def self.described(key, known)
        match = known.find { _1.to_s.casecmp?(key.to_s) }
        match ? %(#{key} (did you mean "#{match}"?)) : key.to_s
      end

      #: (untyped, String, Array[String]) -> untyped
      def self.serve(serve, at, issues)
        unless serve.is_a?(Hash)
          issues << "#{at}: must be a Hash with command, and port, ready, and timeout_ms when they differ from the defaults"
          return serve
        end
        unknown = serve.keys.map(&:to_sym) - SERVE_KEYS
        issues << "unknown key(s): #{unknown.map { described(_1, SERVE_KEYS) }.join(", ")}" if unknown.any?
        issues << "#{at}.command: must name a program to run, as a String or an Array of words" unless command?(serve[:command])
        port = serve.fetch(:port, "auto")
        unless port == "auto" || (port.is_a?(Integer) && port.between?(1, 65_535))
          issues << %(#{at}.port: must be "auto" or a port number from 1 to 65535)
        end
        ready = serve.fetch(:ready, "/")
        problem = ready.is_a?(String) ? ready_problem(ready) : 'must be a path starting with "/"'
        issues << "#{at}.ready: #{problem}" if problem
        timeout = serve.fetch(:timeout_ms, DEFAULT_SERVE_TIMEOUT_MS)
        problem = timeout_problem(timeout)
        issues << "#{at}.timeout_ms: #{problem}" if problem
        { **serve, port: port, ready: ready, timeout_ms: timeout }
      end

      # A build or prepare list: each entry a command, or a command with a
      # timeout_ms of its own.
      #: (untyped, String, Array[String]) -> void
      def self.commands(list, at, issues)
        return issues << "#{at}: must be an Array of commands" unless list.is_a?(Array)

        list.each_with_index do |entry, index|
          where = "#{at}.#{index}"
          if entry.is_a?(Hash)
            unknown = entry.keys.map(&:to_sym) - COMMAND_KEYS
            issues << "unknown key(s): #{unknown.map { described(_1, COMMAND_KEYS) }.join(", ")}" if unknown.any?
            problem = entry.key?(:timeout_ms) ? timeout_problem(entry[:timeout_ms]) : nil
            issues << "#{where}.timeout_ms: #{problem}" if problem
            entry = entry[:command]
            where = "#{where}.command"
          end
          issues << "#{where}: must name a program to run, as a String or an Array of words" unless command?(entry)
        end
      end

      #: (untyped) -> bool
      def self.command?(command)
        words = command.is_a?(Array) ? command : command.to_s.split
        (command.is_a?(String) || (command.is_a?(Array) && command.all?(String))) && !words.first.to_s.empty?
      end

      # A program nukadoko does not start: a URL, a lambda that returns one,
      # or `{ resolve:, timeout_ms: }`.
      #: (untyped, String, Array[String]) -> void
      def self.url(url, at, issues)
        if url.is_a?(String)
          problem = Program.url_problem(url)
          issues << "#{at}: #{problem}" if problem
        elsif url.is_a?(Hash)
          unknown = url.keys.map(&:to_sym) - %i[resolve timeout_ms]
          issues << "unknown key(s): #{unknown.map { described(_1, %i[resolve timeout_ms]) }.join(", ")}" if unknown.any?
          issues << "#{at}.resolve: must be a lambda returning a URL" unless url[:resolve].respond_to?(:call)
          problem = url.key?(:timeout_ms) ? timeout_problem(url[:timeout_ms]) : nil
          issues << "#{at}.timeout_ms: #{problem}" if problem
        elsif !url.respond_to?(:call)
          issues << "#{at}: must be a URL or a lambda returning one"
        end
      end

      # A lambda run once the program answers, or `{ run:, timeout_ms: }`.
      #: (untyped, String, Array[String]) -> void
      def self.setup(setup, at, issues)
        return if setup.respond_to?(:call)
        return issues << "#{at}: must be a lambda" unless setup.is_a?(Hash)

        unknown = setup.keys.map(&:to_sym) - %i[run timeout_ms]
        issues << "unknown key(s): #{unknown.map { described(_1, %i[run timeout_ms]) }.join(", ")}" if unknown.any?
        issues << "#{at}.run: must be a lambda" unless setup[:run].respond_to?(:call)
        problem = setup.key?(:timeout_ms) ? timeout_problem(setup[:timeout_ms]) : nil
        issues << "#{at}.timeout_ms: #{problem}" if problem
      end

      # Why `ready` cannot be the path polled on the world's own server: a
      # second "/" or a "\" after the first names another host, which could
      # answer for a program that never started.
      #: (String) -> String?
      def self.ready_problem(ready)
        return 'must be a path starting with "/"' unless ready.start_with?("/")

        if ready.start_with?("//") || ready.start_with?("/\\")
          'must be a path on the world\'s own server, starting with one "/": a second "/" or a "\\" after it names another host'
        end
      end

      #: (untyped) -> String?
      def self.timeout_problem(timeout)
        return "must be a whole number of milliseconds" unless timeout.is_a?(Integer)
        return "must be at least 1 ms" if timeout < 1

        "must be at most #{MAX_TIMEOUT_MS} ms" if timeout > MAX_TIMEOUT_MS
      end

      #: (untyped, String, Array[String]) -> void
      def self.env(env, at, issues)
        return issues << "#{at}: must be a Hash of variable names to String values" unless env.is_a?(Hash)

        env.each { |key, value| issues << "#{at}.#{key}: must be a String" unless value.is_a?(String) }
      end

      # Each condition is a fact a `@with:` tag reads: a boolean, or a word
      # with no whitespace and no "@". "true" and "false" as strings are
      # refused, since a string reads as on whatever it says.
      #: (untyped, String, Array[String]) -> void
      def self.conditions(conditions, at, issues)
        return issues << "#{at}: must be a Hash of condition names to values" unless conditions.is_a?(Hash)

        conditions.each do |name, value|
          unless name.to_s.match?(CONDITION_NAME)
            issues << %(#{at}.#{name}: must be a condition name of letters, digits, "_", ".", or "-", as @with:<name> names it)
          end
          next if [true, false].include?(value)

          if !value.is_a?(String) || !value.match?(CONDITION_VALUE)
            issues << %(#{at}.#{name}: must be true, false, or a value with no whitespace and no "@", as @with:<name>=<value> names it)
          elsif %w[true false].include?(value)
            issues << "#{at}.#{name}: is a boolean written as a string, which @with:<name> reads as on whatever it says: write the boolean, without quotes"
          end
        end
      end

      # `defaultEnvironments` names environments of this program, each once.
      #: (Hash[Symbol, untyped], Array[String]) -> void
      def self.default_environments(program, issues)
        return unless program.key?(:defaultEnvironments)

        named = program[:defaultEnvironments]
        unless named.is_a?(Array) && named.all? { _1.is_a?(String) || _1.is_a?(Symbol) }
          return issues << "defaultEnvironments: must be an Array of environment names"
        end
        return issues << "defaultEnvironments: must name at least one environment; leave it out for the default selection" if named.empty?

        defined = (program[:environments].is_a?(Hash) ? program[:environments].keys : []).map(&:to_s)
        named.map(&:to_s).each_with_index do |name, index|
          unless name == "default" || defined.include?(name)
            listed = defined.empty? ? "it defines none" : "it defines #{defined.map { %("#{_1}") }.join(", ")}"
            issues << %(defaultEnvironments.#{index}: names "#{name}", which is neither default nor an environment of this file (#{listed}))
          end
          if named.map(&:to_s).index(name) != index
            issues << %(defaultEnvironments.#{index}: names "#{name}" more than once, which would run every scenario twice under one name)
          end
        end
      end
    end
  end
end
