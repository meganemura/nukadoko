# frozen_string_literal: true
# rbs_inline: enabled

# `fits-text`, as the TypeScript engine judges it: an expected text fits an
# actual one line by line, where a line that is exactly `...` takes any run
# of actual lines, `[..]` any characters inside one line, and `[..:name]`
# does too, and then every stand-in of one name must have read one text and
# two names two texts. The judge and the claim line both read this module,
# so the two never disagree about where a text stopped fitting. It walks
# the expected lines once and keeps only the actual lines each one can end
# before, so a text costs time in its length rather than a power of its
# `...` lines.
module Nukadoko
  module Engine
    module TextFit
      ANY_LINES = "..."
      STAND_IN_NAME = /\A[A-Za-z0-9_-]+\z/

      # An expected line split at its stand-ins: the fixed texts, and the
      # place of each named stand-in among them.
      Fixed = Data.define(:parts, :names)

      module_function

      # A `[..` that `]`, or `:`, a name, and `]`, do not follow is text.
      def fixed_line(line)
        parts = []
        names = {}
        from = 0
        open = line.index("[..")
        while open
          close = line.index("]", open + 3)
          name = if close == open + 3 then nil
                 elsif line[open + 3] == ":" && close && line[(open + 4)...close].match?(STAND_IN_NAME) then line[(open + 4)...close]
                 else :text
                 end
          if name == :text
            open = line.index("[..", open + 1)
            next
          end
          names[parts.size] = name if name
          parts << line[from...open]
          from = close + 1
          open = line.index("[..", from)
        end
        parts << line[from..]
        Fixed.new(parts: parts, names: names)
      end

      # A text's lines, at "\n" or "\r\n", with one final empty line dropped.
      def lines(text)
        split = text.split(/\r?\n/, -1)
        split.pop if split.last == ""
        split
      end

      # Each part between the first and the last is found leftmost after
      # the one before it, which is enough when a stand-in takes anything.
      def parts_fit(parts, line, reads = nil)
        return parts[0] == line if parts.size == 1

        first = parts[0]
        last = parts[-1]
        return false if line.size < first.size + last.size || !line.start_with?(first) || !line.end_with?(last)

        at = first.size
        stop = line.size - last.size
        parts[1...-1].each do |part|
          found = line.index(part, at)
          return false if found.nil? || found + part.size > stop

          reads&.push(line[at...found])
          at = found + part.size
        end
        reads&.push(line[at...stop])
        true
      end

      def line_fits(pattern, line) = parts_fit(fixed_line(pattern).parts, line)

      # { fits: true }, or where the text stopped fitting: `fitted` expected
      # lines fit, `expected` fit nothing from actual line `at` on, which is
      # `actual`; or `readings`, the two named stand-ins that disagree.
      def fit(actual, expected)
        have = lines(actual)
        want_lines = lines(expected)
        want = want_lines.map { _1 == ANY_LINES ? nil : fixed_line(_1) }
        reach = { at: [0] } #: Hash[Symbol, untyped]
        want.each_with_index do |line, index|
          earliest = reach[:from] || reach[:at][0] #: Integer
          if line.nil?
            reach = { from: earliest }
            next
          end
          starts = reach[:from] ? (reach[:from]...have.size).to_a : reach[:at]
          after = starts.select { _1 < have.size && parts_fit(line.parts, have[_1]) }.map { _1 + 1 }
          if after.empty?
            return { fits: false, fitted: index, expected: want_lines[index], at: earliest + 1, **(have[earliest].nil? ? {} : { actual: have[earliest] }) }
          end

          reach = { at: after }
        end
        if reach[:at] && reach[:at][-1] != have.size
          left = reach[:at][-1]
          return { fits: false, fitted: want.size, at: left + 1, actual: have[left] }
        end
        return { fits: true } unless want.any? { _1 && _1.names.any? }

        names_fit(have, want, first_fit(have, want))
      end

      # The actual line each expected line takes in the first way the text
      # fits, each `...` taking as few lines as it can from the top: a walk
      # from the end learns which lines the rest can start at.
      def first_fit(have, want)
        rests = []
        rest = { at: [have.size] }
        (want.size - 1).downto(0) do |index|
          line = want[index]
          if line.nil?
            rest = { up_to: rest[:up_to] || rest[:at][-1] }
          else
            candidates = rest[:up_to] ? (0...rest[:up_to]).to_a : rest[:at].select(&:positive?).map { _1 - 1 }
            rest = { at: candidates.select { _1 < have.size && parts_fit(line.parts, have[_1]) } }
          end
          rests[index] = rest
        end
        taken = []
        at = 0
        open = false
        want.each_with_index do |line, index|
          if line.nil?
            open = true
            taken << nil
            next
          end
          at = rests[index][:at].find { _1 >= at } if open
          taken << at
          at += 1
          open = false
        end
        taken
      end

      def names_fit(have, want, taken)
        by_name = {}
        by_text = {}
        want.each_with_index do |line, index|
          next if line.nil? || line.names.empty?

          at = taken[index]
          reads = []
          parts_fit(line.parts, have[at], reads)
          line.names.each do |place, name|
            reading = { name: name, text: reads[place], at: at + 1, line: have[at] }
            before = by_name[name] || by_text[reading[:text]]
            if before.nil?
              by_name[name] = reading
              by_text[reading[:text]] = reading
            elsif before[:name] != name || before[:text] != reading[:text]
              return { fits: false, readings: [before, reading] }
            end
          end
        end
        { fits: true }
      end

      # Whether an expected text states nothing beyond its stand-ins.
      def only_stand_ins?(expected)
        lines(expected).all? { _1 == ANY_LINES || fixed_line(_1).parts.join.strip.empty? }
      end
    end
  end
end
