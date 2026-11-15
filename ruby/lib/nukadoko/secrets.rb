# frozen_string_literal: true
# rbs_inline: enabled

require "json"
require "open3"

# Env files and the secrets they hold, as docs/spec.md "Environments and
# secrets" describes and the TypeScript engine reads them: one KEY=VALUE
# parser for the env fixture and the secret set, so the two agree on what a
# file holds; git as the classifier of which files are secret sources; and
# one redaction that writes `{{secret.NAME}}` for a loaded value in every
# spelling a record can carry it in. Nothing here decides when to redact:
# the run calls `redact` on each surface it writes.
module Nukadoko
  module Engine
    module EnvFile
      # A configured env file that is on disk and cannot be read: setup
      # stops, since a key the steps need would otherwise look missing.
      class Unreadable < StandardError
        #: (String, String) -> void
        def initialize(path, detail)
          super(%(env file "#{path}" could not be read: #{detail}))
        end
      end

      QUOTES = ['"', "'", "`"].freeze

      #: (String) -> Hash[String, String]
      def self.parse(content) = scan(content)[0]

      # The 1-based numbers of the lines that were not loaded; a blank, a
      # comment, and a line inside a quoted value are not among them.
      #: (String) -> Array[Integer]
      def self.skipped_lines(content) = scan(content)[1]

      # The format dotenv's default parser reads, with `=` as the only
      # separator, scanned by hand so the lines it skips can be named.
      #: (String) -> [Hash[String, String], Array[Integer]]
      def self.scan(content)
        text = content.gsub("\r\n", "\n").tr("\r", "\n")
        values = {} #: Hash[String, String]
        skipped = [] #: Array[Integer]
        index = 0
        line = 1
        while index < text.length
          at = line
          index += 1 while space?(text[index])
          char = text[index]
          break if char.nil?

          if char == "\n"
            index += 1
            line += 1
            next
          end
          if char == "#"
            index, line = rest_of_line(text, index, line)
            next
          end
          if text[index, 6] == "export" && space?(text[index + 6])
            index += 6
            index += 1 while space?(text[index])
          end
          key_start = index
          index += 1 while index < text.length && text[index] != "=" && text[index] != "\n"
          key = text[key_start...index].to_s.strip
          if text[index] != "=" || key.empty?
            skipped << at
            index, line = rest_of_line(text, index, line)
            next
          end
          index += 1
          index += 1 while space?(text[index])
          if (quoted = quoted(text, index, line))
            values[key], index, line = quoted
            next
          end
          finish = index
          finish += 1 while finish < text.length && text[finish] != "\n" && text[finish] != "#"
          values[key] = text[index...finish].to_s.strip
          index, line = rest_of_line(text, finish, line)
        end
        [values, skipped]
      end

      #: (String?) -> bool
      def self.space?(char) = char == " " || char == "\t"

      # A quoted value and where the scan resumes, or nil when the quote does
      # not close or text follows it, so the line reads as unquoted.
      #: (String, Integer, Integer) -> [String, Integer, Integer]?
      def self.quoted(text, start, line)
        quote = text[start]
        return nil unless QUOTES.include?(quote)

        index = start + 1
        now = line
        while index < text.length
          char = text[index]
          if char == "\\"
            index += 1
            if index < text.length
              now += 1 if text[index] == "\n"
              index += 1
            end
            next
          end
          if char == "\n"
            now += 1
            index += 1
            next
          end
          if char != quote
            index += 1
            next
          end
          raw = text[(start + 1)...index].to_s
          after = index + 1
          after += 1 while space?(text[after])
          following = text[after]
          return nil unless following.nil? || following == "\n" || following == "#"

          # dotenv expands \n and \r after the quotes come off, and a
          # backslash before that pair is not special, so "\\n" is a
          # backslash and a newline, as in the files people already have.
          value = quote == '"' ? raw.gsub("\\n", "\n").gsub("\\r", "\r") : raw
          after += 1 while following == "#" && after < text.length && text[after] != "\n"
          if text[after] == "\n"
            after += 1
            now += 1
          end
          return [value, after, now]
        end
        nil
      end

      #: (String, Integer, Integer) -> [Integer, Integer]
      def self.rest_of_line(text, index, line)
        index += 1 while index < text.length && text[index] != "\n"
        index < text.length ? [index + 1, line + 1] : [index, line]
      end

      # The configured files merged in order, later files winning. A path
      # that is not on disk gives nothing, which `nuka check` warns about;
      # any other failure to read raises. The process environment is never
      # merged in, so the same files give the same record on any machine.
      #: (String, Array[String]) -> Hash[String, String]
      def self.load(root, paths)
        paths.each_with_object({}) do |path, merged|
          content = read(root, path)
          merged.merge!(parse(content)) if content
        end
      end

      #: (String, String) -> String?
      def self.read(root, path)
        File.read(File.join(root, path), encoding: "UTF-8")
      rescue Errno::ENOENT
        nil
      rescue SystemCallError => e
        raise Unreadable.new(path, e.class.name.to_s.split("::").last.to_s)
      end
    end

    # One run's secret values, and the redaction that writes each as
    # `{{secret.NAME}}`.
    class Secrets
      # A shorter value would match ordinary text (ids, statuses, short
      # words) all over a record and destroy what redaction protects.
      MIN_LENGTH = 4
      # What encodeURIComponent leaves as itself.
      URI_KEPT = /[A-Za-z0-9\-_.!~*'()]/
      # What URLSearchParams leaves as itself; a space becomes `+`.
      FORM_KEPT = /[A-Za-z0-9\-_.*]/

      # Which configured files are secret sources: untracked, ignored, or
      # tracked and different from HEAD. When git cannot answer (no git, no
      # repository, no HEAD), every file is one: the classification fails
      # safe and never fails the run.
      #: (String, Array[String]) -> { tracked: Array[String], source: Array[String] }
      def self.classify(root, paths)
        return { tracked: [], source: [] } if paths.empty?

        listed, status = Open3.capture2("git", "-C", root, "ls-files", "-z", "--", *paths, err: File::NULL)
        return { tracked: [], source: paths.dup } unless status.success?

        tracked = listed.split("\0").reject(&:empty?)
        known = paths.select { tracked.include?(_1) }
        dirty = known
        if known.any?
          # HEAD against the working tree, so a staged edit counts too;
          # --relative names a file below root by the path it was given.
          diff, status = Open3.capture2("git", "-C", root, "diff", "-z", "--name-only", "--relative", "HEAD", "--", *known, err: File::NULL)
          dirty = diff.split("\0").reject(&:empty?) if status.success?
        end
        plain = paths.select { known.include?(_1) && !dirty.include?(_1) }
        { tracked: plain, source: paths - plain }
      rescue SystemCallError
        { tracked: [], source: paths.dup }
      end

      # Every key of a secret source except `public` ones, and the keys of a
      # tracked file that `redact` names, each at least MIN_LENGTH long.
      #: (String, Array[String], ?public_keys: Array[String], ?redact_keys: Array[String]) -> Secrets
      def self.of(root, paths, public_keys: [], redact_keys: [])
        classified = classify(root, paths)
        values = EnvFile.load(root, classified[:source])
        EnvFile.load(root, classified[:tracked]).each { |key, value| values[key] = value if redact_keys.include?(key) }
        new(values.reject { |key, value| public_keys.include?(key) || value.length < MIN_LENGTH })
      end

      #: Hash[String, String]
      attr_reader :values

      #: (?Hash[String, String]) -> void
      def initialize(values = {})
        @values = values
        @replacements = replacements
        @pattern = @replacements.empty? ? nil : Regexp.union((@replacements.keys + @replacements.values.uniq).sort_by { -_1.length })
      end

      #: () -> bool
      def empty? = @values.empty?

      # A copy of `value` with every secret spelling in its strings and
      # keys written as its token. Two keys that redact to one would lose
      # a subtree, so that raises.
      #: (untyped) -> untyped
      def redact(value)
        return value unless @pattern

        case value
        when String then redact_string(value)
        when Array then value.map { redact(_1) }
        when Hash
          value.each_with_object({}) do |(key, inner), out|
            shown = key.is_a?(String) || key.is_a?(Symbol) ? redact_string(key.to_s) : key
            shown = shown.to_sym if key.is_a?(Symbol) && shown.is_a?(String)
            raise ArgumentError, "redact: keys #{JSON.generate(key.to_s)} and another both redact to #{JSON.generate(shown.to_s)}" if out.key?(shown)

            out[shown] = redact(inner)
          end
        else value
        end
      end

      # One pass over every spelling and every token, longest first, so a
      # token already in the text matches as itself and a second redaction
      # changes nothing.
      #: (String) -> String
      def redact_string(text)
        pattern = @pattern
        return text unless pattern

        text.gsub(pattern) { |found| @replacements.fetch(found, found) }
      end

      private

      # Each spelling a record can hold a value in: the value, its
      # percent-encoded forms (as encodeURIComponent writes it, and with `'`
      # as `%27`, as a URL's href does), its form-urlencoded form, and the
      # inside of its JSON string. A raw value claims its spelling first;
      # among equals the alphabetically first name wins.
      #: () -> Hash[String, String]
      def replacements
        named = @values.select { |_, value| value.length >= MIN_LENGTH }.sort_by(&:first)
        tokens = {} #: Hash[String, String]
        named.each { |name, value| tokens[value] ||= "{{secret.#{name}}}" }
        named.each do |name, value|
          uri = encode(value, URI_KEPT)
          [uri, uri.gsub("'", "%27"), encode(value, FORM_KEPT, space: "+"), JSON.generate(value)[1...-1].to_s].each do |spelling|
            tokens[spelling] ||= "{{secret.#{name}}}"
          end
        end
        tokens
      end

      #: (String, Regexp, ?space: String?) -> String
      def encode(value, kept, space: nil)
        value.each_char.map do |char|
          next space if space && char == " "

          char.match?(kept) ? char : char.bytes.map { format("%%%02X", _1) }.join
        end.join
      end
    end
  end
end
