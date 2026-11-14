# frozen_string_literal: true

# The order `nuka run` plays its selection in, and the rerun line that plays
# it again. File order is the order the targets select. A shuffled order
# sorts the feature files, then each file's scenarios, by a key made from the
# seed and each one's path or line. A file stays whole, so one seed names one
# order at every concurrency. The key does not depend on what else was
# selected, so any part of a selection runs in the order the whole gave it,
# and a rerun line can name what ran before a failed scenario.
#
# The key is the TypeScript engine's, bit for bit: a seed names the same
# order in either engine. It works on 32-bit words, and on the UTF-16 code
# units of the text, as JavaScript's charCodeAt reads them.
module Nukadoko
  module Engine
    module Order
      MAX_SEED = 0xffff_ffff
      MASK = 0xffff_ffff
      FILE = { kind: "file" }.freeze

      # `--order`'s value read, or nil when it is none of file, shuffled,
      # and shuffled:<seed>. shuffled alone draws its seed.
      def self.read(value)
        return FILE if value.nil? || value == "file"
        return { kind: "shuffled", seed: SecureRandom.random_number(MAX_SEED + 1) } if value == "shuffled"

        seed = value[/\Ashuffled:(0|[1-9][0-9]{0,9})\z/, 1]&.to_i
        seed && seed <= MAX_SEED ? { kind: "shuffled", seed: seed } : nil
      end

      def self.text(order) = order[:kind] == "file" ? "file" : "shuffled:#{order[:seed]}"
      def self.flags(order) = order[:kind] == "file" ? [] : ["--order", text(order)]

      # The scenarios in the run's order: by file in the order the files
      # first appear, or by the shuffled keys.
      def self.arrange(scenarios, order)
        files = scenarios.group_by(&:uri)
        return files.values.flatten if order[:kind] == "file"

        seed = order[:seed]
        files.keys.sort_by { [key(seed, _1), _1] }.flat_map do |uri|
          files[uri].sort_by { [key(seed, "#{uri}:#{_1.line}"), _1.line] }
        end
      end

      # The targets that run, in a shuffled order, what ran before `scenario`
      # in its pass and then `scenario`. A file whose every scenario of the
      # pass is among them is named whole when the run named it whole.
      def self.replay_targets(sequence, whole_files, scenario)
        at = sequence.index { _1.uri == scenario.uri && _1.line == scenario.line }
        ran = at ? sequence.first(at + 1) : [scenario]
        in_pass = sequence.map(&:uri).tally
        ran.chunk_while { _1.uri == _2.uri }.flat_map do |group|
          uri = group.first.uri
          whole_files.include?(uri) && group.size == in_pass[uri] ? [uri] : group.map { "#{uri}:#{_1.line}" }
        end
      end

      # The seed is mixed before the text and the result after it, so two
      # seeds a step apart give unrelated orders.
      def self.key(seed, text)
        hash = mix(seed ^ 0x9e37_79b9)
        text.encode("UTF-16LE").unpack("v*").each { |unit| hash = ((hash ^ unit) * 0x0100_0193) & MASK }
        mix(hash)
      end

      def self.mix(value)
        hash = value & MASK
        hash = ((hash ^ (hash >> 16)) * 0x85eb_ca6b) & MASK
        hash = ((hash ^ (hash >> 13)) * 0xc2b2_ae35) & MASK
        (hash ^ (hash >> 16)) & MASK
      end
    end
  end
end
