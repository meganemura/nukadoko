# frozen_string_literal: true
# rbs_inline: enabled

# Where a step's own code raised, as the project's own frames of the
# backtrace. A step record's error message says what went wrong but not
# where, so a reader had to call the step again outside nukadoko to find the
# line. The frames kept are the ones a reader can open and change: inside
# the project root, and outside the gem and any installed bundle, as the
# TypeScript engine leaves out node_modules.
module Nukadoko
  module Engine
    module ErrorFrames
      # The first few frames are where the code was when it raised; the rest
      # is the call chain a reader rarely needs.
      MAX = 5
      GEM_ROOT = File.expand_path("../..", __dir__.to_s)

      module_function

      # Each frame as `path:line` relative to `root`, in backtrace order,
      # without repeats.
      #: (Exception, String) -> Array[String]
      def of(error, root)
        # A root under a symlink (macOS /var) names files by either spelling.
        roots = [File.expand_path(root), (File.realpath(root) rescue nil)].compact.uniq
        frames = [] #: Array[String]
        (error.backtrace_locations || []).each do |location|
          file = location.absolute_path || location.path
          next unless file && File.absolute_path?(file)
          base = roots.find { file.start_with?("#{_1}/") }
          next if file.start_with?("#{GEM_ROOT}/") || base.nil?

          relative = file.delete_prefix("#{base}/")
          next if relative.split("/").include?("vendor") && relative.include?("/bundle/")

          frame = "#{relative}:#{location.lineno}"
          frames << frame unless frames.include?(frame)
          break if frames.size == MAX
        end
        frames
      end
    end
  end
end
