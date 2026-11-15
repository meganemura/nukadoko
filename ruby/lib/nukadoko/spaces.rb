# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: the spaces JavaScript's trim, trimEnd, and \s take, so a
# text the Ruby engine trims ends where the TypeScript engine's does.
# Ruby's strip takes a NUL and no Unicode space, and [[:space:]] takes
# U+0085, which JavaScript keeps; a page's text often ends in a no-break
# space, so either would judge a claim the other way.
module Nukadoko
  module Engine
    module Spaces
      CLASS = "\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
      SPACE = /[#{CLASS}]/
      LEADING = /\A[#{CLASS}]+/
      TRAILING = /[#{CLASS}]+\z/
      BLANK = /\A[#{CLASS}]*\z/

      #: (String) -> String
      def self.trim(text) = text.sub(LEADING, "").sub(TRAILING, "")

      #: (String) -> String
      def self.trim_end(text) = text.sub(TRAILING, "")

      #: (String) -> bool
      def self.blank?(text) = text.match?(BLANK)
    end
  end
end
