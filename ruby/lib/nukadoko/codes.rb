# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# Every code a finding or a refusal can carry, with its description and
# the edit that gets past it, as the TypeScript engine's registry holds
# them (`bin/sync-codes` writes codes.json from it), so one code reads the
# same in either engine. Data only.
module Nukadoko
  module Engine
    module Codes
      ALL = JSON.parse(File.read(File.join(__dir__.to_s, "codes.json"), encoding: "UTF-8")).freeze

      #: (String) -> String?
      def self.fix(code) = ALL.dig(code, "fix")
    end
  end
end
