# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: read a `matches` claim's pattern as JavaScript's RegExp
# reads it, so the Ruby engine judges the claim the way the TypeScript
# engine does: `new RegExp(pattern)`, no flags, with the web's legacy
# grammar (a `{` that starts no quantifier is a `{`, `\A` is an `A`). Ruby's
# own grammar reads the same text otherwise: `^` and `$` there match at
# every line, `\s` takes no Unicode space, `\A` and `\h` mean something,
# `[^]` does not build, and an unnamed group stops capturing once a named
# one is present. So the pattern is parsed here and written again as a
# Ruby pattern that means what the JavaScript one does.
#
# JavaScript matches a text unit by UTF-16 unit, so `.` takes half of an
# emoji. Each half of a character past U+FFFF, in the pattern and in the
# text, is therefore written as one character of its own in plane 16's
# private use area (`units`).
#
# Honest limits: case-insensitive matching inside `(?i:...)` folds case as
# Ruby does, which differs for a few letters (the Kelvin sign, the long
# s); a lookbehind Ruby cannot run (one of unbounded length, or holding a
# backreference) is refused with Ruby's reason; a group inside a repeated
# group keeps its capture from an earlier round, where JavaScript clears it.
module Nukadoko
  module Engine
    module JsPattern
      # A pattern JavaScript refuses, with V8's message.
      class Invalid < StandardError; end

      LINE_ENDS = "\\n\\r\\u{2028}\\u{2029}"
      SPACE = "\\t\\n\\v\\f\\r \\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}"
      WORD = "A-Za-z0-9_"
      SETS = { "d" => ["0-9", false], "D" => ["0-9", true], "w" => [WORD, false], "W" => [WORD, true], "s" => [SPACE, false], "S" => [SPACE, true] }.freeze
      CONTROL = { "f" => 0x0c, "n" => 0x0a, "r" => 0x0d, "t" => 0x09, "v" => 0x0b }.freeze
      # Where a UTF-16 surrogate unit is written as a character of its own.
      UNIT_BASE = 0x10F000
      SURROGATES = (0xD800..0xDFFF)
      # Ruby refuses a repeat count past this; JavaScript takes any.
      REPEAT_LIMIT = 100_000
      GROUP_NAME = /\A[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$‌‍]*\z/

      # `text` with each character past U+FFFF written as its two UTF-16
      # units, each in plane 16's private use area.
      #: (String) -> String
      def self.units(text)
        return text unless text.match?(/[^\u0000-￿]/)

        text.each_char.map do |char|
          code = char.ord
          next char if code <= 0xFFFF

          code -= 0x10000
          [unit(0xD800 + (code >> 10)), unit(0xDC00 + (code & 0x3FF))].join
        end.join
      end

      # The character a UTF-16 unit is written as.
      #: (Integer) -> String
      def self.unit(code) = (SURROGATES.cover?(code) ? UNIT_BASE + code - 0xD800 : code).chr(Encoding::UTF_8)

      # The Ruby pattern that matches what `new RegExp(source)` matches, in
      # a text written through `units`.
      #: (String, ?timeout: Float?) -> Regexp
      def self.compile(source, timeout: nil)
        written = Parser.new(source).call
        verbose = $VERBOSE
        $VERBOSE = nil
        begin
          Regexp.new(written, timeout: timeout)
        rescue RegexpError => e
          raise Invalid, "Invalid regular expression: /#{source}/: the Ruby engine cannot run this pattern (#{e.message.sub(/: \/.*\z/m, "")})"
        ensure
          $VERBOSE = verbose
        end
      end

      # Reads a pattern in JavaScript's legacy grammar and writes it in
      # Ruby's. Every group is written named, `g<n>` by JavaScript's group
      # number, since Ruby stops counting unnamed groups once a named one is
      # present, and a backreference to a group that has not matched
      # matches nothing, as in JavaScript.
      class Parser
        #: (String) -> void
        def initialize(source)
          @source = source
          @chars = JsPattern.units(source).chars
          @at = 0
          @group = 0
          @names = {} #: Hash[String, Array[Integer]]
          # The names a group may not take again here: those of groups that
          # can match together with the one being read. Two groups may share
          # a name only in different alternatives.
          @visible = [] #: Array[String]
          @count = count_groups
        end

        #: () -> String
        def call
          written = disjunction({ i: false, m: false, s: false })
          fail!("Unmatched ')'") if peek == ")"
          written
        end

        private

        #: (String) -> bot
        def fail!(reason) = raise(Invalid, "Invalid regular expression: /#{@source}/: #{reason}")

        #: (?Integer) -> String?
        def peek(ahead = 0) = @chars[@at + ahead]

        #: () -> String?
        def take
          char = @chars[@at]
          @at += 1
          char
        end

        #: (String) -> bool
        def taken?(text)
          return false unless @chars[@at, text.length]&.join == text

          @at += text.length
          true
        end

        # The index of the `>` that ends a group name started at `from`.
        #: (Integer) -> Integer?
        def find_close(from) = (from...@chars.length).find { @chars[_1] == ">" }

        # Every capturing group's number and every group name, read before
        # the parse, since a backreference may name a later group.
        #: () -> Integer
        def count_groups
          count = 0
          index = 0
          in_class = false
          while index < @chars.length
            char = @chars[index]
            if char == "\\"
              index += 2
              next
            end
            if in_class
              in_class = false if char == "]"
            elsif char == "["
              in_class = true
            elsif char == "(" && @chars[index + 1] != "?"
              count += 1
            elsif char == "(" && @chars[index + 1] == "?" && @chars[index + 2] == "<" && !%w[= !].include?(@chars[index + 3])
              count += 1
              finish = find_close(index + 3)
              name = finish ? @chars[(index + 3)...finish].to_a.join : ""
              (@names[name] ||= []) << count
            end
            index += 1
          end
          count
        end

        #: (Hash[Symbol, bool]) -> String
        def disjunction(flags)
          before = @visible
          named = [] #: Array[String]
          alternatives = [] #: Array[String]
          loop do
            @visible = before.dup
            alternatives << alternative(flags)
            named |= @visible
            break unless taken?("|")
          end
          @visible = named
          alternatives.join("|")
        end

        #: (Hash[Symbol, bool]) -> String
        def alternative(flags)
          terms = +""
          terms << term(flags) until peek.nil? || peek == "|" || peek == ")"
          terms
        end

        #: (Hash[Symbol, bool]) -> String
        def term(flags)
          assertion = assertion(flags)
          if assertion
            fail!("Nothing to repeat") if quantifier_ahead?
            return assertion
          end

          atom, quantifiable = atom(flags)
          quantified = quantifier
          return atom unless quantified

          fail!(quantifiable == :lookbehind ? "Invalid quantifier" : "Nothing to repeat") unless quantifiable == true
          fail!("Nothing to repeat") if quantifier_ahead?
          "(?:#{atom})#{quantified}"
        end

        # `^`, `$`, `\b`, and `\B`, which no quantifier may follow.
        #: (Hash[Symbol, bool]) -> String?
        def assertion(flags)
          case peek
          when "^" then take && (flags[:m] ? "(?<![^#{LINE_ENDS}])" : "\\A")
          when "$" then take && (flags[:m] ? "(?![^#{LINE_ENDS}])" : "\\z")
          when "\\"
            case peek(1)
            when "b" then (@at += 2) && "(?:(?<=[#{WORD}])(?![#{WORD}])|(?<![#{WORD}])(?=[#{WORD}]))"
            when "B" then (@at += 2) && "(?:(?<=[#{WORD}])(?=[#{WORD}])|(?<![#{WORD}])(?![#{WORD}]))"
            end
          end
        end

        # An atom as Ruby source, and whether a quantifier may follow it:
        # true, false, or :lookbehind, whose refusal V8 words otherwise.
        #: (Hash[Symbol, bool]) -> [String, (bool | Symbol)]
        def atom(flags)
          char = peek
          case char
          when "(" then group(flags)
          when "[" then [character_class, true]
          when "."
            take
            [flags[:s] ? "(?m:.)" : "[^#{LINE_ENDS}]", true]
          when "\\" then [escape(flags), true]
          when "*", "+", "?" then fail!("Nothing to repeat")
          when "{"
            fail!("Nothing to repeat") if quantifier_ahead?
            take
            [literal("{"), true]
          else
            take
            [literal(char.to_s), true]
          end
        end

        #: (Hash[Symbol, bool]) -> [String, (bool | Symbol)]
        def group(flags)
          take
          if taken?("?=") || taken?("?!")
            kind = @chars[@at - 1] == "=" ? "(?=" : "(?!"
            return ["#{kind}#{closed(flags)})", true]
          end
          if taken?("?<=") || taken?("?<!")
            kind = @chars[@at - 1] == "=" ? "(?<=" : "(?<!"
            return ["#{kind}#{closed(flags)})", :lookbehind]
          end
          return ["(?:#{closed(flags)})", true] if taken?("?:")

          if taken?("?<")
            finish = find_close(@at)
            name = finish ? @chars[@at...finish].to_a.join : ""
            fail!("Invalid capture group name") unless finish && name.match?(GROUP_NAME)
            fail!("Duplicate capture group name") if @visible.include?(name)

            @visible += [name]
            @at = finish + 1
            @group += 1
            number = @group
            return ["(?<g#{number}>#{closed(flags)})", true]
          end
          return modified(flags) if peek == "?"

          @group += 1
          number = @group
          ["(?<g#{number}>#{closed(flags)})", true]
        end

        # `(?ims-ims:...)`: the flags it turns on and off, for its body.
        #: (Hash[Symbol, bool]) -> [String, bool]
        def modified(flags)
          take
          on = read_flags
          off = taken?("-") ? read_flags : nil
          fail!("Invalid group") unless peek == ":"
          fail!("Invalid flag group") if off && on.empty? && off.empty?
          fail!("Repeated flag in flag group") if off&.intersect?(on)
          take
          inner = flags.merge(on.to_h { [_1.to_sym, true] }).merge((off || []).to_h { [_1.to_sym, false] })
          body = closed(inner)
          case_change = inner[:i] == flags[:i] ? nil : inner[:i]
          [case_change.nil? ? "(?:#{body})" : "(?#{case_change ? "i" : "-i"}:#{body})", true]
        end

        #: () -> Array[String]
        def read_flags
          read = [] #: Array[String]
          while (char = peek) && "ims".include?(char)
            fail!("Repeated flag in flag group") if read.include?(char)
            read << char
            take
          end
          fail!("Invalid group") unless [":", "-"].include?(peek)
          read
        end

        # The body of a group through its `)`.
        #: (Hash[Symbol, bool]) -> String
        def closed(flags)
          body = disjunction(flags)
          fail!("Unterminated group") unless taken?(")")
          body
        end

        # A quantifier at this point, as Ruby source, or nil.
        #: () -> String?
        def quantifier
          base = case peek
                 when "*", "+", "?" then take
                 when "{"
                   braced = braced_quantifier
                   return nil unless braced

                   braced
                 end
          return nil unless base

          # Ruby reads `{n}?` as an optional `{n}`; a lazy exact count is
          # the count.
          lazy = taken?("?")
          return base if lazy && base.match?(/\A\{\d+\}/)

          lazy ? "#{base}?" : base
        end

        #: () -> bool
        def quantifier_ahead?
          %w[* + ?].include?(peek) || (peek == "{" && !@chars[@at..].to_a.join.match(/\A\{\d+(?:,\d*)?\}/).nil?)
        end

        # `{n}`, `{n,}`, or `{n,m}`, read and written for Ruby, or nil when
        # the brace starts none, which makes it a `{`.
        #: () -> String?
        def braced_quantifier
          found = @chars[@at..].to_a.join.match(/\A\{(\d+)(?:(,)(\d*))?\}/)
          return nil unless found

          @at += found[0].to_s.length
          low = found[1].to_i
          written = found[3].to_s
          high = written.empty? ? nil : written.to_i #: Integer?
          if high
            fail!("numbers out of order in {} quantifier") if high < low
            high = nil if high > REPEAT_LIMIT
          end
          return "{0}(?!)" if low > REPEAT_LIMIT
          return "{#{low}}" unless found[2]

          high ? "{#{low},#{high}}" : "{#{low},}"
        end

        # An escape outside a class, from its backslash.
        #: (Hash[Symbol, bool]) -> String
        def escape(flags)
          take
          char = take
          fail!("\\ at end of pattern") if char.nil?
          if (set = SETS[char])
            members, negated = set
            return "[#{"^" if negated}#{members}]"
          end
          return literal(CONTROL.fetch(char).chr(Encoding::UTF_8)) if CONTROL.key?(char)

          case char
          when "c"
            letter = peek
            return literal((take.to_s.ord % 32).chr(Encoding::UTF_8)) if letter&.match?(/\A[A-Za-z]\z/)

            @at -= 1
            literal("\\")
          when /\A[0-9]\z/ then decimal(char)
          when "x" then hex(2) || literal("x")
          when "u" then hex(4) || literal("u")
          when "k" then named_reference(flags)
          else literal(char)
          end
        end

        # `\0`, a backreference, a legacy octal escape, or `\8` and `\9`.
        #: (String) -> String
        def decimal(first)
          digits = first
          digits += take.to_s while peek&.match?(/\A[0-9]\z/)
          number = digits.to_i
          return backreference([number]) if number >= 1 && number <= @count

          @at -= digits.length - 1
          return literal(first) if %w[8 9].include?(first)

          literal(octal(first).chr(Encoding::UTF_8))
        end

        # A legacy octal escape from its first digit: at most three digits,
        # and at most 0o377.
        #: (String) -> Integer
        def octal(first)
          value = first.to_i
          limit = first <= "3" ? 2 : 1
          limit.times do
            break unless peek&.match?(/\A[0-7]\z/)

            value = (value * 8) + take.to_s.to_i
          end
          value
        end

        # `\xHH` or `\uHHHH` as the unit it names, or nil (and nothing
        # read) when the digits are not there.
        #: (Integer) -> String?
        def hex(length)
          digits = @chars[@at, length]&.join.to_s
          return nil unless digits.match?(/\A\h{#{length}}\z/)

          @at += length
          literal(JsPattern.unit(digits.hex))
        end

        #: (Hash[Symbol, bool]) -> String
        def named_reference(_flags)
          return literal("k") if @names.empty?

          fail!("Invalid named reference") unless taken?("<")
          finish = find_close(@at)
          name = finish ? @chars[@at...finish].to_a.join : ""
          fail!("Invalid capture group name") unless finish && name.match?(GROUP_NAME)
          @at = finish + 1
          numbers = @names[name] or fail!("Invalid named capture referenced")
          backreference(numbers)
        end

        # The first of `numbers` that matched, or nothing when none did. A
        # group that opens after the reference has never matched there,
        # since JavaScript clears a repeated group's captures each round, so
        # it is left out (Ruby refuses a name it has not seen yet).
        #: (Array[Integer]) -> String
        def backreference(numbers)
          numbers.select { _1 <= @group }.reverse.reduce("") { |rest, number| "(?(<g#{number}>)\\k<g#{number}>|#{rest})" }
        end

        #: () -> String
        def character_class
          take
          negated = taken?("^")
          parts = [] #: Array[String]
          loop do
            char = peek
            fail!("Unterminated character class") if char.nil?
            if char == "]"
              take
              break
            end

            low = class_atom
            if peek == "-" && peek(1) && peek(1) != "]"
              take
              high = class_atom
              if low.is_a?(Integer) && high.is_a?(Integer)
                fail!("Range out of order in character class") if high < low
                parts << range(low, high)
              else
                parts.push(class_part(low), class_part("-".ord), class_part(high))
              end
            else
              parts << class_part(low)
            end
          end
          written = parts.join
          return(negated ? "(?m:.)" : "(?!)") if written.empty?

          "[#{"^" if negated}#{written}]"
        end

        # One member of a class: a unit's code, or a set as Ruby source.
        #: () -> (Integer | String)
        def class_atom
          char = take.to_s
          return char.ord unless char == "\\"

          char = take
          fail!("\\ at end of pattern") if char.nil?
          if (set = SETS[char])
            members, negated = set
            return negated ? "[^#{members}]" : members
          end
          return CONTROL.fetch(char) if CONTROL.key?(char)

          case char
          when "b" then 0x08
          when "c"
            letter = peek
            return take.to_s.ord % 32 if letter&.match?(/\A[A-Za-z0-9_]\z/)

            @at -= 1
            "\\".ord
          when "0".."7" then octal(char)
          when "x", "u"
            length = char == "x" ? 2 : 4
            digits = @chars[@at, length]&.join.to_s
            return char.ord unless digits.match?(/\A\h{#{length}}\z/)

            @at += length
            JsPattern.unit(digits.hex).ord
          else char.ord
          end
        end

        #: (Integer | String) -> String
        def class_part(part) = part.is_a?(Integer) ? code(part) : part

        # A range of units, with the surrogates in it where `units` writes
        # them.
        #: (Integer, Integer) -> String
        def range(low, high)
          pieces = [] #: Array[[Integer, Integer]]
          pieces << [low, [high, 0xD7FF].min] if low < 0xD800
          surrogate_low = [low, 0xD800].max
          surrogate_high = [high, 0xDFFF].min
          pieces << [UNIT_BASE + surrogate_low - 0xD800, UNIT_BASE + surrogate_high - 0xD800] if surrogate_low <= surrogate_high
          pieces << [[low, 0xE000].max, high] if high > 0xDFFF
          pieces.map { |from, to| from == to ? code(from) : "#{code(from)}-#{code(to)}" }.join
        end

        #: (Integer) -> String
        def code(value) = format("\\u{%x}", value)

        #: (String) -> String
        def literal(char) = char.match?(/\A[A-Za-z0-9]\z/) ? char : code(char.ord)
      end
    end
  end
end
