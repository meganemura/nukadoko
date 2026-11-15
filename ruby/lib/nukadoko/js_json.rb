# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# JSON text read as JavaScript's JSON.parse reads it, and refused in V8's
# words. A claim's json view reports why a text is no JSON, and that reason
# is part of the record both engines write, so the Ruby engine walks the
# grammar V8 walks and names the same place. Ruby's own parser accepts
# what JSON.parse refuses (comments, a NaN under some options), so the walk
# also decides what is valid; Ruby's parser only builds the value after it.
# Positions count UTF-16 code units, as a JavaScript string does.
module Nukadoko
  module JsJson
    class Error < JSON::ParserError; end

    # Texts V8 names whole, since they are what a JavaScript value turns
    # into when it is passed as text by mistake.
    SPECIAL = ["NaN", "Infinity", "undefined", "[object Object]"].freeze
    CONTEXT = 10
    WHITESPACE = [0x20, 0x09, 0x0a, 0x0d].freeze
    ESCAPES = '"\\/bfnrt'.codepoints.freeze
    HEX = "0123456789abcdefABCDEF".codepoints.freeze

    # A Failure carries where the walk stopped and what V8 says there.
    Failure = Data.define(:pos, :message)

    #: (String) -> untyped
    def self.parse(text)
      failure = Walk.new(text).failure
      raise Error, failure if failure

      begin
        JSON.parse(text)
      rescue JSON::ParserError => e
        # JSON.parse keeps a lone surrogate escape (\ud800) in its string; a
        # Ruby string has no way to hold one, so the text is refused here.
        raise Error, "the text holds an unpaired surrogate escape, which a Ruby string cannot hold" if e.message.include?("surrogate")

        raise
      end
    end

    # A value as JavaScript's JSON.stringify writes it: a whole float is the
    # integer its one number type holds (2.0 is 2), a float its shortest digits
    # (1e20 is 100000000000000000000), and NaN or Infinity null, so a reason that
    # quotes a value reads as the TypeScript engine's does.
    #: (untyped) -> String
    def self.generate(value)
      case value
      when Hash then "{#{value.map { |key, item| "#{JSON.generate(key.to_s)}:#{generate(item)}" }.join(",")}}"
      when Array then "[#{value.map { generate(_1) }.join(",")}]"
      when Float then value.finite? ? Engine::AriaSnapshot.js_number(value) : "null"
      when Symbol then JSON.generate(value.to_s)
      else JSON.generate(value)
      end
    end
    
    # Walks the text once and gives V8's message for the first place it is
    # no JSON, or nil.
    class Walk
      #: (String) -> void
      def initialize(text)
        @text = text
        @units = text.encode("UTF-16LE").unpack("v*") #: Array[Integer]
        @pos = 0
      end

      #: () -> String?
      def failure
        value
        space
        return nil if @pos >= @units.size

        located("Unexpected non-whitespace character after JSON")
      rescue Stop => e
        e.message
      end

      private

      class Stop < StandardError; end

      #: () -> Integer?
      def peek = @units[@pos]

      #: () -> void
      def space
        @pos += 1 while (unit = peek) && WHITESPACE.include?(unit)
      end

      #: (String) -> String
      def located(words)
        before = @units.first(@pos)
        lines = 0
        column = 0
        index = 0
        while index < before.size
          unit = before[index]
          if unit == 0x0d || unit == 0x0a
            lines += 1
            column = 0
            index += 1 if unit == 0x0d && before[index + 1] == 0x0a
          else
            column += 1
          end
          index += 1
        end
        "#{words}#{" in JSON" unless words.end_with?("JSON")} at position #{@pos} (line #{lines + 1} column #{column + 1})"
      end

      #: (?String?) -> bot
      def stop(words = nil)
        raise Stop, located(words) if words
        raise Stop, "Unexpected end of JSON input" if @pos >= @units.size
        # V8 names the kind of token it found where it names one.
        raise Stop, located("Unexpected number") if peek == 0x2d || digit?
        raise Stop, located("Unexpected string") if peek == 0x22

        raise Stop, unexpected
      end

      # V8's message for a character no rule expected: the text itself when
      # it is short, else ten units on each side of the character.
      #: () -> String
      def unexpected
        source = @units
        return "\"#{@text}\" is not valid JSON" if SPECIAL.include?(@text)

        token = text_of([source[@pos].to_i])
        return "Unexpected token '#{token}', \"#{@text}\" is not valid JSON" if source.size < CONTEXT * 2 + 1

        if @pos < CONTEXT
          "Unexpected token '#{token}', \"#{text_of(source[0, @pos + CONTEXT] || [])}\"... is not valid JSON"
        elsif @pos < source.size - CONTEXT
          "Unexpected token '#{token}', ...\"#{text_of(source[@pos - CONTEXT, CONTEXT * 2] || [])}\"... is not valid JSON"
        else
          "Unexpected token '#{token}', ...\"#{text_of(source[(@pos - CONTEXT)..] || [])}\" is not valid JSON"
        end
      end

      # A run of UTF-16 units as text; half of a pair, which a UTF-8 string
      # cannot hold, is the replacement character.
      #: (Array[Integer]) -> String
      def text_of(units)
        units.pack("v*").force_encoding("UTF-16LE").encode("UTF-8", invalid: :replace, undef: :replace)
      end

      #: () -> void
      def value
        space
        case peek
        when nil then stop
        when 0x22 then string
        when 0x7b then object
        when 0x5b then array
        when 0x2d, 0x30..0x39 then number
        when 0x74 then literal("true")
        when 0x66 then literal("false")
        when 0x6e then literal("null")
        else stop
        end
      end

      #: (String) -> void
      def literal(word)
        word.each_codepoint do |unit|
          stop if peek != unit
          @pos += 1
        end
      end

      #: () -> void
      def object
        @pos += 1
        space
        return @pos += 1 if peek == 0x7d

        first = true
        loop do
          stop(first ? "Expected property name or '}'" : "Expected double-quoted property name") unless peek == 0x22
          first = false
          string
          space
          stop("Expected ':' after property name") unless peek == 0x3a
          @pos += 1
          value
          space
          case peek
          when 0x2c then @pos += 1
                         space
          when 0x7d then return @pos += 1
          else stop("Expected ',' or '}' after property value")
          end
        end
      end

      #: () -> void
      def array
        @pos += 1
        space
        return @pos += 1 if peek == 0x5d

        loop do
          value
          space
          case peek
          when 0x2c then @pos += 1
          when 0x5d then return @pos += 1
          else stop("Expected ',' or ']' after array element")
          end
        end
      end

      #: () -> void
      def string
        @pos += 1
        loop do
          unit = peek
          stop("Unterminated string") if unit.nil?
          @pos += 1
          return if unit == 0x22

          if unit < 0x20
            @pos -= 1
            stop("Bad control character in string literal")
          end
          next unless unit == 0x5c

          escape = peek
          stop if escape.nil?
          if escape == 0x75
            @pos += 1
            4.times do
              stop("Bad Unicode escape") unless (hex = peek) && HEX.include?(hex)
              @pos += 1
            end
          else
            stop("Bad escaped character") unless ESCAPES.include?(escape)
            @pos += 1
          end
        end
      end

      #: () -> void
      def number
        if peek == 0x2d
          @pos += 1
          stop("No number after minus sign") unless digit?
        end
        if peek == 0x30
          @pos += 1
          raise Stop, located("Unexpected number") if digit?
        else
          @pos += 1 while digit?
        end
        if peek == 0x2e
          @pos += 1
          stop("Unterminated fractional number") unless digit?
          @pos += 1 while digit?
        end
        return unless [0x65, 0x45].include?(peek)

        @pos += 1
        @pos += 1 if [0x2b, 0x2d].include?(peek)
        stop("Exponent part is missing a number") unless digit?
        @pos += 1 while digit?
      end

      #: () -> bool
      def digit? = (unit = peek) ? unit.between?(0x30, 0x39) : false
    end
  end
end
