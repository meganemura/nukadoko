# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require_relative "aria_tree"

# What an ARIA snapshot says, and whether an expected one fits an actual
# one (`fits-aria-snapshot`), in the TypeScript engine's words. An ARIA
# snapshot is the YAML text a browser library prints for a page's
# accessibility tree: a list of nodes, each a role with an optional name
# and states, its text, and its children. This module reads two such
# texts, the one nukadoko took (the actual side) and the docstring a line
# states (the expected side), and judges whether every node the expected
# side names is in the actual tree, at the place it names it, leaving the
# rest of the tree unasked. For a broken claim it names the first expected
# node that fits nothing and the actual node nearest to it.
#
# It is pure: it never touches a page. The claim judges the text the
# runner took, so the record shows the one value that was judged, and a
# reader can judge the record again from its two texts alone. That is why
# the matching reads the printed text and not the browser's own tree: a
# state the print leaves out (an unchecked box prints no `[checked]`) is
# absent here too, so `[checked=false]` holds on any node that prints no
# checked state.
#
# The reader takes the part of YAML an ARIA snapshot uses: a block list of
# items, each a key alone or one key with a text or a list of children,
# plain, single-quoted, or double-quoted scalars, and comments. Anything
# else is refused with its line, and the refusal says how to write what
# the line meant. On the expected side a pattern between slashes, the
# state `[active]`, and a `/` property at the top of a list that names one
# node are refused too, since nukadoko would otherwise accept a line it
# does not judge.
module Nukadoko
  module Engine
    module AriaSnapshot
      FRAGMENT = "fragment"
      # JavaScript's \s, which the TypeScript engine's texts are cut by.
      SPACE = "\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
      WS = /[#{SPACE}]/
      # YAML's indicators: a plain scalar may not start with one, since
      # YAML reads it as structure.
      PLAIN_START_REFUSED = [",", "[", "]", "{", "}", "&", "*", "!", "|", ">", "%", "@", "`"].freeze
      DOUBLE_QUOTED_ESCAPES = {
        "0" => "\0", "a" => "\a", "b" => "\b", "t" => "\t", "\t" => "\t", "n" => "\n", "v" => "\v", "f" => "\f", "r" => "\r",
        "e" => "\e", " " => " ", '"' => '"', "/" => "/", "\\" => "\\", "N" => "\u0085", "_" => " ", "L" => " ", "P" => " "
      }.freeze
      HEX_ESCAPE_LENGTH = { "x" => 2, "u" => 4, "U" => 8 }.freeze
      # What YAML's core schema reads a plain scalar as when it is not a
      # string: a writer who means the text "3.50" and writes it plain gets
      # the number 3.5, so such a value is refused, not read as other text.
      YAML_NULL = /\A(?:~|null|Null|NULL)\z/
      YAML_BOOLEAN = /\A(?:true|True|TRUE|false|False|FALSE)\z/
      YAML_NUMBER = /\A(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\z/
      STATE_NAMES = %w[checked disabled expanded invalid level pressed selected].freeze
      PRINTED_STATE = /\A(checked|disabled|expanded|invalid|level|pressed|selected)(?:=(mixed|grammar|spelling|[0-9]+))?\z/
      SOURCE_LIMIT = 120
      # The most actual lines an excerpt shows.
      EXCERPT_LINES = 12

      module_function

      # --- the YAML layer ---

      #: (Integer, String) -> Problem
      def problem_at(line, message) = Problem.new("line #{line} #{message}")

      #: (String) -> String
      def trim(text) = text.sub(/\A#{WS}+/, "").sub(/#{WS}+\z/, "")

      #: (String) -> String
      def trim_end(text) = text.sub(/#{WS}+\z/, "")

      #: (String?) -> bool
      def space?(char) = !char.nil? && char.match?(/\A#{WS}\z/)

      #: (String) -> Array[Line]
      def content_lines(text)
        text.split(/\r?\n/, -1).each_with_index.filter_map do |raw, index|
          number = index + 1
          lead = raw[/\A[ \t]*/].to_s
          content = raw[lead.size..].to_s
          next if content.empty? || content.start_with?("#")
          raise problem_at(number, "is indented with a tab, and YAML indents with spaces only") if lead.include?("\t")
          raise problem_at(number, "is a YAML document marker, and an ARIA snapshot is one list") if lead.empty? && content.match?(/\A(---|\.\.\.)(#{WS}|\z)/)

          Line.new(number: number, indent: lead.size, content: content)
        end
      end

      # A quoted scalar at `start` of `text`: its value and the index after
      # its closing quote.
      #: (String, Integer, Integer) -> [String, Integer]
      def read_quoted(text, start, line)
        quote = text[start]
        value = +""
        index = start + 1
        while index < text.size
          char = text[index].to_s
          if quote == "'"
            if char == "'"
              if text[index + 1] == "'"
                value << "'"
                index += 2
                next
              end
              return [value, index + 1]
            end
            value << char
            index += 1
            next
          end
          return [value, index + 1] if char == '"'

          unless char == "\\"
            value << char
            index += 1
            next
          end
          escape = text[index + 1]
          break if escape.nil?

          if (hex_length = HEX_ESCAPE_LENGTH[escape])
            hex = text[index + 2, hex_length].to_s
            raise problem_at(line, "has \\#{escape} in a double-quoted text without #{hex_length} hexadecimal digits after it") unless hex.match?(/\A[0-9a-fA-F]{#{hex_length}}\z/)

            value << code_point(hex.to_i(16))
            index += 2 + hex_length
            next
          end
          replacement = DOUBLE_QUOTED_ESCAPES[escape]
          raise problem_at(line, "has the escape \\#{escape}, which a double-quoted YAML text does not have") if replacement.nil?

          value << replacement
          index += 2
        end
        raise problem_at(line, "opens a #{quote == '"' ? "double" : "single"}-quoted text that does not close on the line")
      end

      # A code point as text; a lone surrogate, which a Ruby string cannot
      # hold, is the replacement character.
      #: (Integer) -> String
      def code_point(number)
        number.chr(Encoding::UTF_8)
      rescue RangeError
        "�"
      end

      # Where a plain scalar that starts at `start` ends: before a `:` that
      # a space or the end follows, when `key` is true, or before a ` #`
      # comment either way.
      #: (String, Integer, bool) -> Integer
      def plain_end(text, start, key)
        (start...text.size).each do |index|
          char = text[index]
          return index if char == "#" && index > start && space?(text[index - 1])
          return index if key && char == ":" && (index + 1 == text.size || space?(text[index + 1]))
        end
        text.size
      end

      #: (String, Integer, bool, Integer) -> [Scalar, Integer]
      def read_scalar(text, start, key, line)
        first = text[start].to_s
        if first == '"' || first == "'"
          value, ending = read_quoted(text, start, line)
          return [Scalar.new(text: value, plain: false), ending]
        end
        if PLAIN_START_REFUSED.include?(first)
          raise problem_at(line, if first == "|" || first == ">"
                                   "starts a YAML block text with #{first}, which an ARIA snapshot does not use: write the text on the line, in double quotes with \\n for a new line"
                                 else
                                   "starts a text with #{first}, which YAML reads as structure, not text: put the text in quotes"
                                 end)
        end
        if %w[- ? :].include?(first) && (start + 1 == text.size || space?(text[start + 1]))
          raise problem_at(line, first == "-" ? "holds a list inside a list item, and each item is one node" : "starts with #{first} and a space, which YAML reads as structure, not text: put the text in quotes")
        end
        value = trim_end(text[start...plain_end(text, start, key)].to_s)
        raise problem_at(line, 'holds a text with ": " in it, which YAML reads as a second key: put the text in quotes') if !key && value.match?(/:#{WS}/)

        [Scalar.new(text: value, plain: true), start + value.size]
      end

      #: (String, Integer) -> Integer
      def skip_spaces(text, index)
        index += 1 while index < text.size && [" ", "\t"].include?(text[index])
        index
      end

      # The rest of a line after a scalar may hold only spaces and a comment.
      #: (String, Integer) -> bool
      def ends_here?(text, index)
        at = skip_spaces(text, index)
        at == text.size || (text[at] == "#" && at > index)
      end

      # One item's content after `- `: its key, whether a colon follows
      # it, its text when one does, and the item as written.
      #: (String, Integer) -> [Scalar, bool, Scalar?, String]
      def read_entry(content, line)
        key, index = read_scalar(content, 0, true, line)
        after = skip_spaces(content, index)
        unless content[after] == ":"
          raise problem_at(line, "has text after #{JSON.generate(key.text)} that YAML does not read: put the whole key in quotes") unless ends_here?(content, index)

          return [key, false, nil, trim(content[0...index].to_s)]
        end
        index = after + 1
        if index < content.size && !space?(content[index])
          raise problem_at(line, "has a colon with no space after it, which YAML reads as part of the key: put a space after the colon, or the key in quotes")
        end
        value_start = skip_spaces(content, index)
        return [key, true, nil, trim(content[0...after].to_s)] if value_start == content.size || content[value_start] == "#"

        value, ending = read_scalar(content, value_start, false, line)
        raise problem_at(line, "has text after its value that YAML does not read: put the value in quotes") unless ends_here?(content, ending)

        [key, true, value, trim(content[0...ending].to_s)]
      end

      #: (Array[Line], Integer, Integer) -> [Array[Item], Integer]
      def read_list(lines, start, indent)
        items = [] #: Array[Item]
        index = start
        while index < lines.size
          line = lines.fetch(index)
          break if line.indent < indent
          raise problem_at(line.number, "is indented more than the item above it, which has no colon to open children") if line.indent > indent
          unless line.content == "-" || line.content.start_with?("- ")
            raise problem_at(line.number, 'is no list item: an ARIA snapshot is a YAML list, and each item starts with "- "')
          end

          offset = skip_spaces(line.content, 1)
          raise problem_at(line.number, "is a list item with nothing in it") if offset == line.content.size || line.content[offset] == "#"

          key, colon, value, source = read_entry(line.content[offset..].to_s, line.number)
          index += 1
          key_column = line.indent + offset
          deeper = index < lines.size && lines.fetch(index).indent > line.indent ? lines.fetch(index) : nil
          if colon && value.nil?
            if deeper.nil?
              raise problem_at(line.number, "ends #{JSON.generate(key.text)} with a colon and has nothing after it: write its text after the colon, its children on the lines below, or drop the colon")
            end
            raise problem_at(deeper.number, "is indented less than the key of the item it belongs to") if deeper.indent < key_column

            children, index = read_list(lines, index, deeper.indent)
            items << Item.new(line: line.number, source: source, key: key, value: nil, children: children)
            next
          end
          if deeper
            raise problem_at(deeper.number, if deeper.indent == key_column && !deeper.content.start_with?("-")
                                              'is a second key of one list item, and each item names one node: start it with "- " as an item of its own'
                                            else
                                              "is indented under an item that has no colon to open children"
                                            end)
          end
          items << Item.new(line: line.number, source: source, key: key, value: value, children: nil)
        end
        [items, index]
      end

      #: (String) -> Array[Item]
      def read_items(text)
        lines = content_lines(text)
        return [] if lines.empty?

        items, ending = read_list(lines, 0, lines.fetch(0).indent)
        raise problem_at(lines.fetch(ending).number, "is indented less than the first item of the list") if ending < lines.size

        items
      end

      # The text a plain scalar on the expected side states, or why YAML
      # reads it as something else. A number or a boolean whose own text
      # YAML gives back unchanged (`42`, `true`) states that text.
      #: (Scalar, Integer, String) -> String
      def stated_text(scalar, line, what)
        return scalar.text unless scalar.plain

        text = scalar.text
        raise problem_at(line, "has #{what} #{text}, which YAML reads as null: put the text in quotes") if text.match?(YAML_NULL)

        read = if text.match?(YAML_BOOLEAN) then (text.downcase == "true").to_s
               elsif text.match?(YAML_NUMBER) then yaml_number_text(text)
               else text
               end
        raise problem_at(line, "has #{what} #{text}, which YAML reads as #{read}: put the text in quotes, \"#{text}\", to state it as written") if read != text

        text
      end

      # The text of the number YAML reads a plain scalar as, spelled as
      # JavaScript spells a number, since the TypeScript engine's messages
      # name it so.
      #: (String) -> String
      def yaml_number_text(text)
        return "NaN" if text.match?(/\.nan\z/i)
        return text.start_with?("-") ? "-Infinity" : "Infinity" if text.match?(/\.inf\z/i)
        return text[2..].to_s.to_i(8).to_s if text.start_with?("0o")
        return text[2..].to_s.to_i(16).to_s if text.start_with?("0x")

        js_number(text.to_f)
      end

      # A float as JavaScript's Number#toString writes it: its shortest
      # digits, as a plain number from 1e-7 to 1e21, and with an exponent
      # outside that.
      #: (Float) -> String
      def js_number(number)
        return "0" if number.zero?

        shown = number.abs.to_s
        mantissa, exponent = shown.include?("e") ? shown.split("e") : [shown, nil]
        whole, fraction = mantissa.to_s.split(".")
        whole = whole.to_s
        fraction = fraction.to_s
        if exponent
          digits = whole + fraction
          point = whole.size + exponent.to_i
        elsif whole == "0"
          digits = fraction.sub(/\A0+/, "")
          point = digits.size - fraction.size
        else
          digits = whole + fraction
          point = whole.size
        end
        digits = digits.sub(/0+\z/, "")
        k = digits.size
        text = if k <= point && point <= 21 then digits + ("0" * (point - k))
               elsif point.positive? && point <= 21 then "#{digits[0, point]}.#{digits[point..]}"
               elsif point > -6 && point <= 0 then "0.#{"0" * -point}#{digits}"
               else
                 e = point - 1
                 "#{digits[0]}#{k > 1 ? ".#{digits[1..]}" : ""}e#{e.negative? ? "-" : "+"}#{e.abs}"
               end
        (number.negative? ? "-" : "") + text
      end

      # --- the tree ---

      # White space folded the way the snapshot folds a page's text.
      #: (String) -> String
      def folded(text) = trim(text.gsub(/[​­]/, "").gsub(/#{WS}+/, " "))

      #: (String) -> ExpectedText
      def expected_text(raw) = ExpectedText.new(raw: raw, normalized: folded(raw))

      # A key's role, name, and states, read the way a docstring writes
      # them: a role, then a name in double quotes, then states in brackets.
      #: (String, Integer) -> [String, String, Hash[String, untyped]]
      def expected_key(key, line)
        index = skip_spaces(key, 0)
        role_start = index
        index += 1 while index < key.size && key[index].to_s.match?(/\A[a-zA-Z]\z/)
        role = key[role_start...index].to_s
        raise problem_at(line, "names no role in #{JSON.generate(key)}: an item starts with a role, such as heading or button") if role.empty?

        index = skip_spaces(key, index)
        name = ""
        if key[index] == '"'
          value = +""
          index += 1
          closed = false
          while index < key.size
            char = key[index].to_s
            index += 1
            if char == "\\" && index < key.size
              value << key[index].to_s
              index += 1
            elsif char == '"'
              closed = true
              break
            else
              value << char
            end
          end
          unless closed
            raise problem_at(line, "opens the name of #{role} with a quote that does not close. A \": \" inside a name ends a key in YAML, so put such a key in single quotes")
          end

          name = folded(value)
        elsif key[index] == "/"
          raise problem_at(line, "names #{role} with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim")
        end
        states = {} #: Hash[String, untyped]
        loop do
          index = skip_spaces(key, index)
          break unless key[index] == "["

          close = key.index("]", index)
          raise problem_at(line, "opens a state of #{role} with [ and does not close it") if close.nil?

          body = trim(key[(index + 1)...close].to_s)
          match = body.match(/\A([a-zA-Z]+)[#{SPACE}]*(?:=[#{SPACE}]*([^#{SPACE}]*))?\z/)
          raise problem_at(line, "has the state [#{body}], which is no state a snapshot prints") if match.nil?

          apply_state(states, match[1].to_s, match[2].nil? || match[2].to_s.empty? ? "true" : match[2].to_s, line)
          index = close + 1
        end
        if index < key.size
          raise problem_at(line, "has text after the role#{name.empty? ? "" : " and the name"} of #{role} that the key does not read: #{JSON.generate(key[index..].to_s)}. A name goes in double quotes")
        end

        [role, name, states]
      end

      #: (Hash[String, untyped], String, String, Integer) -> void
      def apply_state(states, state, value, line)
        flag = lambda do |allowed, what|
          raise problem_at(line, "gives [#{state}] the value #{value}, and #{state} is #{what}") unless allowed.include?(value)

          { "true" => true, "false" => false }.fetch(value, value)
        end
        case state
        when "checked", "pressed" then states[state] = flag.(%w[true false mixed], "true, false, or mixed")
        when "disabled", "expanded", "selected" then states[state] = flag.(%w[true false], "true or false")
        when "invalid" then states[state] = flag.(%w[true false grammar spelling], "true, false, grammar, or spelling")
        when "level"
          raise problem_at(line, "gives [level] the value #{value}, and a level is a whole number") unless value.match?(/\A[0-9]+\z/)

          states[state] = value.to_i
        when "active" then raise problem_at(line, "states [active], which the snapshot nukadoko takes does not print, so nothing could judge it")
        else raise problem_at(line, "has the state [#{state}], which is none of #{STATE_NAMES.join(", ")}")
        end
      end

      # The children a list of items names, into `container`, with the
      # first property item at the top kept in `first_prop`.
      #: (Array[Item], Node, ?Hash[Symbol, Item]) -> void
      def expected_children(items, container, first_prop = {})
        items.each do |item|
          if item.key.plain && [YAML_NULL, YAML_BOOLEAN, YAML_NUMBER].any? { item.key.text.match?(_1) }
            raise problem_at(item.line, "has the key #{item.key.text}, which YAML reads as no text: an item starts with a role, such as heading or button")
          end

          key = item.key.text
          if item.value.nil? && item.children.nil?
            role, name, states = expected_key(key, item.line)
            container.children << role_node(item, role, name, states, [])
            next
          end
          if key == "text" || key.start_with?("/")
            value_scalar = item.value
            raise problem_at(item.line, "gives #{key} children, and it takes a text after the colon") if value_scalar.nil?

            value = stated_text(value_scalar, item.line, "the #{key == "text" ? "text" : "value"}")
            if key == "text"
              container.children << Node.new(kind: :text, text: expected_text(value), line: item.line, source: item.source)
            elsif key == "/children"
              raise problem_at(item.line, "gives /children the value #{value}, and it is contain, equal, or deep-equal") unless %w[contain equal deep-equal].include?(value)

              container.children_mode = value
            else
              raise problem_at(item.line, "names a property with no name after the /") if key.size == 1

              container.props[key[1..].to_s] = expected_text(value)
              first_prop[:item] ||= item
            end
            next
          end
          role, name, states = expected_key(key, item.line)
          if (value_scalar = item.value)
            text = stated_text(value_scalar, item.line, "the text")
            container.children << role_node(item, role, name, states, [Node.new(kind: :text, text: expected_text(text), line: item.line, source: item.source)])
            next
          end
          node = role_node(item, role, name, states, [])
          expected_children(item.children || [], node)
          container.children << node
        end
      end

      #: (Item, String, String, Hash[String, untyped], Array[Node]) -> Node
      def role_node(item, role, name, states, children) = Node.new(kind: :role, role: role, name: name, states: states, props: {}, children: children, line: item.line, source: item.source)

      # The tree a docstring states: [root, named], where root is the node
      # the matching searches for (a fragment when it names several at the
      # top, or states a children mode there) and named how many nodes it
      # names; or a String saying why it reads as no snapshot.
      #: (String) -> ([Node, Integer] | String)
      def read_expected(text)
        top = Node.new(kind: :role, role: FRAGMENT, line: 0, source: "the list")
        first_prop = {} #: Hash[Symbol, Item]
        expected_children(read_items(text), top, first_prop)
        # One node at the top is searched for alone, anywhere in the tree;
        # several are searched for together, as children of one node, which
        # a property at the top describes.
        single = top.children.size == 1 && [nil, "contain"].include?(top.children_mode)
        prop = first_prop[:item]
        if single && prop
          raise problem_at(prop.line, "states #{prop.key.text} at the top of a list that names one node, so it describes no node: put it under the node it describes")
        end

        fragment = Node.new(kind: :role, role: FRAGMENT, props: top.props, children: top.children, children_mode: top.children_mode,
                            line: prop&.line || 0, source: prop&.source || "the list")
        [single ? top.children.fetch(0) : fragment, count_named(top.children) + stated_props(top.props)]
      rescue Problem => e
        e.message
      end

      # The properties a node states that a page could lack: each one
      # whose text is not empty, since an empty text fits any text.
      #: (Hash[String, untyped]) -> Integer
      def stated_props(props) = props.values.count { !_1.normalized.empty? }

      # The nodes a list names that a page could lack: every role, and
      # every text that is not empty.
      #: (Array[Node]) -> Integer
      def count_named(nodes) = nodes.sum { _1.text? ? (_1.text.normalized.empty? ? 0 : 1) : 1 + count_named(_1.children) }

      # A key as the snapshot prints it: a role, then a name as a JSON
      # string, or as it is when it starts and ends with a slash, then its
      # states.
      #: (String, Integer) -> [String, String, Hash[String, untyped]]
      def actual_key(key, line)
        role = key[/\A[a-zA-Z]+/]
        raise problem_at(line, "prints no role in #{JSON.generate(key)}") if role.nil?

        rest = key[role.size..].to_s
        states = {} #: Hash[String, untyped]
        # The printer writes the states last, from a fixed set, so they are
        # read from the end: a name may hold brackets of its own.
        loop do
          state = rest.match(/ \[([^\]#{SPACE}]+)\]\z/)
          break if state.nil?

          parsed = state[1].to_s.match(PRINTED_STATE)
          break if parsed.nil?

          states[parsed[1].to_s] = parsed[1] == "level" ? parsed[2].to_s.to_i : parsed[2] || true
          rest = rest[0...state.begin(0)].to_s
        end
        return [role, "", states] if rest.empty?
        raise problem_at(line, "prints #{JSON.generate(key)}, which is no role, name, and states") unless rest.start_with?(" ")

        written = rest[1..].to_s
        if written.start_with?('"')
          name = begin
            JSON.parse(written)
          rescue JSON::ParserError
            nil
          end
          return [role, name, states] if name.is_a?(String)

          raise problem_at(line, "prints the name #{written}, which is no JSON string")
        end
        return [role, written, states] if written.size > 1 && written.start_with?("/") && written.end_with?("/")

        raise problem_at(line, "prints #{JSON.generate(key)}, which is no role, name, and states")
      end

      #: (Array[Item], Node) -> void
      def actual_children(items, container)
        items.each do |item|
          key = item.key.text
          if item.value.nil? && item.children.nil?
            role, name, states = actual_key(key, item.line)
            container.children << Node.new(kind: :role, role: role, name: name, states: states, line: item.line, source: item.source)
            next
          end
          if key == "text" || key.start_with?("/")
            value = item.value
            raise problem_at(item.line, "prints #{key} with children") if value.nil?

            if key == "text" then container.children << Node.new(kind: :text, text: value.text, line: item.line, source: item.source)
            else container.props[key[1..].to_s] = value.text
            end
            next
          end
          role, name, states = actual_key(key, item.line)
          node = Node.new(kind: :role, role: role, name: name, states: states, line: item.line, source: item.source)
          if (value = item.value) then node.children << Node.new(kind: :text, text: value.text, line: item.line, source: item.source)
          else actual_children(item.children || [], node)
          end
          container.children << node
        end
      end

      # The tree a printed snapshot shows, under a node of role `fragment`
      # that holds its list, or a String saying why it does not read. A
      # plain scalar is the text it spells: the printer quotes every text
      # YAML would read otherwise.
      #: (String) -> (Node | String)
      def read_actual(text)
        root = Node.new(kind: :role, role: FRAGMENT, line: 0, source: "the snapshot")
        actual_children(read_items(text), root)
        root
      rescue Problem => e
        e.message
      end

      # --- fitting ---

      #: (String?, ExpectedText) -> bool
      def text_fits?(actual, expected)
        return true if expected.normalized.empty?
        return false if actual.nil? || actual.empty?

        actual == expected.normalized || actual == expected.raw
      end

      #: (String, Hash[String, untyped], Hash[String, untyped]) -> bool
      def state_fits?(state, actual, expected)
        stated = expected[state]
        return true if stated.nil?

        printed = actual[state]
        return printed.nil? if stated == false

        printed == stated
      end

      # Whether `actual` is the node `expected` names, by its own line
      # alone: its role, name, states, and properties, and for a text, its
      # text.
      #: (Node, Node) -> bool
      def node_fits?(actual, expected)
        return actual.text? && text_fits?(actual.text, expected.text) if expected.text?
        return false if actual.text?
        return false if expected.role != FRAGMENT && expected.role != actual.role
        return false unless STATE_NAMES.all? { state_fits?(_1, actual.states, expected.states) }
        return false if !expected.name.empty? && actual.name != expected.name

        expected.props.all? { |prop, text| text_fits?(actual.props[prop], text) }
      end

      # How `expected`'s children are read, as [contain, deep]: its own mode
      # wins, and under a `deep-equal` above it, every list is read whole.
      #: (Node, bool) -> [bool, bool]
      def children_reading(expected, deep)
        case expected.children_mode
        when "contain" then [true, false]
        when "equal" then [false, false]
        when "deep-equal" then [false, true]
        else deep ? [false, true] : [true, false]
        end
      end

      #: (Node, Node, bool) -> bool
      def tree_fits?(actual, expected, deep)
        return false unless node_fits?(actual, expected)
        return true if expected.text?

        children = actual.children
        contain, deeper = children_reading(expected, deep)
        unless contain
          return children.size == expected.children.size && expected.children.each_with_index.all? { |child, index| tree_fits?(children.fetch(index), child, deeper) }
        end

        # In order, each expected child at the first actual child after the
        # one before it that fits: taking the first never leaves a later
        # expected child fewer places to fit.
        following = 0
        expected.children.each do |child|
          following += 1 while following < children.size && !tree_fits?(children.fetch(following), child, false)
          return false if following == children.size

          following += 1
        end
        true
      end

      #: (Node) -> Array[Node]
      def every_node(node) = [node, *(node.text? ? [] : node.children.flat_map { every_node(_1) })]

      #: (Node) -> Array[Node]
      def below(node) = node.children.flat_map { every_node(_1) }

      # Whether the tree an expected snapshot names is in the actual tree:
      # its top node fits some actual node at any depth, each of its
      # children fits a child of that node, in order, with other children
      # between them unasked, and so on down, unless a `/children` mode
      # asks for every child.
      #: (Node, Node) -> bool
      def snapshot_fits?(actual, expected) = every_node(actual).any? { tree_fits?(_1, expected, false) }

      # --- explaining a misfit ---

      # The text an expected line states after its key (`- listitem: one`),
      # which the line reads as part of the node it names.
      #: (Node) -> ExpectedText?
      def inline_text(expected)
        return nil if expected.text? || expected.children.size != 1

        only = expected.children.fetch(0)
        only.text? && only.line == expected.line ? only.text : nil
      end

      # Whether `actual` is the node an expected line names, its inline
      # text included.
      #: (Node, Node) -> bool
      def line_fits?(actual, expected)
        return false unless node_fits?(actual, expected)

        text = inline_text(expected)
        text.nil? || actual.children.any? { _1.text? && text_fits?(_1.text, text) }
      end

      # The edit distance between two texts, each cut to its first 200
      # characters, so a long name costs no more than a short one.
      #: (String, String) -> Integer
      def edit_distance(a, b)
        left = a[0, 200].to_s
        right = b[0, 200].to_s
        previous = (0..right.size).to_a
        (1..left.size).each do |i|
          current = [i]
          (1..right.size).each do |j|
            current[j] = [previous.fetch(j) + 1, current.fetch(j - 1) + 1, previous.fetch(j - 1) + (left[i - 1] == right[j - 1] ? 0 : 1)].min
          end
          previous = current
        end
        previous.fetch(right.size)
      end

      # Of `candidates`, the one most like `expected`: a node of its role,
      # or a text for a text, whose name or text is nearest to the one it
      # states, the earliest of equals; nil when none is of its role.
      #: (Node, Array[Node]) -> Node?
      def most_alike(expected, candidates)
        best = nil #: Node?
        distance = Float::INFINITY #: Float | Integer
        candidates.each do |candidate|
          if expected.text?
            next unless candidate.text?

            d = edit_distance(candidate.text, expected.text.normalized) #: Float | Integer
          elsif expected.role == FRAGMENT
            next if candidate.text?
            next unless expected.props.keys.any? { candidate.props.key?(_1) }

            d = expected.props.sum { |prop, text| edit_distance(candidate.props[prop] || "", text.normalized) }
          else
            next if candidate.text? || candidate.role != expected.role

            text = inline_text(expected)
            d = edit_distance(candidate.name, expected.name) +
                (text.nil? ? 0 : (candidate.children.map { _1.text? ? edit_distance(_1.text, text.normalized) : text.normalized.size }.min || Float::INFINITY))
          end
          if d < distance
            best = candidate
            distance = d
          end
        end
        best
      end

      # A misfit where an expected node fits nothing: where it was looked
      # for (nil for anywhere), the nearest actual node, and the place the
      # previous sibling left it.
      #: (Node, Node?, Node, ?Node?, ?Array[Node]) -> Hash[Symbol, untyped]
      def unmatched(expected, inside, root, after = nil, place = [])
        near = lambda do |node, relation|
          { kind: :unmatched, expected: expected, inside: inside, after: after, place: place,
            nearest: node && { node: node, relation: relation == :child && line_fits?(node, expected) ? :fits : relation } }
        end
        return near.(most_alike(expected, below(root)), :child) if inside.nil?

        child = most_alike(expected, inside.children)
        child ? near.(child, :child) : near.(most_alike(expected, below(inside)), :deeper)
      end

      #: (Scores, Node, Node, bool, Node) -> Hash[Symbol, untyped]?
      def explain_at(scores, expected, node, deep, root)
        return nil if expected.text?

        contain, deeper = children_reading(expected, deep)
        unless contain
          expected.children.each_with_index do |child, index|
            at = node.children[index]
            return { kind: :missing, expected: child, inside: node } if at.nil?
            if scores.of(child, at, deeper).zero?
              return { kind: :unmatched, expected: child, inside: node, nearest: { node: at, relation: :at_place }, after: index.zero? ? nil : node.children[index - 1], place: [at] }
            end

            found = explain_at(scores, child, at, deeper, root)
            return found if found
          end
          extra = node.children[expected.children.size]
          return extra && { kind: :extra, expected: expected, actual: node, extra: extra }
        end
        # A fragment's best place may be the top of the snapshot, whose list
        # is no node a reader can look at.
        inside = node.equal?(root) ? nil : node
        _, pairs = scores.aligned(expected.children, node.children)
        expected.children.each_with_index do |child, index|
          at = pairs[index]
          if at.nil?
            # Every earlier child is paired, so the place starts after the
            # previous one's pair and ends before the next sibling's.
            previous = pairs[index - 1]
            later = (index + 1...expected.children.size).find { pairs.key?(_1) }
            from = (previous || -1) + 1
            place = later ? node.children[from...pairs.fetch(later)] : node.children[from..]
            return unmatched(child, inside, root, previous && node.children.fetch(previous), place || [])
          end
          found = explain_at(scores, child, node.children.fetch(at), false, root)
          return found if found
        end
        nil
      end

      # Where `expected` first parts from `actual`, or nil when it fits. The
      # walk starts at the actual node the expected tree fits best, the
      # earliest of equals, and follows the docstring's order from there.
      #: (Node, Node) -> Hash[Symbol, untyped]?
      def misfit(actual, expected)
        return nil if snapshot_fits?(actual, expected)

        scores = Scores.new
        best = nil #: Node?
        best_score = 0
        every_node(actual).each do |node|
          score = scores.of(expected, node, false)
          next unless score > best_score

          best = node
          best_score = score
        end
        # A fragment fits every node of a role, so its best place counts the
        # children it fits; with none, the first of them fits nothing anywhere.
        top = (!expected.text? && expected.role == FRAGMENT ? expected.children.first : expected) || expected
        return unmatched(top, nil, actual) if best.nil?

        explain_at(scores, expected, best, false, actual) || unmatched(top, nil, actual)
      end

      #: (String) -> String
      def source_text(source) = source.size > SOURCE_LIMIT ? "#{source[0, SOURCE_LIMIT]}..." : source

      #: (Node) -> String
      def actual_named(node) = "#{source_text(node.source)} (actual line #{node.line})"

      #: (Node) -> String
      def expected_named(node) = "expected line #{node.line} (#{source_text(node.source)})"

      # What keeps an actual node of the expected line's role and name from
      # fitting it: the first state or property it prints otherwise, or nil
      # when the two lines already show it.
      #: (Node, Node) -> String?
      def line_difference(actual, expected)
        return nil if actual.text? || expected.text?
        return nil if expected.role != FRAGMENT && (actual.role != expected.role || (!expected.name.empty? && actual.name != expected.name))

        STATE_NAMES.each do |state|
          next if state_fits?(state, actual.states, expected.states)

          printed = actual.states[state]
          return "which prints no #{state} state" if printed.nil?

          return "which prints [#{printed == true ? state : "#{state}=#{printed}"}]"
        end
        expected.props.each do |prop, text|
          next if text_fits?(actual.props[prop], text)

          printed = actual.props[prop]
          return printed.nil? ? "which has no /#{prop}" : "whose /#{prop} is #{source_text(printed)}"
        end
        nil
      end

      #: (Node) -> String
      def role_words(expected)
        return "a text" if expected.text?
        return "a node with #{expected.props.keys.map { "/#{_1}" }.join(" and ")}" if expected.role == FRAGMENT

        expected.role.match?(/\A[aeiou]/i) ? "an #{expected.role}" : "a #{expected.role}"
      end

      #: (Node) -> Integer
      def last_line(node) = every_node(node).map(&:line).max || node.line

      # A misfit as one line: the expected node by its docstring line,
      # where it was looked for, and the nearest actual node by its
      # snapshot line.
      #: (Hash[Symbol, untyped]) -> String
      def misfit_text(misfit)
        case misfit[:kind]
        when :extra
          stated = misfit[:expected].role == FRAGMENT ? "the expected list" : expected_named(misfit[:expected])
          "#{stated} states /children: #{misfit[:expected].children_mode || "deep-equal"}, and #{actual_named(misfit[:actual])} holds a child it does not name: #{actual_named(misfit[:extra])}"
        when :missing
          count = misfit[:inside].children.size
          "#{expected_named(misfit[:expected])} fits no child of #{actual_named(misfit[:inside])}, which has #{count == 1 ? "1 child" : "#{count} children"} and none at that place"
        else
          where = misfit[:inside].nil? ? "no node of the snapshot" : "no child of #{actual_named(misfit[:inside])}"
          head = "#{expected_named(misfit[:expected])} fits #{where}"
          nearest = misfit[:nearest]
          if nearest.nil?
            none = "#{head}, and no node there is #{role_words(misfit[:expected])}"
            place = misfit[:place]
            return none if place.empty?
            return "#{none}; the child at that place is #{actual_named(place.first)}" if place.size == 1

            return "#{none}; the #{place.size} children at that place are actual lines #{place.first.line} to #{last_line(place.last)}"
          end
          case nearest[:relation]
          when :child
            detail = line_difference(nearest[:node], misfit[:expected])
            "#{head}; nearest: #{actual_named(nearest[:node])}#{detail ? ", #{detail}" : ""}"
          when :at_place then "#{head}; the child at that place is #{actual_named(nearest[:node])}"
          when :deeper then "#{head}; nearest: #{actual_named(nearest[:node])}, which sits deeper than a child"
          else "#{head}; nearest: #{actual_named(nearest[:node])}, which fits the line but an earlier line took it, or it sits out of the order the lines give"
          end
        end
      end

      # Why an expected text is no tree a claim can be judged on, as
      # [:unreadable, line] or [:names_nothing]: either breaks the claim on
      # every page.
      #: ([Symbol, String] | [Symbol]) -> String
      def problem_reason(problem)
        if problem.first == :unreadable
          "the expected ARIA snapshot does not read: #{problem[1]}"
        else
          "fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds"
        end
      end

      #: (String) -> (Node | [Symbol, String] | [Symbol])
      def expected_tree(text)
        read = read_expected(text)
        return [:unreadable, read] if read.is_a?(String)

        read[1].zero? ? [:names_nothing] : read[0]
      end

      # Why an expected text breaks a claim on every page, or nil: what the
      # check reports from the line alone, before a run.
      #: (String) -> ([Symbol, String] | [Symbol])?
      def expected_problem(text)
        tree = expected_tree(text)
        tree.is_a?(Node) ? nil : tree
      end

      # Whether a claim's actual snapshot fits its expected one, from the
      # two texts the record keeps: { fits: }, { broken: }, or { unjudged: }.
      # An expected text that is no tree, or names nothing, breaks the
      # claim, since the line states it. An actual text that does not read
      # leaves the claim unjudged: the browser printed something this
      # reader does not know, which says nothing about the page.
      #: (String, String) -> Hash[Symbol, untyped]
      def judge(actual_text, expected_text)
        expected = expected_tree(expected_text)
        return { broken: problem_reason(expected) } unless expected.is_a?(Node)

        actual = read_actual(actual_text)
        return { unjudged: "the ARIA snapshot nukadoko took does not read: #{actual}, so the claim was not judged" } if actual.is_a?(String)

        { fits: snapshot_fits?(actual, expected) }
      end

      #: (String, String) -> Hash[Symbol, untyped]?
      def misfit_of(actual_text, expected_text)
        expected = expected_tree(expected_text)
        actual = read_actual(actual_text)
        return nil unless expected.is_a?(Node) && actual.is_a?(Node)

        misfit(actual, expected)
      end

      # Where a broken claim's two snapshots part, as one line, or nil when
      # they fit or either does not read.
      #: (String, String) -> String?
      def difference(actual_text, expected_text)
        found = misfit_of(actual_text, expected_text)
        found && misfit_text(found)
      end

      # The actual lines a misfit points at, so a line that cuts a long
      # snapshot shows where the fix goes: from the child the previous
      # expected sibling fit (or the node it was looked for under) to the
      # nearest node, or with no node of its role, through the children at
      # its place; the end of the node with a child missing; or the extra
      # child. At most EXCERPT_LINES of them, kept at the end the named node
      # is on, as { first:, last:, text: }.
      #: (String, String) -> Hash[Symbol, untyped]?
      def excerpt(actual_text, expected_text)
        found = misfit_of(actual_text, expected_text)
        return nil if found.nil?

        span =
          case found[:kind]
          when :missing then [found[:inside].line, last_line(found[:inside]), :end]
          when :extra then [found[:actual].line, found[:extra].line, :end]
          else
            start = found[:after]&.line || found[:inside]&.line
            if (nearest = found[:nearest])
              lines = [start || nearest[:node].line, nearest[:node].line]
              [lines.min, lines.max, :end]
            elsif (first = found[:place].first)
              [start || first.line, last_line(found[:place].last), :start]
            elsif found[:inside]
              [found[:inside].line, last_line(found[:inside]), :start]
            end
          end
        return nil if span.nil?

        from = [1, span[0]].max
        first = span[2] == :end ? [from, span[1] - EXCERPT_LINES + 1].max : from
        last = span[2] == :end ? span[1] : [span[1], from + EXCERPT_LINES - 1].min
        text = (actual_text.split(/\r?\n/, -1)[(first - 1)...last] || []).map { source_text(_1) }.join("\n")
        { first: first, last: last, text: text }
      end
    end
  end
end
