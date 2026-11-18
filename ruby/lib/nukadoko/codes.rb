# frozen_string_literal: true
# rbs_inline: enabled

require "json"

# Every code a finding or a refusal can carry, with its description, the
# edit that gets past it, and the registry it comes from (`check`, `run`,
# or `refusal`), as the TypeScript engine's registries hold them
# (`bin/sync-codes` writes codes.json from them), so one code reads the
# same in either engine and `nuka check --codes` lists the same codes in
# the same order. Data only.
module Nukadoko
  module Engine
    module Codes
      ALL = JSON.parse(File.read(File.join(__dir__.to_s, "codes.json"), encoding: "UTF-8")).freeze

      #: (String) -> String?
      def self.fix(code) = ALL.dig(code, "fix")

      # A code `nuka check` itself reports. A run code can carry a warning
      # or a note too, so the severity alone cannot tell.
      #: (String) -> bool
      def self.check?(code) = ALL.dig(code, "source") == "check"

      #: (String) -> String?
      def self.severity(code) = ALL.dig(code, "severity")

      # Every code as a finding with no location: its severity, the code,
      # its description as the message, and its general fix.
      #: () -> Array[Hash[Symbol, String]]
      def self.listed
        ALL.map { |code, entry| { severity: entry["severity"], code: code, message: entry["description"], fix: entry["fix"] } }
      end
    end
  end
end
