# frozen_string_literal: true
# rbs_inline: enabled

# What `nuka check` says about the env files the config and the program
# name, as the TypeScript engine says it. A missing file is a warning, since
# a run reads it as empty; a line that loads nothing, and a `secrets` key
# that reaches nothing, are warnings too. None of it prints a value: the
# files hold secrets. The one guess here, whether a key's name looks like a
# secret, decides only a warning and never what is redacted.
module Nukadoko
  module Engine
    module EnvCheck
      # `KEY` counts only as a whole underscore-delimited word, so MONKEY,
      # KEYWORD, and APIKEY are not guessed to be secrets.
      SECRET_LOOKING = /SECRET|PASSWORD|TOKEN|CREDENTIAL|(?:^|_)KEY(?:_|$)/i

      # A key in both lists is two opposite instructions, so the config is
      # refused before anything reads it.
      #: () -> void
      def self.validate!
        both = keys(:public) & keys(:redact)
        return if both.empty?

        raise Refusal.new("config-invalid",
                          %(#{CONFIG} is invalid: secrets.public and secrets.redact both name "#{both.first}": that is two opposite instructions (demote vs. promote) for the same key; remove it from one of the two lists.))
      end

      #: (Symbol) -> Array[String]
      def self.keys(list) = (Nukadoko.config_options.dig(:secrets, list) || []).map(&:to_s)

      #: (String) -> Array[Finding]
      def self.findings(project)
        config_files = (Nukadoko.config_options[:envFiles] || []).map(&:to_s)
        environments = (Nukadoko.program_options[:environments] || {}).to_h { |name, e| [name.to_s, (e[:envFiles] || []).map(&:to_s)] }
        all = config_files + environments.values.flatten
        exists = ->(path) { File.exist?(File.join(project, path)) }
        found = config_files.reject(&exists).map do |path|
          warning("env-file-missing", path, %(envFile "#{path}" does not exist), %(Create #{path}, or remove "#{path}" from envFiles in #{CONFIG}.))
        end
        environments.each do |name, paths|
          paths.reject(&exists).each do |path|
            found << warning("environment-env-file-missing", path, %(environments.#{name}.envFiles names "#{path}", which does not exist),
                             %(Create #{path}, or remove "#{path}" from environments.#{name}.envFiles in #{CONFIG}.))
          end
        end
        defined = EnvFile.load(project, all)
        all.uniq.each do |path|
          content = readable(project, path) or next
          EnvFile.skipped_lines(content).each do |line|
            found << Finding.new("warning", "env-file-skipped-line", path, line, nil, %(envFile "#{path}" line #{line} was skipped, so nothing on it was loaded),
                                 Codes.fix("env-file-skipped-line"), nil)
          end
        end
        keys(:public).reject { defined.key?(_1) }.each do |key|
          found << warning("secrets-public-key-unknown", CONFIG, %(secrets.public names "#{key}", which is not defined in any configured envFile))
        end
        keys(:redact).each do |key|
          if !defined.key?(key)
            found << warning("secrets-redact-key-unknown", CONFIG, %(secrets.redact names "#{key}", which is not defined in any configured envFile))
          elsif defined.fetch(key).length < Secrets::MIN_LENGTH
            found << warning("secrets-redact-key-too-short", CONFIG,
                             %(secrets.redact names "#{key}", but its value is shorter than #{Secrets::MIN_LENGTH} characters, so nukadoko never redacts it))
          end
        end
        Secrets.classify(project, all)[:tracked].each do |path|
          content = readable(project, path) or next
          EnvFile.parse(content).each_key do |key|
            next if keys(:redact).include?(key) || !key.match?(SECRET_LOOKING)

            found << warning("tracked-secret-looking-key", path,
                             %("#{key}" in "#{path}" looks like a secret by name, but that file is tracked by git so its value is not redacted; add "#{key}" to secrets.redact if it should be))
          end
        end
        found
      end

      #: (String, String, String, ?String?) -> Finding
      def self.warning(code, file, message, fix = nil) = Finding.new("warning", code, file, nil, nil, message, fix || Codes.fix(code), nil)

      #: (String, String) -> String?
      def self.readable(project, path)
        File.read(File.join(project, path), encoding: "UTF-8")
      rescue SystemCallError
        nil
      end
    end
  end
end
