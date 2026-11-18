# frozen_string_literal: true
# rbs_inline: enabled

# The states a step declares (`requires`, `gives`, `ends`), read and refused
# as the TypeScript engine's defineStep refuses them, and the walk that
# judges one scenario against them: whether a line that requires a state
# can only be reached with it not held. nuka check reports that walk per
# feature file, and nuka run refuses a scenario it finds before any of its
# steps runs, so a scenario never passes one and fails the other.
#
# The walk follows the one path on which a line runs at all: every line
# before it passed. A line no step matches makes every state unknown, and
# unknown is never reported. It never says a state holds, only that it
# cannot.
module Nukadoko
  module Engine
    module States
      Use = Data.define(
        :state, #: String
        :key, #: String?
      )

      Declared = Data.define(
        :requires, #: Array[Use]
        :gives, #: Array[Use]
        :ends, #: Array[Use]
      )

      # One requiring line the walk can only reach with the state not held.
      Draft = Data.define(
        :index, #: Integer
        :step_name, #: String
        :use, #: Use
        :holder, #: String?
        :cause, #: Hash[Symbol, untyped]
        :also, #: Array[Integer]
      )

      # One line of a scenario: the step it binds alone, and the text each
      # capture read, or nil for a line no single step matches.
      Line = Data.define(
        :step, #: singleton(Step)
        :texts, #: Hash[String, String]
      )

      # What the walk knows of one state just before a line: a fact per
      # holder a line has named, and one for every holder none has. A fact
      # is [:held], [:not_held, the index of the line that ended it or
      # nil], or [:unknown].
      Facts = Data.define(
        :by, #: Hash[String, Array[untyped]]
        :unnamed, #: Array[untyped]
      )

      LISTS = %i[requires gives ends].freeze
      FORMS = 'a name ("signed-in") or a [name, key] pair (["signed-in", "person"])'

      # `signed-in for person`, or `book-open`: how nuka steps names an entry.
      #: (Use) -> String
      def self.describe(use) = use.key ? "#{use.state} for #{use.key}" : use.state

      #: (Use) -> String
      def self.quoted(use) = use.key ? "[#{use.state.to_json}, #{use.key.to_json}]" : use.state.to_json

      # The three lists read against the step's args keys, or the problem
      # with the first entry that is not a state a line can hold, in the
      # TypeScript engine's words.
      #: (singleton(Step)) -> (Declared | String)
      def self.read(step)
        keys = step.args.fields.map { _1.name.to_s }
        read = {} #: Hash[Symbol, Array[Use]]
        LISTS.each do |list|
          uses = [] #: Array[Use]
          step.public_send(list).each_with_index do |entry, index|
            at = "#{list}[#{index}]"
            use = entry_use(entry)
            return "#{at} is not a state: write #{FORMS}" unless use
            if use.state.empty? || use.state.strip != use.state
              return "#{at} names the state #{use.state.to_json}, and a state name is not empty and has no space at either end"
            end
            if use.key && !keys.include?(use.key)
              declared = keys.empty? ? "args declares no key" : "args declares #{keys.map(&:to_json).join(", ")}"
              return "#{at} names args key #{use.key.to_json}, which args does not declare: #{declared}"
            end
            earlier = uses.index(use)
            return "#{at} repeats #{quoted(use)} from #{list}[#{earlier}]" if earlier

            uses << use
          end
          read[list] = uses
        end
        gives = read.fetch(:gives)
        ends = read.fetch(:ends)
        gives.each_with_index do |use, index|
          ended = ends.index(use)
          return "gives[#{index}] and ends[#{ended}] both name #{quoted(use)}, and a step leaves a state one way" if ended
        end
        Declared.new(requires: read.fetch(:requires), gives: gives, ends: ends)
      end

      #: (untyped) -> Use?
      def self.entry_use(entry)
        return Use.new(state: entry.to_s, key: nil) if entry.is_a?(String) || entry.is_a?(Symbol)
        return nil unless entry.is_a?(Array) && entry.size == 2 && entry.all? { _1.is_a?(String) || _1.is_a?(Symbol) }

        Use.new(state: entry[0].to_s, key: entry[1].to_s)
      end

      # What every step of a vocabulary says about each state: which name it
      # with a key and which without, and which can give it from a line.
      class Index
        attr_reader :states #: Hash[String, Hash[Symbol, Array[untyped]]]

        #: (Array[singleton(Step)]) -> void
        def initialize(steps)
          @states = {}
          @parts = {} #: Hash[singleton(Step), Array[String]]
          steps.each do |step|
            declared = step.states
            next unless declared

            [*declared.requires, *declared.gives, *declared.ends].each do |use|
              info = (@states[use.state] ||= { keyed: [], unkeyed: [], givers: [] })
              shape = use.key ? info[:keyed] : info[:unkeyed]
              shape << step.step_name unless shape.include?(step.step_name)
            end
            pattern = step.patterns.first
            if pattern
              declared.gives.each do |use|
                givers = @states.fetch(use.state)[:givers]
                givers << { name: step.step_name, key: use.key, pattern: pattern } unless givers.any? { _1[:name] == step.step_name }
              end
            end
            @parts[step] = through_parts(step)
          end
        end

        # The states the step's transitive parts give or end.
        #: (singleton(Step)) -> Array[String]
        def parts_of(step) = @parts[step] || []

        #: (String) -> bool
        def mismatched?(state)
          info = @states.fetch(state)
          info[:keyed].any? && info[:unkeyed].any?
        end

        private

        #: (singleton(Step)) -> Array[String]
        def through_parts(step)
          found = [] #: Array[String]
          seen = [step]
          visit = lambda do |current|
            current.parts.each do |part|
              next if seen.include?(part) || !(part.is_a?(Class) && part < Step)

              seen << part
              declared = part.states
              found.concat([*declared.gives, *declared.ends].map(&:state)) if declared
              visit.(part)
            end
          end
          visit.(step)
          found.uniq
        end
      end

      # Each line of the scenario as the walk reads it: the one step it
      # binds and the text each word or string capture read.
      #: (Array[singleton(Step)], Scenario) -> Array[Line?]
      def self.lines(steps, scenario)
        scenario.steps.map do |line|
          matched = [] #: Array[Line]
          steps.each do |step|
            texts = step.patterns.lazy.filter_map { captured(_1, line.text) }.first
            matched << Line.new(step: step, texts: texts) if texts
          end
          matched.size == 1 ? matched.first : nil
        end
      end

      # A {word} capture reads its text as written, and a {string} its text
      # inside the quotes; another type reads a value only the run knows.
      #: (String, String) -> Hash[String, String]?
      def self.captured(pattern, text)
        values = Pattern.new(pattern).match(text)
        return nil unless values

        types = pattern.scan(Pattern::NAMED).to_h { |key, type| [key.to_s, type.to_s] }
        values.select { |key, value| %w[word string].include?(types[key]) && value.is_a?(String) }
      end

      # The holder a line names for `use`: "" for an unkeyed state, the
      # captured text when the key's field is a plain string, or nil when
      # only the run knows it.
      #: (Line, Use) -> String?
      def self.holder_of(line, use)
        return "" unless use.key

        text = line.texts[use.key.to_s]
        text && line.step.args[use.key.to_s]&.type == :string ? text : nil
      end

      # Walks the scenario once and returns every requiring line that only
      # one outcome can reach: the state not held. Pure.
      #: (Array[Line?], Index) -> Array[Draft]
      def self.walk(lines, index)
        return [] if index.states.empty?

        facts = index.states.keys.to_h { [_1, Facts.new(by: {}, unnamed: [:not_held, nil])] }
        given_at = [] #: Array[[Integer, String, String]]
        drafts = [] #: Array[Draft]
        open = {} #: Hash[untyped, Draft]
        undeclared = lambda do |from, to, state|
          lines[from...to].to_a.filter_map do |line|
            next unless line && !line.step.claims

            declared = line.step.states
            line.step.step_name unless declared && [*declared.requires, *declared.gives, *declared.ends].any? { _1.state == state }
          end.uniq
        end

        lines.each_with_index do |line, at|
          declared = line&.step&.states
          if line && declared
            declared.requires.each do |use|
              info = index.states.fetch(use.state)
              next if index.mismatched?(use.state)

              current = facts.fetch(use.state)
              holder = holder_of(line, use)
              unless holder
                nobody = current.unnamed[0] == :not_held && current.by.values.all? { _1[0] == :not_held }
                next unless nobody

                cause = info[:givers].empty? ? { kind: :no_giver } : { kind: :held_by_none, undeclared: undeclared.(0, at, use.state) }
                drafts << Draft.new(index: at, step_name: line.step.step_name, use: use, holder: nil, cause: cause, also: [])
                next
              end
              fact = current.by[holder] || current.unnamed
              next unless fact[0] == :not_held

              fold = [use.state, holder, fact[1]]
              if (earlier = open[fold])
                earlier.also << at unless earlier.index == at || earlier.also.include?(at)
                next
              end
              ender = fact[1] && lines[fact[1]]
              cause = if info[:givers].empty? then { kind: :no_giver }
                      elsif fact[1] && ender then { kind: :ended, index: fact[1], step_name: ender.step.step_name, undeclared: undeclared.(fact[1] + 1, at, use.state) }
                      else
                        { kind: :never_given, others: given_at.select { _1[1] == use.state && _1[2] != holder }, undeclared: undeclared.(0, at, use.state) }
                      end
              draft = Draft.new(index: at, step_name: line.step.step_name, use: use, holder: use.key ? holder : nil, cause: cause, also: [])
              open[fold] = draft
              drafts << draft
            end
          end
          if line.nil? || declared.nil?
            facts = facts.transform_values { Facts.new(by: {}, unnamed: [:unknown]) }
            next
          end

          changes = [] #: Array[[String, Symbol, String?]]
          declared.ends.each { changes << [_1.state, :end, holder_of(line, _1)] }
          declared.gives.each { changes << [_1.state, :give, holder_of(line, _1)] }
          named = changes.map(&:first)
          index.parts_of(line.step).each { changes << [_1, :unknown, nil] unless named.include?(_1) }
          changes.each do |change|
            state, op, holder = change
            facts[state] = apply(facts.fetch(state), op, holder, at)
            given_at << [at, state, holder] if op == :give && holder && holder != ""
          end
        end
        drafts
      end

      #: (Facts, Symbol, String?, Integer) -> Facts
      def self.apply(facts, op, holder, at)
        return Facts.new(by: {}, unnamed: [:unknown]) if op == :unknown
        return Facts.new(by: facts.by.merge(holder => op == :give ? [:held] : [:not_held, at]), unnamed: facts.unnamed) if holder

        # Exactly one holder changes, and the walk does not know which.
        changing = op == :give ? :not_held : :held
        blur = ->(fact) { fact[0] == changing ? [:unknown] : fact }
        Facts.new(by: facts.by.transform_values(&blur), unnamed: blur.(facts.unnamed))
      end

      # The scenario's state issues by line index, each the message nuka run
      # puts on the line it refuses.
      #: (Array[singleton(Step)], Scenario) -> Hash[Integer, Array[String]]
      def self.refusals(steps, scenario)
        index = Index.new(steps)
        lines = self.lines(steps, scenario)
        at = ->(i) { "line #{scenario.steps[i].line}" }
        walk(lines, index).each_with_object({}) do |draft, found|
          (found[draft.index] ||= []) << message(draft, at, scenario, draft.also.map(&at))
        end
      end

      # state-missing over every scenario of one feature file, for nuka
      # check. A Background line reaches the same finding in every
      # scenario, so it is reported once with the folded lines of all of
      # them.
      #: (Array[singleton(Step)], Array[Scenario]) -> Array[Hash[Symbol, untyped]]
      def self.findings(steps, scenarios)
        index = Index.new(steps)
        merged = {} #: Hash[untyped, Hash[Symbol, untyped]]
        scenarios.each do |scenario|
          at = ->(i) { "line #{scenario.steps[i].line}" }
          walk(lines(steps, scenario), index).each do |draft|
            line = scenario.steps[draft.index].line
            key = [scenario.uri, line, message(draft, at, scenario, []), fix(draft, at, index, at.(draft.index))]
            found = (merged[key] ||= { draft: draft, scenario: scenario, at: at, uri: scenario.uri, line: line, folded: {}, scenarios: [] })
            draft.also.each { found[:folded][at.(_1)] = scenario.steps[_1].line }
            found[:scenarios] |= [[scenario.uri, scenario.keyword_line]] if draft.also.any?
          end
        end
        merged.values.map do |found|
          draft = found[:draft]
          at = found[:at]
          labels = found[:folded].sort_by { _2 }.map(&:first)
          last = found[:scenarios].size > 1 ? nil : (labels.last || at.(draft.index))
          { uri: found[:uri], line: found[:line], step: draft.step_name,
            message: message(draft, at, found[:scenario], labels), fix: fix(draft, at, index, last) }
        end
      end

      # Every state some steps name with a key and others without.
      #: (Array[singleton(Step)]) -> Array[Hash[Symbol, untyped]]
      def self.shape_issues(steps)
        index = Index.new(steps)
        index.states.filter_map do |state, info|
          next unless index.mismatched?(state)

          named = ->(names) { names.size == 1 ? %(step "#{names.first}") : "steps #{names.map { %("#{_1}") }.join(", ")}" }
          { state: state, step: (info[:unkeyed].size <= info[:keyed].size ? info[:unkeyed] : info[:keyed]).first,
            message: %(State "#{state}" has a holder key in #{named.(info[:keyed])} and none in #{named.(info[:unkeyed])}, so no line that requires it is judged),
            fix: %(Write "#{state}" the same way in every step: ["#{state}", "<key>"] in each requires, gives, and ends entry, or the bare name in all of them.) }
        end
      end

      #: (Array[String]) -> String
      def self.listed(items) = items.size <= 2 ? items.join(" and ") : "#{items[0...-1].to_a.join(", ")}, and #{items.last}"

      #: (Draft, ^(Integer) -> String, Scenario, Array[String]) -> String
      def self.message(draft, at, scenario, also)
        use = draft.use
        holder = draft.holder
        cause = draft.cause
        subject = if use.key.nil? then %(Step "#{draft.step_name}" requires "#{use.state}")
                  elsif holder.nil? then %(Step "#{draft.step_name}" requires "#{use.state}" for a #{use.key} this line does not name)
                  else %(Step "#{draft.step_name}" requires "#{use.state}" for #{use.key} "#{holder}")
                  end
        reason = case cause[:kind]
                 when :no_giver then "no step gives it, so no line can"
                 when :ended then %(#{at.(cause[:index])} "#{scenario.steps[cause[:index]].text}" (step "#{cause[:step_name]}") ends it, with no line between them giving it again)
                 when :held_by_none then "by what the earlier lines declare, no #{use.key || "holder"} holds it here"
                 else
                   if draft.index.zero?
                     "no earlier line gives it: #{at.(0)} is the scenario's first line"
                   else
                     others = cause[:others].map { |given, _, who| "#{at.(given)} gives it to #{who}" }
                     "no earlier line gives it#{holder ? " to #{holder}" : ""}#{others.any? ? ": #{listed(others)}" : ""}"
                   end
                 end
        "#{subject}, and #{reason}#{also_required(also)}. nuka run refuses this scenario before any of its steps runs"
      end

      #: (Array[String]) -> String
      def self.also_required(labels)
        return "" if labels.empty?
        return "; #{labels.first} requires it too" if labels.size == 1

        numbers = labels.all? { _1.start_with?("line ") } ? labels.map { _1.delete_prefix("line ") } : nil
        "; #{numbers ? "lines #{listed(numbers)}" : listed(labels)} require it too"
      end

      #: (Draft, ^(Integer) -> String, Index, String?) -> String
      def self.fix(draft, at, index, last)
        use = draft.use
        cause = draft.cause
        ref = use.key ? %(["#{use.state}", "<key>"]) : %("#{use.state}")
        if cause[:kind] == :no_giver
          given = index.states.select { |_, info| info[:givers].any? }.keys
          known = given.empty? ? "No step gives a state yet." : "The states steps give: #{given.map { %("#{_1}") }.join(", ")}."
          return %(Add #{ref} to the gives of the step that leaves it holding, or correct the name in the requires of step "#{draft.step_name}". #{known})
        end
        givers = index.states.fetch(use.state)[:givers].map do |giver|
          filled = draft.holder && giver[:key] ? { giver[:key] => draft.holder } : {}
          %("#{giver[:name]}" ("#{ExampleLine.of(giver[:pattern], filled)}"))
        end
        runs = givers.size == 1 ? "step #{givers.first}" : "one of steps #{givers.join(", ")}"
        put = if cause[:kind] == :ended
                "Put a line that runs #{runs} between #{at.(cause[:index])} and #{at.(draft.index)}#{last ? ", or move #{at.(cause[:index])} below #{last}" : ""}."
              else
                "Put a line that runs #{runs} before #{at.(draft.index)}."
              end
        names = cause[:undeclared]
        undeclared = if names.empty? then ""
                     elsif names.size == 1 then %( Or, if step "#{names.first}" gives "#{use.state}" without saying so, add #{ref} to its gives.)
                     else %( Or, if one of steps #{names.map { %("#{_1}") }.join(", ")} gives "#{use.state}" without saying so, add #{ref} to that step's gives.)
                     end
        %(#{put}#{undeclared} If the scenario means to show what happens without "#{use.state}", the line needs a step that does not require it.)
      end
    end

    # A feature line a pattern matches, for a finding that tells an agent
    # which line to add: a capture becomes the value given for its key, an
    # optional group is dropped (or kept when it stands as a word of its
    # own), an alternation keeps its first alternative, and an escape gives
    # its character. It never runs a parameter type.
    module ExampleLine
      #: (String, Hash[String, String]) -> String
      def self.of(pattern, filled)
        line = +""
        i = 0
        while i < pattern.length
          ch = pattern[i].to_s
          if ch == "\\" && i + 1 < pattern.length
            line << pattern[i + 1].to_s
            i += 2
          elsif ch == "{"
            close = pattern.index("}", i + 1)
            return line + pattern[i..].to_s unless close

            line << capture(pattern[(i + 1)...close].to_s, filled)
            i = close + 1
          elsif ch == "("
            close = skip_optional(pattern, i)
            alone = (i.zero? || pattern[i - 1] == " ") && (close >= pattern.length || pattern[close] == " ")
            line << pattern[(i + 1)...(close - 1)].to_s.gsub(/\\(.)/, '\1') if alone
            i = close
          elsif ch == "/"
            i = skip_alternatives(pattern, i)
          else
            line << ch
            i += 1
          end
        end
        line
      end

      # {word} matches no space, so a holder a {string} capture read
      # elsewhere ("Aki Tanaka") would make a line the step never matches.
      #: (String, Hash[String, String]) -> String
      def self.capture(token, filled)
        key, type = token.split(":", 2)
        return "{#{token}}" unless key && type && key.match?(/\A[A-Za-z_][\w-]*\z/)

        given = filled[key]
        fits = given && !(type == "word" && (given.empty? || given.match?(/\s/)))
        value = fits ? given.to_s : "<#{key}>"
        type == "string" ? %("#{value.gsub('"', '\\"')}") : value
      end

      #: (String, Integer) -> Integer
      def self.skip_optional(pattern, start)
        i = start + 1
        i += pattern[i] == "\\" ? 2 : 1 while i < pattern.length && pattern[i] != ")"
        i + 1
      end

      #: (String, Integer) -> Integer
      def self.skip_alternatives(pattern, start)
        i = start + 1
        while i < pattern.length && pattern[i] != " " && pattern[i] != "{"
          i = if pattern[i] == "\\" then i + 2
              elsif pattern[i] == "(" then skip_optional(pattern, i)
              else i + 1
              end
        end
        i
      end
    end
  end
end
