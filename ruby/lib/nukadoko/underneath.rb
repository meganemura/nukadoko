# frozen_string_literal: true
# rbs_inline: enabled

require "uri"

# The failures underneath an execution (docs/spec.md "Failures
# underneath"): what its steps saw of the program failing, grouped by what
# an `@expects:` tag names; which of them no tag of the scenario accepts,
# which turns a pass broke in its cell; and the findings that say so.
# Pure, over a step's page events and the entries of its http.jsonl, and
# over run.json's scenarios. Writing those is Run#execute's, and folding
# the program's execution events into a step's `path` is the world's stop.
#
# Only a measured failure is counted: an entry of http.jsonl with a status
# from 500 to 599, and an error the page threw that nothing caught. Each is
# the failing party's own statement: the server chose the status, and the
# browser found no handler for what the page threw. What could not be seen
# (a page error past the record's cap, a page's request left out of
# http.jsonl, whose status was never kept) is kept apart as `unseen`, and
# is never counted as a failure.
module Nukadoko
  module Engine
    module Underneath
      PREFIX = "@expects:"
      FAILED_STATUS = (500..599) #: Range[Integer]

      # The kinds in the order a failure is looked for under one step: the
      # server's answer, the program's own report, then the page.
      KIND_ORDER = %w[status error page-error].freeze

      module_function

      # The failure `tag` names, as [kind, value], or nil when it does not
      # read as `@expects:<kind>=<value>` (Check.expects_problem says why).
      #: (String) -> [String, String]?
      def read_tag(tag)
        return nil unless tag.start_with?(PREFIX)

        kind, value = tag.delete_prefix(PREFIX).split("=", 2)
        rule = Check::EXPECTED[kind.to_s]
        rule && value && value.match?(rule[0]) ? [kind.to_s, value] : nil
      end

      #: (String, String) -> String
      def tag_text(kind, value) = "#{PREFIX}#{kind}=#{value}"

      # The `@expects:` tags among a criterion's tags that read, each once,
      # in the order the tags first name them.
      #: (Array[String]) -> Array[String]
      def tags_of(tags) = tags.filter_map { (read = read_tag(_1)) && tag_text(read[0], read[1]) }.uniq

      # A step's `underneath`, from its page events, its http.jsonl entries
      # (nil when the file could not be read), how many entries could not
      # be written, and the page requests left out of it by type. nil when
      # the step saw no failure and missed nothing.
      #: (Hash[Symbol, untyped]?, Array[Hash[Symbol, untyped]?]?, Integer?, Hash[untyped, Integer]?) -> Hash[Symbol, untyped]?
      def of_record(page_events, http, http_log_failed, http_omitted)
        statuses = status_groups(http || [])
        page_errors = page_error_groups(page_events)
        kept = (page_events && page_events[:page_errors] || []).size
        total = page_events&.dig(:truncated, :page_errors)
        past_cap = total ? total - kept : 0
        http_lines = http.nil? ? nil : http.count(&:nil?) + http_log_failed.to_i
        omitted = (http_omitted || {}).values.sum
        unseen = { **(http_lines.nil? || http_lines.positive? ? { http_lines: http_lines } : {}),
                   **(omitted.positive? ? { http_omitted: omitted } : {}), **(past_cap.positive? ? { page_errors: past_cap } : {}) }
        underneath = { **(statuses.empty? ? {} : { statuses: statuses }), **(page_errors.empty? ? {} : { page_errors: page_errors }),
                       **(unseen.empty? ? {} : { unseen: unseen }) }
        underneath.empty? ? nil : underneath
      end

      #: (Array[Hash[Symbol, untyped]?]) -> Array[Hash[Symbol, untyped]]
      def status_groups(http)
        groups = {} #: Hash[Integer, Hash[Symbol, untyped]]
        http.each_with_index do |entry, index|
          next unless entry

          status = entry[:status]
          next unless status.is_a?(Integer) && FAILED_STATUS.cover?(status)

          if (group = groups[status])
            group[:count] += 1
            next
          end
          groups[status] = { count: 1, first: { method: entry[:method], url: entry[:url], via: entry[:via], http_line: index, **(entry[:as] ? { as: entry[:as] } : {}) } }
        end
        groups.sort_by(&:first).map { |status, group| { status: status, **group } }
      end

      #: (Hash[Symbol, untyped]?) -> Array[Hash[Symbol, untyped]]
      def page_error_groups(page_events)
        groups = {} #: Hash[String?, Hash[Symbol, untyped]]
        (page_events && page_events[:page_errors] || []).each do |entry|
          name = entry[:name]
          if (group = groups[name])
            group[:count] += 1
            next
          end
          groups[name] = { count: 1, first: { message: Summary.first_error_line(entry[:message]), **(entry[:as] ? { as: entry[:as] } : {}) } }
        end
        groups.map { |name, group| { name: name, **group } }
      end

      # A field of a hash read from either engine's run.json or in process.
      #: (Hash[untyped, untyped]?, Symbol) -> untyped
      def at(hash, key)
        return nil unless hash.is_a?(Hash)

        hash.key?(key) ? hash[key] : hash[key.to_s]
      end

      # Whether a hash holds a key, a null value included: an unread
      # http.jsonl is a null count.
      #: (untyped, Symbol) -> bool
      def has?(hash, key) = hash.is_a?(Hash) && (hash.key?(key) || hash.key?(key.to_s))

      # What one step shows of one kind, each as the key a tag names, a
      # count, and where the first one is. An unhandled error is the step's
      # `path` entry, which the world's stop folded from every line of its
      # trace; a `handled: true` error is the program going on, not failing.
      #: (String, Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def found_under(kind, step)
        underneath = at(step, :underneath)
        case kind
        when "status"
          (at(underneath, :statuses) || []).map { { kind: "status", value: at(_1, :status).to_s, count: at(_1, :count), first: at(_1, :first) } }
        when "error"
          (at(at(step, :path), :entries) || []).filter_map do |entry|
            next unless at(entry, :kind) == "error" && at(entry, :handled) != true

            { kind: "error", value: at(entry, :class).to_s, count: at(entry, :count) }
          end
        else
          (at(underneath, :page_errors) || []).map { { kind: "page-error", value: at(_1, :name), count: at(_1, :count), first: at(_1, :first) } }
        end
      end

      # Every failure underneath `execution`, steps in order and, within a
      # step, in KIND_ORDER, each with the tag that accepts it or nil.
      #: (Hash[Symbol, untyped]) -> Array[Hash[Symbol, untyped]]
      def failures(execution)
        accepted = (execution[:expects] || []).select { read_tag(_1) }
        (execution[:steps] || []).each_with_index.flat_map do |step, index|
          KIND_ORDER.flat_map do |kind|
            found_under(kind, step).map do |found|
              tag = found[:value].nil? ? nil : tag_text(found[:kind], found[:value])
              { **found, step: index, line: step[:line] || execution[:line], expected_by: tag && accepted.include?(tag) ? tag : nil }
            end
          end
        end
      end

      # The first failure underneath `execution` no tag of its scenario
      # accepts: what turns a pass broke.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]?
      def first_unexpected(execution) = failures(execution).find { _1[:expected_by].nil? }

      # A request as a reason names it: its method and its path. The port
      # of a world differs from run to run, so the full URL would make two
      # runs that failed the same way disagree.
      #: (Hash[Symbol, untyped]) -> String
      def request_of(first)
        path = URI(first[:url].to_s).path
        "#{first[:method]} #{path.nil? || path.empty? ? first[:url] : path}"
      rescue URI::Error
        "#{first[:method]} #{first[:url]}"
      end

      # The cell's reason for `failure`: the step's line and the failure's
      # key, never a count or a message, so two runs that failed the same
      # way agree.
      #: (Hash[Symbol, untyped]) -> String
      def reason(failure)
        unnamed = "which no @expects tag of the scenario names"
        line = failure[:line]
        case failure[:kind]
        when "status" then "the step at line #{line} got a #{failure[:value]} response to #{request_of(failure[:first])}, #{unnamed}"
        when "error" then "the program reported an unhandled #{failure[:value]} in the trace of the step at line #{line}, #{unnamed}"
        else
          if failure[:value].nil?
            "the page threw an uncaught error with no name while the step at line #{line} ran, which no @expects tag can name"
          else "the page threw an uncaught #{failure[:value]} while the step at line #{line} ran, #{unnamed}"
          end
        end
      end

      #: (Integer, String, String) -> String
      def count_of(count, one, many) = "#{count} #{count == 1 ? one : many}"

      # `failure` as a finding and the summary name it, with where its
      # first occurrence is.
      #: (Hash[Symbol, untyped]) -> String
      def text(failure)
        first = failure[:first]
        case failure[:kind]
        when "status"
          "#{count_of(failure[:count], "response", "responses")} with status #{failure[:value]}, first #{at(first, :method)} #{at(first, :url)} " \
            "(#{at(first, :via)}, http.jsonl[#{at(first, :http_line)}])"
        when "error" then "#{count_of(failure[:count], "line", "lines")} of the program's execution events reporting an unhandled #{failure[:value]}"
        else
          what = failure[:value].nil? ? "error with no name" : failure[:value]
          "#{count_of(failure[:count], "uncaught #{what}", "uncaught #{what}s")} from the page, first #{JSON.generate(at(first, :message))}"
        end
      end

      # Whether a claim of `steps` was judged on lines still on their way.
      #: (Array[Hash[Symbol, untyped]]) -> bool
      def judged_too_early?(steps)
        steps.any? { |step| (at(step, :claims) || []).any? { (late = at(_1, :after_world_stop)) && at(late, :outcome) != at(_1, :outcome) } }
      end

      # The failure underneath that turns `execution` broke in its cell:
      # it passed, no claim of it was judged too early (its own broke), and
      # a failure underneath it is one no tag of its scenario accepts. Only
      # a pass: a fail is already the first failure that counts.
      #: (Hash[Symbol, untyped]) -> Hash[Symbol, untyped]?
      def demoting(execution)
        return nil unless execution[:status] == "passed" && !judged_too_early?(execution[:steps] || [])

        first_unexpected(execution)
      end

      # One `unexpected-failure` finding per head required execution a
      # failure underneath turned broke, per scenario and environment,
      # since the runs of `--repeat` would say it again. It names every
      # failure no tag accepts under the first step that has one, and its
      # `fix:` spells the tag for each.
      #: (Array[Hash[Symbol, untyped]], label: ^(Hash[Symbol, untyped]) -> String, rerun: ^(Hash[Symbol, untyped]) -> String?) -> Array[Hash[Symbol, untyped]]
      def unexpected_findings(scenarios, label:, rerun:)
        findings = {} #: Hash[String, Hash[Symbol, untyped]]
        scenarios.each do |scenario|
          next if scenario[:world] || scenario[:role] == "control"

          first = demoting(scenario)
          key = "#{scenario[:feature]}:#{scenario[:line]}:#{scenario[:environment]}"
          next if first.nil? || findings.key?(key)

          step = scenario[:steps][first[:step]]
          unexpected = failures(scenario).select { _1[:step] == first[:step] && _1[:expected_by].nil? }
          tags = unexpected.filter_map { _1[:value] && tag_text(_1[:kind], _1[:value]) }.uniq
          record = step[:record] ? "; record #{step[:record]}" : ""
          findings[key] = {
            severity: "failed", code: "unexpected-failure", file: scenario[:feature], line: first[:line],
            message: "#{label.(scenario)}: its steps passed, and the program failed underneath the step at line #{first[:line]}, " \
                     "#{JSON.generate(step[:text])}, in a way no @expects tag names, so its cell is broke: #{unexpected.map { text(_1) }.join("; ")}#{record}",
            fix: if tags.empty? then "Fix what failed: the page threw an error with no name, which no @expects tag can accept."
                 else "Fix what failed. A scenario that causes it on purpose names it on its Scenario line: #{tags.join(" ")}"
                 end,
            do: rerun.(scenario)
          }.compact
        end
        findings.values
      end

      # Whether an execution was watched for a kind whole, so a tag of that
      # kind that matched nothing there matched nothing that happened:
      # every entry of http.jsonl read and no page request left out of it,
      # the page errors of a browser kept, or the program's events read
      # with no line that may be any line and no gap where an error could
      # still be. A step that sent no request has a gap too
      # (`no-requests`), and no error of its trace can be missing.
      #: (String, Hash[Symbol, untyped]) -> bool
      def watched?(kind, execution)
        steps = execution[:steps] || []
        case kind
        when "status"
          steps.all? do |step|
            unseen = at(at(step, :underneath), :unseen)
            at(step, :record_unreadable) != true && !(has?(unseen, :http_lines) || has?(unseen, :http_omitted))
          end
        when "error"
          steps.any? { at(_1, :path) } &&
            steps.all? { (path = at(_1, :path)).nil? || (at(path, :maybe).to_i.zero? && (at(path, :open) || []).all? { |open| at(open, :gap) == "no-requests" }) }
        else
          !execution[:browser].nil? && steps.all? { at(_1, :record_unreadable) != true && at(at(at(_1, :underneath), :unseen), :page_errors).nil? }
        end
      end

      NOT_SEEN = { "status" => ->(value) { "no step got a #{value} response" },
                   "error" => ->(value) { "the program reported no unhandled #{value}" },
                   "page-error" => ->(value) { "the page threw no uncaught #{value}" } }.freeze #: Hash[String, ^(String) -> String]

      # One `expects-unseen` note per tag of a head required scenario, per
      # environment, whose every execution passed and matched no failure
      # that tag accepts, where each was watched for its kind whole. A tag
      # left in place after its failure stopped happening accepts that
      # failure in every later run.
      #: (Array[Hash[Symbol, untyped]], label: ^(Hash[Symbol, untyped]) -> String) -> Array[Hash[Symbol, untyped]]
      def unseen_notes(scenarios, label:)
        cells = scenarios.reject { _1[:world] || _1[:role] == "control" || (_1[:expects] || []).empty? }
                         .group_by { [_1[:feature], _1[:line], _1[:environment]] }
        cells.values.flat_map do |executions|
          passed = executions.all? { _1[:status] == "passed" && !judged_too_early?(_1[:steps] || []) && first_unexpected(_1).nil? }
          next [] unless passed

          matched = executions.flat_map { |execution| failures(execution).filter_map { _1[:expected_by] } }
          first = executions.first
          first[:expects].filter_map do |tag|
            kind, value = read_tag(tag)
            next unless kind && value && !matched.include?(tag) && executions.all? { watched?(kind, _1) }

            where = executions.size == 1 ? "its execution" : "any of its #{executions.size} executions"
            { severity: "note", code: "expects-unseen", file: first[:feature], line: first[:line],
              message: "#{label.(first)}: #{tag} accepts a failure that did not happen: #{NOT_SEEN.fetch(kind).(value)} in #{where}",
              fix: Codes.fix("expects-unseen") }
          end
        end
      end
    end
  end
end
