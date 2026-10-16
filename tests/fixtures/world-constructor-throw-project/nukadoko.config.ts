import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: both scenarios stay off the wire. The coverage is the World
// constructor throw, not a browser.
// Both report emitters are off by default; the tests on this project read
// their output.
export default defineConfig({ allure: {}, messages: {} });
