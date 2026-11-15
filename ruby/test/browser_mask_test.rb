# frozen_string_literal: true

require "nukadoko"
require "digest"
require "tmpdir"

# A screenshot nukadoko takes covers each element that shows a loaded
# secret, as text or as a field's value, in the same black box Playwright's
# mask paints. The record's text redaction cannot reach pixels. Skipped
# when no Chromium starts.
class BrowserMaskTest < Minitest::Test
  PAGE = <<~HTML
    <body style="margin:0;background:#fff">
    <p id="text" style="margin:10px;display:inline-block;font:16px monospace">token s3cr3t-value</p><br>
    <input id="field" style="margin:10px;width:200px" value="s3cr3t-value">
    <p style="margin:10px">plain</p>
    </body>
  HTML

  # The two elements painted over in black where they stand.
  PAINT = <<~JS
    () => { for (const id of ["text", "field"]) {
      const box = document.getElementById(id).getBoundingClientRect();
      const cover = document.createElement("div");
      Object.assign(cover.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, background: "#000" });
      document.body.appendChild(cover);
    } }
  JS

  # The TypeScript engine's Playwright, whose browser CI installed: `npx
  # playwright` from this directory would fetch the newest one instead.
  DRIVER = File.expand_path("../../typescript/node_modules/.bin/playwright", __dir__)

  def test_a_screenshot_covers_what_shows_a_secret
    driver = ENV.fetch("PLAYWRIGHT_CLI", nil)
    ENV["PLAYWRIGHT_CLI"] ||= DRIVER if File.executable?(DRIVER)
    Dir.mktmpdir do |dir|
      secrets = Nukadoko::Engine::Secrets.new("TOKEN" => "s3cr3t-value")
      launch = ENV["NUKADOKO_CHROMIUM"] ? { executablePath: ENV["NUKADOKO_CHROMIUM"] } : {}
      browser = Nukadoko::Engine::Browser.new("http://localhost:1", launch, secrets: -> { secrets })
      begin
        page, finish = browser.page_for(dir, [])
      rescue StandardError => e
        skip "no Chromium started: #{e.message.lines.first}"
      end
      page.set_content(PAGE)
      assert browser.masked_shot(page, File.join(dir, "masked.png"), Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5)
      plain = page.screenshot
      page.evaluate(PAINT)
      painted = page.screenshot
      masked = File.binread(File.join(dir, "masked.png"))
      refute_equal Digest::SHA256.digest(plain), Digest::SHA256.digest(masked)
      assert_equal Digest::SHA256.digest(painted), Digest::SHA256.digest(masked)
      finish.call
    ensure
      browser&.end_scenario
      browser&.close
    end
  ensure
    ENV["PLAYWRIGHT_CLI"] = driver
  end
end
