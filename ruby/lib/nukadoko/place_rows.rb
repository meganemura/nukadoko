# frozen_string_literal: true
# rbs_inline: enabled

# Responsibility: run.json's `flags` and `routes` (docs/spec.md "Execution
# events" and "Lists"): the verdict table read once per place of the
# program the head executions' paths reached, a flag's side or a route,
# with each criterion's verdict and its cells there. Pure: it reads the
# scenarios and the table run.json already holds. Boundary: a step's path
# is the world's stop's (events/path.rb), the table is run.rb's, and what
# a world's lists hold is the world's start; this module adds no verdict.
#
# Only head's executions are read: the base world runs the ref's code, and
# the old world the ref's criteria, so their cells are read in the table.
# A criterion counts under its row's verdict only where it has a required
# cell at the place, so a red count is never hidden; one seen at the place
# only in controls counts as `controls`.
#
# A flag's side is the one its line names, so one execution that switches
# a flag for one actor stands under both sides. When a head world read the
# flags list, every side it declares has a row, and every row names the
# environments whose list declares it. A request line names the route the
# program matched, never what a step claimed on the answer, so a route
# entry says requested, never checked.

module Nukadoko
  module Engine
    module PlaceRows
      COUNTED = %i[held proven failed unproven moved].freeze

      module_function

      # Each place the head executions' visits reached, by key, in the order
      # of its first visit: its criteria in the table's row order, each with
      # its head cells there in the table's column order. `visits` gives an
      # execution's visits as [key, place, detail]; `cell_of` what a cell
      # holds beyond the table's fields, from its visits' details.
      #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], ^(Hash[Symbol, untyped]) -> Array[[String, untyped, untyped]], ^(Array[untyped]) -> Hash[Symbol, untyped]) -> Hash[String, Hash[Symbol, untyped]]
      def criteria_by_place(scenarios, rows, visits, cell_of)
        index_of = rows.each_with_index.to_h { |row, index| [[row[:feature], row[:line]], index] }
        reached = {} #: Hash[String, Hash[Symbol, untyped]]
        scenarios.each do |scenario|
          next if scenario[:world]

          index = index_of[[scenario[:feature], scenario[:line]]]
          next unless index

          visits.(scenario).each do |key, place, detail|
            at = reached[key] ||= { place: place, rows: {} }
            ((at[:rows][index] ||= {})[scenario[:environment]] ||= []) << detail
          end
        end
        reached.transform_values do |at|
          criteria = at[:rows].sort_by(&:first).filter_map do |index, cells|
            row = rows[index]
            next nil if row[:verdict] == "removed"

            here = row[:cells].filter_map do |cell|
              details = cell[:world] == "head" ? cells[cell[:environment]] : nil
              next nil unless details

              { environment: cell[:environment], role: cell[:role], outcome: cell[:outcome], line: cell[:line] }.compact.merge(cell_of.(details || []))
            end
            here.empty? ? nil : { feature: row[:feature], line: row[:line], name: row[:name], verdict: row[:verdict], cells: here }
          end
          { place: at[:place], criteria: criteria }
        end
      end

      #: (Array[Hash[Symbol, untyped]]) -> Hash[Symbol, Integer]
      def counts_of(criteria)
        counts = { held: 0, proven: 0, failed: 0, unproven: 0, moved: 0, controls: 0 }
        criteria.each do |criterion|
          key = criterion[:cells].any? { _1[:role] == "required" } ? criterion[:verdict].to_sym : :controls
          counts[key] += 1
        end
        counts
      end

      #: (Hash[Symbol, untyped]) -> Array[Hash[String, untyped]]
      def paths_of(scenario) = scenario[:steps].filter_map { _1[:path] }

      #: (String, String) -> String
      def flag_key(name, side) = JSON.generate([name, side])

      # One row per flag and side the head paths' flag entries name, and per
      # side a read flags list declares, by flag name and then side.
      # `listed` is each environment whose flags list was read, in the
      # run's order.
      #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], ?Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def flag_rows(scenarios, rows, listed = [])
        visits = lambda do |scenario|
          paths_of(scenario).flat_map do |path|
            path[:entries].select { _1["kind"] == "flag" }.flat_map do |entry|
              (entry["gates"] || []).map { [flag_key(entry["name"], entry["side"]), { name: entry["name"], side: entry["side"] }, _1] }
            end
          end
        end
        cell_of = ->(gates) { { gates: gates.uniq.sort { |a, b| Events.by_gate(a, b) } } }
        evaluated = criteria_by_place(scenarios, rows, visits, cell_of)
        sides = {} #: Hash[String, Hash[Symbol, untyped]]
        evaluated.each { |key, at| sides[key] = { **at[:place], listed_in: [] } if at[:criteria].any? }
        listed.each do |list|
          list[:flags].each do |flag|
            flag[:sides].each do |side|
              entry = sides[flag_key(flag[:name], side)] ||= { name: flag[:name], side: side, listed_in: [] }
              entry[:listed_in] << list[:environment] unless entry[:listed_in].include?(list[:environment])
            end
          end
        end
        sides_evaluated = evaluated.values.select { _1[:criteria].any? }.map { _1[:place][:name] }.tally
        sides.sort_by { |_, entry| [entry[:name], entry[:side]] }.map do |key, entry|
          criteria = evaluated.dig(key, :criteria) || []
          { name: entry[:name], side: entry[:side], criteria: criteria, counts: counts_of(criteria),
            **(listed.empty? ? {} : { listed_in: entry[:listed_in] }),
            **(criteria.any? && sides_evaluated[entry[:name]] == 1 ? { only_side_evaluated: true } : {}) }
        end
      end

      # One entry per method and route a head world's routes list or a head
      # step's request line names, by route (a route no line matched last),
      # then by method. `listed` is each environment whose routes list was
      # read, in the run's order.
      #: (Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]], Array[Hash[Symbol, untyped]]) -> Array[Hash[Symbol, untyped]]
      def route_rows(scenarios, rows, listed)
        key_of = ->(method, route) { JSON.generate([method, route]) }
        entries = {} #: Hash[String, Hash[Symbol, untyped]]
        entry_of = ->(method, route) { entries[key_of.(method, route)] ||= { method: method, route: route, handlers: [], listed_in: [], requests: 0, statuses: [] } }
        listed.each do |list|
          list[:routes].each do |route|
            entry = entry_of.(route[:method], route[:route])
            entry[:listed_in] << list[:environment] unless entry[:listed_in].include?(list[:environment])
            entry[:handlers] |= route[:handlers]
          end
        end
        served = ->(scenario) { paths_of(scenario).flat_map { _1[:requests] } }
        scenarios.each do |scenario|
          next if scenario[:world]

          served.(scenario).each do |request|
            entry = entry_of.(request["method"], request["route"])
            entry[:requests] += 1
            entry[:statuses] |= [request["status"]]
          end
        end
        visits = ->(scenario) { served.(scenario).map { [key_of.(_1["method"], _1["route"]), nil, _1["status"]] } } #: ^(Hash[Symbol, untyped]) -> Array[[String, untyped, untyped]]
        reached = criteria_by_place(scenarios, rows, visits, ->(statuses) { { requests: statuses.size, statuses: statuses.uniq.sort } })
        entries.map do |key, entry|
          criteria = reached.dig(key, :criteria) || []
          { **entry, handlers: entry[:handlers].sort, statuses: entry[:statuses].sort, criteria: criteria, counts: counts_of(criteria) }
        end.sort_by { [_1[:route].nil? ? 1 : 0, _1[:route].to_s, _1[:method]] }
      end
    end
  end
end
