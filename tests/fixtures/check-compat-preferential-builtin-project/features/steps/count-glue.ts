import { defineParameterType } from "../../nukadoko-compat-shim.js";

// The built-in {int} already prefers /-?\d+/.
defineParameterType({ name: "count", regexp: /-?\d+/, preferForRegexpMatch: true });
