# frozen_string_literal: true

require "hegel"
require "nukadoko"

# Properties of how an MCP call is stamped and written: a stamped message
# reads back the traceparent it was given and keeps the rest of its
# params, a message that already carries one or has positional params goes
# as it was, and a line's target field names what the params name.
class MeasureMcpPropertiesTest < Minitest::Test
  include Hegel::Syntax::Methods

  M = Nukadoko::Engine::McpCalls

  def check(&) = Hegel.test(test_cases: 200, verbosity: :quiet, &)

  def draw_message(tc, strings)
    key = strings ? ->(name) { name } : ->(name) { name.to_sym }
    method = tc.draw(sampled_from(M::TARGETS.keys + %w[notes/list ping]))
    params = case tc.draw(integers(min_value: 0, max_value: 3))
             when 0 then nil
             when 1 then [1, "two"]
             else
               { key.("name") => tc.draw(text(alphabet: "abc_", min_size: 1, max_size: 6)),
                 key.("uri") => "notes://#{tc.draw(integers(min_value: 1, max_value: 9))}" }
             end
    { key.("jsonrpc") => "2.0", key.("id") => tc.draw(integers(min_value: 1, max_value: 99)), key.("method") => method,
      **(params.nil? ? {} : { key.("params") => params }) }
  end

  def test_a_stamped_message_reads_back_its_traceparent_and_keeps_its_params
    check do |tc|
      message = draw_message(tc, tc.draw(sampled_from([true, false])))
      traceparent = "00-#{"a" * 32}-#{"b" * 16}-01"
      stamped = M.stamp(message, traceparent)
      params = M.member(message, "params")
      if params.is_a?(Array)
        assert_same message, stamped
      else
        assert_equal traceparent, M.traceparent_in(stamped)
        assert_equal (params || {}).keys.map(&:to_s) | ["_meta"], M.member(stamped, "params").keys.map(&:to_s)
        assert_equal message.except("params", :params), stamped.except("params", :params)
        assert_equal M.stamp(stamped, "00-#{"c" * 32}-#{"d" * 16}-01"), stamped
      end
    end
  end

  def test_a_line_names_the_target_its_params_name
    check do |tc|
      message = draw_message(tc, tc.draw(sampled_from([true, false])))
      line = M.line({ message: message, sent_to: [] }, answer: { "jsonrpc" => "2.0", "id" => 1, "result" => {} }, duration_ms: 1)
      field, param = M::TARGETS[M.member(message, "method")]
      params = M.member(message, "params")
      if field && params.is_a?(Hash)
        assert_equal M.member(params, param), line[field]
      else
        assert_empty line.slice(:tool, :prompt, :uri)
      end
      assert_equal JSON.generate(params), line[:params][:text] unless params.nil?
    end
  end
end
