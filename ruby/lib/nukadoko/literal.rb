# frozen_string_literal: true
# rbs_inline: enabled

# The literal rule, as the TypeScript engine reads it. A literal expected
# value is in neither the sentence's data nor an earlier step's result, so
# it would let step code carry the criterion again ("the command succeeds"
# claiming 0). It is allowed only when the sentence states it: its text is
# a run of the pattern's fixed words joined by one space, a whole number
# from zero to twelve a fixed word spells (or once and twice), or the fixed
# value of a word in WORDS. A word inside a capture, an optional group, or
# an alternation is not fixed, since the sentence a line binds may not say
# it. A value WORDS fixes is compared with equal alone, or with not-equal
# right after "not", "neither", or "nor".
module Nukadoko
  module Engine
    module Literal
      Statement = Data.define(:words, :by_table, :compare, :negated_by)

      WORDS = { "no" => [0, "", []], "none" => [0, "", []], "nothing" => [0, "", []], "neither" => [0, "", []],
                "never" => [0], "empty" => ["", []] }.freeze
      NUMBERS = %w[zero one two three four five six seven eight nine ten eleven twelve].freeze
      TIMES = { "once" => 1, "twice" => 2 }.freeze
      NEGATING = %w[not neither nor].freeze
      EDGE = /\A[.,;:!?"'`]+|[.,;:!?"'`]+\z/

      module_function

      # Every word of the pattern, with whether a matching sentence always holds it.
      #: (String) -> Array[[String, bool]]
      def words(pattern)
        list = []
        word = +""
        fixed = true
        finish = lambda do
          text = word.gsub(EDGE, "")
          list << [text, fixed] if !fixed || !text.empty?
          word = +""
          fixed = true
        end
        i = 0
        while i < pattern.length
          ch = pattern[i].to_s
          if ch == "\\" && i + 1 < pattern.length
            word << pattern[i + 1].to_s
            i += 2
          elsif ch.match?(/\s/)
            finish.()
            i += 1
          elsif ["{", "("].include?(ch)
            close = ch == "{" ? "}" : ")"
            fixed = false
            i += 1
            i += pattern[i] == "\\" ? 2 : 1 while i < pattern.length && pattern[i] != close
            i += 1
          else
            fixed = false if ch == "/"
            word << ch
            i += 1
          end
        end
        finish.()
        list
      end

      #: (untyped) -> String?
      def text(literal)
        case literal
        when String then literal
        when Integer then literal.to_s
        when Float then literal.finite? ? (literal == literal.floor ? literal.to_i.to_s : literal.to_s) : nil
        when true, false, nil then literal.nil? ? "null" : literal.to_s
        end
      end

      #: (String) -> Integer?
      def number_of(word)
        lower = word.downcase
        NUMBERS.index(lower) || TIMES[lower]
      end

      #: (untyped, untyped) -> bool
      def same?(a, b) = a.is_a?(Array) && b.is_a?(Array) ? a.empty? && b.empty? : a.instance_of?(b.class) && a == b

      #: (String, untyped) -> Statement?
      def statement(pattern, literal)
        all = words(pattern)
        fixed = all.select(&:last).map(&:first)
        said = text(literal)
        return Statement.new(said, false, nil, nil) if said && !said.empty? && run_of?(fixed, said)

        spelled = literal.is_a?(Integer) && fixed.find { number_of(_1) == literal }
        return Statement.new(spelled, false, nil, nil) if spelled

        all.each_with_index do |(word, is_fixed), index|
          next unless is_fixed
          next unless WORDS.fetch(word.downcase, []).any? { same?(literal, _1) }
          next if word.downcase == "neither" && all.drop(index + 1).any? { |w, f| f && w.downcase == "nor" }

          before = (index.positive? ? all[index - 1] : nil) #: [String, bool]?
          return Statement.new(word, true, "not-equal", before[0]) if before && before[1] && NEGATING.include?(before[0].downcase)

          return Statement.new(word, true, "equal", nil)
        end
        nil
      end

      #: (Array[String], String) -> bool
      def run_of?(words, text)
        (0...words.size).any? { |start| (start + 1..words.size).any? { words[start...(_1)].to_a.join(" ") == text } }
      end

      # How every pattern states `literal`, or nil when one does not: a line
      # may bind any of them, and the first pattern's words name it.
      #: (Array[String], untyped) -> Statement?
      def statement_of_all(patterns, literal)
        return nil if patterns.empty?

        stated = patterns.filter_map { statement(_1, literal) }
        first = stated.first
        return nil unless first && stated.size == patterns.size

        Statement.new(first.words, stated.any? { _1.by_table }, first.compare, first.negated_by)
      end

      #: (Array[String], untyped) -> untyped
      def stated_by_all(patterns, literal) = statement_of_all(patterns, literal)&.words
    end
  end
end
